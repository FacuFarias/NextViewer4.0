import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { DicomSeries, DicomInstance } from '../types/dicom';
import { dicomWebService } from './dicomWeb';
import { DICOM_PASSWORD, DICOM_USERNAME, getAccessToken } from './auth';

export async function downloadSeriesAsZip(
  studyInstanceUID: string,
  series: DicomSeries,
  onProgress?: (current: number, total: number) => void
): Promise<void> {
  const zip = new JSZip();
  const folder = zip.folder(`series_${series.seriesNumber || 1}`);
  
  if (!folder) {
    throw new Error('Failed to create ZIP folder');
  }

  const instances = series.instances;
  const total = instances.length;

  for (let i = 0; i < total; i++) {
    const instance = instances[i];
    
    try {
      const token = await getAccessToken(DICOM_USERNAME, DICOM_PASSWORD);
      const wadoUrl = dicomWebService.getInstanceWadoUriUrl(
        studyInstanceUID,
        series.seriesInstanceUID,
        instance.sopInstanceUID
      );

      const response = await fetch(wadoUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        console.error(`Failed to download instance ${instance.sopInstanceUID}: ${response.status}`);
        continue;
      }

      const blob = await response.blob();
      const fileName = `${instance.sopInstanceUID}.dcm`;
      folder.file(fileName, blob);

      if (onProgress) {
        onProgress(i + 1, total);
      }
    } catch (error) {
      console.error(`Error downloading instance ${instance.sopInstanceUID}:`, error);
    }
  }

  const content = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: {
      level: 6,
    },
  });

  const seriesName = series.seriesDescription || `Serie_${series.seriesNumber || 1}`;
  const safeName = seriesName.replace(/[^a-zA-Z0-9_-]/g, '_');
  saveAs(content, `${safeName}.zip`);
}

export async function downloadInstance(
  studyInstanceUID: string,
  seriesInstanceUID: string,
  instance: DicomInstance
): Promise<void> {
  const token = await getAccessToken(DICOM_USERNAME, DICOM_PASSWORD);
  const wadoUrl = dicomWebService.getInstanceWadoUriUrl(
    studyInstanceUID,
    seriesInstanceUID,
    instance.sopInstanceUID
  );

  const response = await fetch(wadoUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download instance: ${response.status}`);
  }

  const blob = await response.blob();
  saveAs(blob, `${instance.sopInstanceUID}.dcm`);
}
