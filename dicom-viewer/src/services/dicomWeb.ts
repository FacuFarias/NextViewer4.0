import type { DicomInstance, DicomSeries, DicomStudy, DicomWebConfig } from '../types/dicom';
import type { ViewerRequest } from './viewerRequest';
import { getDicomRequestHeaders } from './auth';
import { getRuntimeConfig } from './runtimeConfig';
import { isSupportedVisualInstance } from './viewerModality';
import { resolveDicomWebConfig } from './dicomSource';

function value(item: Record<string, any>, tag: string): any {
  return item[tag]?.Value?.[0];
}

function numberValues(item: Record<string, any>, tag: string): number[] | undefined {
  const values = item[tag]?.Value;
  return Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : undefined;
}

function personName(raw: any): string {
  if (typeof raw === 'string') return raw;
  return raw?.Alphabetic || '';
}

function parseModalities(item: Record<string, any>): string {
  const values = item['00080061']?.Value || item['00080060']?.Value || [];
  return [...new Set(values.map((entry: any) => String(entry).trim()).filter(Boolean))].join(', ');
}

export function parseDicomInstanceMetadata(item: Record<string, any>): Partial<DicomInstance> {
  return {
    sopInstanceUID: value(item, '00080018') || undefined,
    sopClassUID: value(item, '00080016') || undefined,
    instanceNumber: Number(value(item, '00200013')) || undefined,
    numberOfFrames: Math.max(1, Number(value(item, '00280008')) || 1),
    rows: Number(value(item, '00280010')) || undefined,
    columns: Number(value(item, '00280011')) || undefined,
    bitsAllocated: Number(value(item, '00280100')) || undefined,
    bitsStored: Number(value(item, '00280101')) || undefined,
    highBit: Number(value(item, '00280102')) || undefined,
    pixelRepresentation: Number(value(item, '00280103')) || undefined,
    windowCenter: Number(value(item, '00281050')) || undefined,
    windowWidth: Number(value(item, '00281051')) || undefined,
    rescaleIntercept: Number(value(item, '00281052')) || undefined,
    rescaleSlope: Number(value(item, '00281053')) || undefined,
    pixelSpacing: numberValues(item, '00280030'),
    imagePositionPatient: numberValues(item, '00200032'),
    imageOrientationPatient: numberValues(item, '00200037'),
    frameOfReferenceUID: value(item, '00200052') || undefined,
    modality: value(item, '00080060') || undefined,
    seriesNumber: Number(value(item, '00200011')) || undefined,
    photometricInterpretation: value(item, '00280004') || undefined,
    samplesPerPixel: Number(value(item, '00280002')) || undefined,
    transferSyntaxUID: value(item, '00020010') || undefined,
    bodyPartExamined: value(item, '00180015') || undefined,
    laterality: value(item, '00200060') || undefined,
    imageLaterality: value(item, '00200062') || undefined,
    viewPosition: value(item, '00185101') || undefined,
  };
}

export function mergeDefinedDicomMetadata(
  instance: DicomInstance,
  metadata: Partial<DicomInstance> | undefined
): DicomInstance {
  if (!metadata) return instance;
  const defined = Object.fromEntries(
    Object.entries(metadata).filter(([, entry]) => entry !== undefined && entry !== null)
  );
  return { ...instance, ...defined };
}

export default class DicomWebService {
  private config: DicomWebConfig;

  constructor(config?: DicomWebConfig) {
    const runtime = getRuntimeConfig();
    this.config = config || {
      baseUrl: runtime.dicomWebRoot,
      wadoUrl: runtime.wadoUriRoot,
    };
  }

  configureForViewerRequest(request: ViewerRequest): void {
    this.config = resolveDicomWebConfig(getRuntimeConfig(), request);
  }

  async getRequestHeaders(accept: string): Promise<Record<string, string>> {
    return getDicomRequestHeaders(accept);
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: await this.getRequestHeaders('application/dicom+json'),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`DICOMweb respondió ${response.status} ${response.statusText}`);
    return response.json();
  }

  private async fetchDicom(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url, {
      headers: await this.getRequestHeaders('application/dicom'),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`DICOMweb respondió ${response.status} ${response.statusText}`);
    return response.arrayBuffer();
  }

  async searchStudies(queryParams: Record<string, string> = {}): Promise<DicomStudy[]> {
    const params = new URLSearchParams(queryParams);
    for (const tag of ['00080061', '00080060', '00100030', '00100040', '00080030', '00080050']) {
      params.append('includefield', tag);
    }
    const data = await this.fetchJson<Record<string, any>[]>(`${this.config.baseUrl}/studies?${params}`);
    return data.map(item => ({
      studyInstanceUID: value(item, '0020000D') || '',
      patientName: personName(value(item, '00100010')),
      patientID: value(item, '00100020') || '',
      patientBirthDate: value(item, '00100030') || undefined,
      patientSex: value(item, '00100040') || undefined,
      studyDate: value(item, '00080020') || '',
      studyTime: value(item, '00080030') || undefined,
      studyDescription: value(item, '00081030') || '',
      accessionNumber: value(item, '00080050') || undefined,
      modality: parseModalities(item),
      numberOfSeries: Number(value(item, '00201206')) || undefined,
      numberOfInstances: Number(value(item, '00201208')) || undefined,
      series: [],
    }));
  }

  async getStudyByUID(studyInstanceUID: string): Promise<DicomStudy | null> {
    const studies = await this.searchStudies({ StudyInstanceUID: studyInstanceUID, limit: '1' });
    return studies.find(study => study.studyInstanceUID === studyInstanceUID) || null;
  }

  async getStudySeries(studyInstanceUID: string): Promise<DicomSeries[]> {
    const params = new URLSearchParams();
    for (const tag of [
      '00080060', '0008103E', '00180015', '00185101', '00200011', '00200060',
      '00200062', '00201209',
    ]) params.append('includefield', tag);
    const data = await this.fetchJson<Record<string, any>[]>(
      `${this.config.baseUrl}/studies/${encodeURIComponent(studyInstanceUID)}/series?${params}`
    );
    return data.map(item => ({
      studyInstanceUID,
      seriesInstanceUID: value(item, '0020000E') || '',
      seriesNumber: Number(value(item, '00200011')) || 0,
      seriesDescription: value(item, '0008103E') || '',
      modality: value(item, '00080060') || '',
      numberOfInstances: Number(value(item, '00201209')) || 0,
      bodyPartExamined: value(item, '00180015') || undefined,
      laterality: value(item, '00200060') || undefined,
      imageLaterality: value(item, '00200062') || undefined,
      viewPosition: value(item, '00185101') || undefined,
      instances: [],
    }));
  }

  async getSeriesInstances(studyInstanceUID: string, seriesInstanceUID: string): Promise<DicomInstance[]> {
    const params = new URLSearchParams();
    for (const tag of [
      '00080016', '00080060', '00200011', '00200013', '00200032', '00200037',
      '00200052', '00280002', '00280004', '00280008', '00280010', '00280011',
      '00280030', '00280100', '00280101', '00280102', '00280103', '00281050',
      '00281051', '00281052', '00281053',
      '00180015', '00185101', '00200060', '00200062',
    ]) params.append('includefield', tag);

    const data = await this.fetchJson<Record<string, any>[]>(
      `${this.config.baseUrl}/studies/${encodeURIComponent(studyInstanceUID)}` +
      `/series/${encodeURIComponent(seriesInstanceUID)}/instances?${params}`
    );
    return data.map(item => ({
      sopInstanceUID: value(item, '00080018') || '',
      instanceNumber: Number(value(item, '00200013')) || 0,
      rows: Number(value(item, '00280010')) || 0,
      columns: Number(value(item, '00280011')) || 0,
      bitsAllocated: Number(value(item, '00280100')) || 0,
      photometricInterpretation: value(item, '00280004') || '',
      ...parseDicomInstanceMetadata(item),
    }));
  }

  async getInstanceMetadata(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string
  ): Promise<Partial<DicomInstance>> {
    const url = `${this.config.baseUrl}/studies/${encodeURIComponent(studyInstanceUID)}` +
      `/series/${encodeURIComponent(seriesInstanceUID)}` +
      `/instances/${encodeURIComponent(sopInstanceUID)}/metadata`;
    const data = await this.fetchJson<Record<string, any>[]>(url);
    return parseDicomInstanceMetadata(Array.isArray(data) ? data[0] : data);
  }

  async getSeriesMetadata(studyInstanceUID: string, seriesInstanceUID: string): Promise<Partial<DicomInstance>[]> {
    const url = `${this.config.baseUrl}/studies/${encodeURIComponent(studyInstanceUID)}` +
      `/series/${encodeURIComponent(seriesInstanceUID)}/metadata`;
    const data = await this.fetchJson<Record<string, any>[]>(url);
    return (Array.isArray(data) ? data : [data]).filter(Boolean).map(parseDicomInstanceMetadata);
  }

  getInstanceImageUrl(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string,
    frame = 1
  ): string {
    return `${this.config.baseUrl}/studies/${encodeURIComponent(studyInstanceUID)}` +
      `/series/${encodeURIComponent(seriesInstanceUID)}` +
      `/instances/${encodeURIComponent(sopInstanceUID)}/frames/${frame}`;
  }

  getInstanceWadoUriUrl(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string
  ): string {
    const params = new URLSearchParams({
      requestType: 'WADO',
      studyUID: studyInstanceUID,
      seriesUID: seriesInstanceUID,
      objectUID: sopInstanceUID,
      contentType: 'application/dicom',
    });
    return `${this.config.wadoUrl}?${params}`;
  }

  async getSeriesThumbnailUrl(studyInstanceUID: string, seriesInstanceUID: string): Promise<string | null> {
    try {
      const instances = (await this.getSeriesInstances(studyInstanceUID, seriesInstanceUID))
        .filter(isSupportedVisualInstance);
      if (!instances.length) return null;
      const instance = instances[Math.floor(instances.length / 2)];
      const params = new URLSearchParams({
        requestType: 'WADO',
        studyUID: studyInstanceUID,
        seriesUID: seriesInstanceUID,
        objectUID: instance.sopInstanceUID,
        contentType: 'image/jpeg',
        imageQuality: '50',
        rows: '128',
        columns: '128',
      });
      const response = await fetch(`${this.config.wadoUrl}?${params}`, {
        headers: await this.getRequestHeaders('image/jpeg'),
        cache: 'no-store',
      });
      if (!response.ok) return null;
      return URL.createObjectURL(await response.blob());
    } catch {
      return null;
    }
  }

  async getInstancePixelData(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string,
    frame = 1
  ): Promise<ArrayBuffer> {
    return this.fetchDicom(this.getInstanceImageUrl(
      studyInstanceUID,
      seriesInstanceUID,
      sopInstanceUID,
      frame
    ));
  }
}

export const dicomWebService = new DicomWebService();
