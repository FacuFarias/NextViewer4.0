import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import type { DicomInstance, DicomSeries, DicomStudy } from '../types/dicom';
import { dicomWebService } from './dicomWeb';
import { isSupportedVisualInstance } from './viewerModality';

function uniqueInstances(instances: DicomInstance[]): DicomInstance[] {
  return [...new Map(instances
    .filter(isSupportedVisualInstance)
    .map(instance => [instance.sopInstanceUID, instance])).values()];
}

async function fetchDicom(
  studyInstanceUID: string,
  seriesInstanceUID: string,
  sopInstanceUID: string
): Promise<Blob> {
  const response = await fetch(
    dicomWebService.getInstanceWadoUriUrl(studyInstanceUID, seriesInstanceUID, sopInstanceUID),
    {
      headers: await dicomWebService.getRequestHeaders('application/dicom'),
      cache: 'no-store',
    }
  );
  if (!response.ok) throw new Error(`No se pudo descargar ${sopInstanceUID}: HTTP ${response.status}`);
  return response.blob();
}

export async function downloadSeriesAsZip(
  studyInstanceUID: string,
  series: DicomSeries,
  onProgress?: (current: number, total: number) => void
): Promise<void> {
  const instances = uniqueInstances(series.instances);
  const zip = new JSZip();
  const folder = zip.folder(`serie_${series.seriesNumber || 1}`);
  if (!folder) throw new Error('No se pudo crear el archivo ZIP.');

  for (let index = 0; index < instances.length; index += 1) {
    const instance = instances[index];
    folder.file(
      `${instance.sopInstanceUID}.dcm`,
      await fetchDicom(studyInstanceUID, series.seriesInstanceUID, instance.sopInstanceUID)
    );
    onProgress?.(index + 1, instances.length);
  }
  const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const name = (series.seriesDescription || `Serie_${series.seriesNumber || 1}`)
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  saveAs(content, `${name}.zip`);
}

export async function downloadStudyAsZip(
  study: DicomStudy,
  onProgress?: (current: number, total: number) => void
): Promise<void> {
  const seriesEntries = await Promise.all(study.series.map(async series => ({
    series,
    instances: uniqueInstances(await dicomWebService.getSeriesInstances(
      study.studyInstanceUID,
      series.seriesInstanceUID
    )),
  })));
  const total = seriesEntries.reduce((sum, entry) => sum + entry.instances.length, 0);
  const zip = new JSZip();
  let completed = 0;

  for (const { series, instances } of seriesEntries) {
    const folderName = `Serie_${series.seriesNumber || 1}_${series.seriesDescription || series.modality}`
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    const folder = zip.folder(folderName);
    if (!folder) continue;
    for (const instance of instances) {
      folder.file(
        `${instance.sopInstanceUID}.dcm`,
        await fetchDicom(study.studyInstanceUID, series.seriesInstanceUID, instance.sopInstanceUID)
      );
      completed += 1;
      onProgress?.(completed, total);
    }
  }

  const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const patient = (study.patientName || study.patientID || 'estudio').replace(/[^a-zA-Z0-9_-]/g, '_');
  saveAs(content, `${patient}_${study.studyInstanceUID}.zip`);
}

export async function downloadInstance(
  studyInstanceUID: string,
  seriesInstanceUID: string,
  instance: DicomInstance
): Promise<void> {
  saveAs(
    await fetchDicom(studyInstanceUID, seriesInstanceUID, instance.sopInstanceUID),
    `${instance.sopInstanceUID}.dcm`
  );
}
