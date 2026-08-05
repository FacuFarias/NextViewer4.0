import { DicomStudy, DicomSeries, DicomInstance, DicomWebConfig } from '../types/dicom';
import { DICOM_PASSWORD, DICOM_USERNAME, getAccessToken, getCacheUserKey } from './auth';

const DEFAULT_CONFIG: DicomWebConfig = {
  baseUrl: '/dcm4chee-arc/aets/DCM4CHEE/rs',
  wadoUrl: '/dcm4chee-arc/aets/DCM4CHEE/wado',
  username: DICOM_USERNAME,
  password: DICOM_PASSWORD,
};

function parseDicomInstanceMetadata(item: any): Partial<DicomInstance> {
  return {
    sopInstanceUID: item['00080018']?.Value?.[0] || undefined,
    instanceNumber: item['00200013']?.Value?.[0] || undefined,
    rows: item['00280010']?.Value?.[0] || undefined,
    columns: item['00280011']?.Value?.[0] || undefined,
    bitsAllocated: item['00280100']?.Value?.[0] || undefined,
    bitsStored: item['00280101']?.Value?.[0] || undefined,
    highBit: item['00280102']?.Value?.[0] || undefined,
    pixelRepresentation: item['00280103']?.Value?.[0] || undefined,
    windowCenter: item['00281050']?.Value?.[0] || undefined,
    windowWidth: item['00281051']?.Value?.[0] || undefined,
    rescaleIntercept: item['00281052']?.Value?.[0] || undefined,
    rescaleSlope: item['00281053']?.Value?.[0] || undefined,
    pixelSpacing: item['00280030']?.Value?.map(Number),
    imagePositionPatient: item['00200032']?.Value?.map(Number),
    imageOrientationPatient: item['00200037']?.Value?.map(Number),
    frameOfReferenceUID: item['00200052']?.Value?.[0],
    modality: item['00080060']?.Value?.[0],
    seriesNumber: item['00200011']?.Value?.[0] || undefined,
    photometricInterpretation: item['00280004']?.Value?.[0],
    samplesPerPixel: item['00280002']?.Value?.[0] || undefined,
  };
}

function parseDicomStringValues(value: any): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .flatMap(item => {
      if (typeof item === 'string') return [item];
      if (item && typeof item.Alphabetic === 'string') return [item.Alphabetic];
      return [];
    })
    .map(value => value.trim())
    .filter(Boolean);
}

function parseStudyModalities(item: any): string {
  // (0008,0061) is Modalities in Study. (0008,0060) is a series-level
  // fallback used by some PACS/QIDO implementations.
  const values = parseDicomStringValues(
    item['00080061']?.Value || item['00080060']?.Value
  );

  return [...new Set(values)].join(', ');
}

export function mergeDefinedDicomMetadata(
  instance: DicomInstance,
  metadata: Partial<DicomInstance> | undefined
): DicomInstance {
  if (!metadata) return instance;

  const definedMetadata = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined && value !== null)
  );
  return { ...instance, ...definedMetadata };
}

class DicomWebService {
  private config: DicomWebConfig;

  constructor(config: DicomWebConfig = DEFAULT_CONFIG) {
    this.config = config;
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Accept': 'application/dicom+json',
    };

    if (this.config.username && this.config.password) {
      try {
        const token = await getAccessToken(this.config.username, this.config.password);
        headers['Authorization'] = `Bearer ${token}`;
        headers['X-Dicom-Cache-User'] = getCacheUserKey();
      } catch (error) {
        console.error('Failed to get access token:', error);
        // Fallback to basic auth if keycloak fails
        const auth = btoa(`${this.config.username}:${this.config.password}`);
        headers['Authorization'] = `Basic ${auth}`;
      }
    }

    return headers;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const headers = await this.getAuthHeaders();
    console.log('Fetching URL:', url);
    
    const response = await fetch(url, { headers });

    console.log('Response status:', response.status);
    
    if (!response.ok) {
      console.error('Request failed:', response.status, response.statusText);
      throw new Error(`DICOMweb error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  private async getDicomHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Accept': 'application/dicom',
    };

    if (this.config.username && this.config.password) {
      try {
        const token = await getAccessToken(this.config.username, this.config.password);
        headers['Authorization'] = `Bearer ${token}`;
        headers['X-Dicom-Cache-User'] = getCacheUserKey();
      } catch (error) {
        const auth = btoa(`${this.config.username}:${this.config.password}`);
        headers['Authorization'] = `Basic ${auth}`;
      }
    }

    return headers;
  }

  private async fetchDicom(url: string): Promise<ArrayBuffer> {
    const headers = await this.getDicomHeaders();

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`DICOMweb error: ${response.status} ${response.statusText}`);
    }

    return response.arrayBuffer();
  }

  private async getStoreHeaders(): Promise<Record<string, string>> {
    const headers = await this.getDicomHeaders();
    headers.Accept = 'application/dicom+json';
    return headers;
  }

  /**
   * Fetches an image response for the persistent preloader. The response is
   * returned unconsumed so the cache layer can store it without decoding it
   * into Cornerstone's in-memory cache.
   */
  async fetchImageForPreload(url: string, signal?: AbortSignal): Promise<Response> {
    const headers = await this.getDicomHeaders();
    const response = await fetch(url, { headers, signal });

    if (!response.ok) {
      throw new Error(`DICOMweb error: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  async searchStudies(queryParams: Record<string, string> = {}): Promise<DicomStudy[]> {
    const params = new URLSearchParams(queryParams);
    if (!params.has('includefield')) {
      params.append('includefield', '00080061');
      params.append('includefield', '00080060');
    }
    const url = `${this.config.baseUrl}/studies?${params.toString()}`;
    
    const data = await this.fetchJson<any[]>(url);
    
    return data.map((item: any) => ({
      studyInstanceUID: item['0020000D']?.Value?.[0] || '',
      patientName: item['00100010']?.Value?.[0]?.Alphabetic || item['00100010']?.Value?.[0] || '',
      patientID: item['00100020']?.Value?.[0] || '',
      studyDate: item['00080020']?.Value?.[0] || '',
      studyDescription: item['00081030']?.Value?.[0] || '',
      modality: parseStudyModalities(item),
      series: [],
    }));
  }

  async getStudySeries(studyInstanceUID: string): Promise<DicomSeries[]> {
    const url = `${this.config.baseUrl}/studies/${studyInstanceUID}/series`;
    
    const data = await this.fetchJson<any[]>(url);
    
    return data.map((item: any) => ({
      seriesInstanceUID: item['0020000E']?.Value?.[0] || '',
      seriesNumber: item['00200011']?.Value?.[0] || 0,
      seriesDescription: item['0008103E']?.Value?.[0] || '',
      modality: item['00080060']?.Value?.[0] || '',
      numberOfInstances: item['00201209']?.Value?.[0] || 0,
      instances: [],
    }));
  }

  async getSeriesInstances(
    studyInstanceUID: string,
    seriesInstanceUID: string
  ): Promise<DicomInstance[]> {
    // QIDO-RS may omit image-plane attributes unless they are requested
    // explicitly. Cornerstone needs these attributes for volume/MPR
    // reconstruction, so ask for them in the same metadata response instead
    // of trying to reconstruct a volume with incomplete geometry.
    const params = new URLSearchParams();
    [
      '00200013', // Instance Number
      '00200032', // Image Position (Patient)
      '00200037', // Image Orientation (Patient)
      '00200052', // Frame of Reference UID
      '00280010', // Rows
      '00280011', // Columns
      '00280030', // Pixel Spacing
      '00280100', // Bits Allocated
      '00080060', // Modality
    ].forEach(tag => params.append('includefield', tag));
    const url = `${this.config.baseUrl}/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances?${params.toString()}`;
    
    const data = await this.fetchJson<any[]>(url);
    
    return data.map((item: any) => ({
      sopInstanceUID: item['00080018']?.Value?.[0] || '',
      instanceNumber: item['00200013']?.Value?.[0] || 0,
      rows: item['00280010']?.Value?.[0] || 0,
      columns: item['00280011']?.Value?.[0] || 0,
      pixelSpacing: item['00280030']?.Value?.map(Number),
      imagePositionPatient: item['00200032']?.Value?.map(Number),
      imageOrientationPatient: item['00200037']?.Value?.map(Number),
      frameOfReferenceUID: item['00200052']?.Value?.[0],
      modality: item['00080060']?.Value?.[0],
      seriesNumber: item['00200011']?.Value?.[0] || 0,
      bitsAllocated: item['00280100']?.Value?.[0] || 0,
      photometricInterpretation: item['00280004']?.Value?.[0] || '',
    }));
  }

  async getInstanceMetadata(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string
  ): Promise<Partial<DicomInstance>> {
    const url = `${this.config.baseUrl}/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances/${sopInstanceUID}/metadata`;
    
    try {
      const data = await this.fetchJson<any[]>(url);
      const item = Array.isArray(data) ? data[0] : data;
      return parseDicomInstanceMetadata(item);
    } catch (error) {
      console.error('Failed to fetch instance metadata:', error);
      return {};
    }
  }

  async getSeriesMetadata(
    studyInstanceUID: string,
    seriesInstanceUID: string
  ): Promise<Partial<DicomInstance>[]> {
    // WADO-RS metadata returns the image-plane attributes for the complete
    // series in one response. This preserves per-slice ImagePositionPatient
    // without issuing one HTTP request per image.
    const url = `${this.config.baseUrl}/studies/${studyInstanceUID}/series/${seriesInstanceUID}/metadata`;
    const data = await this.fetchJson<any[]>(url);
    const items = Array.isArray(data) ? data : [data];
    return items.filter(Boolean).map(parseDicomInstanceMetadata);
  }

  getInstanceImageUrl(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string,
    frame: number = 1
  ): string {
    return `${this.config.baseUrl}/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances/${sopInstanceUID}/frames/${frame}`;
  }

  getInstanceWadoUriUrl(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string
  ): string {
    return `${this.config.wadoUrl}?requestType=WADO&studyUID=${studyInstanceUID}&seriesUID=${seriesInstanceUID}&objectUID=${sopInstanceUID}&contentType=application/dicom`;
  }

  getInstanceThumbnailUrl(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string
  ): string {
    return `${this.config.wadoUrl}?requestType=WADO&studyUID=${studyInstanceUID}&seriesUID=${seriesInstanceUID}&objectUID=${sopInstanceUID}&contentType=image/jpeg&imageQuality=50&rows=128&columns=128`;
  }

  async getSeriesThumbnailUrl(
    studyInstanceUID: string,
    seriesInstanceUID: string
  ): Promise<string | null> {
    try {
      const instances = await this.getSeriesInstances(studyInstanceUID, seriesInstanceUID);
      if (instances.length === 0) return null;
      
      const middleIndex = Math.floor(instances.length / 2);
      const middleInstance = instances[middleIndex];
      
      const thumbnailUrl = this.getInstanceThumbnailUrl(
        studyInstanceUID,
        seriesInstanceUID,
        middleInstance.sopInstanceUID
      );

      const headers: Record<string, string> = {};
      if (this.config.username && this.config.password) {
        try {
          const token = await getAccessToken(this.config.username, this.config.password);
          headers['Authorization'] = `Bearer ${token}`;
        } catch (error) {
          console.error('Failed to get token for thumbnail:', error);
          return null;
        }
      }

      const response = await fetch(thumbnailUrl, { headers });
      
      if (!response.ok) {
        console.error('Thumbnail fetch failed:', response.status);
        return null;
      }

      const blob = await response.blob();
      return URL.createObjectURL(blob);
    } catch (error) {
      console.error('Failed to get series thumbnail:', error);
      return null;
    }
  }

  async getInstancePixelData(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string,
    frame: number = 1
  ): Promise<ArrayBuffer> {
    const url = this.getInstanceImageUrl(
      studyInstanceUID,
      seriesInstanceUID,
      sopInstanceUID,
      frame
    );
    
    return this.fetchDicom(url);
  }

  async getInstanceDicom(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string
  ): Promise<ArrayBuffer> {
    return this.fetchDicom(this.getInstanceWadoUriUrl(
      studyInstanceUID,
      seriesInstanceUID,
      sopInstanceUID
    ));
  }

  async storeDicomObject(arrayBuffer: ArrayBuffer): Promise<any> {
    const boundary = `nextviewer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const prefix = `--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`;
    const suffix = `\r\n--${boundary}--\r\n`;
    const body = new Blob([prefix, arrayBuffer, suffix], {
      type: `multipart/related; type="application/dicom"; boundary=${boundary}`,
    });
    const headers = await this.getStoreHeaders();
    headers['Content-Type'] = `multipart/related; type="application/dicom"; boundary=${boundary}`;
    const response = await fetch(`${this.config.baseUrl}/studies`, {
      method: 'POST',
      headers,
      body,
    });
    const responseBody = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`DICOMweb STOW-RS error: ${response.status} ${response.statusText}`);
    }
    return responseBody;
  }
}

export const dicomWebService = new DicomWebService();
export default DicomWebService;
