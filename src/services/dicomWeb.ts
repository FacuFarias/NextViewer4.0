import { DicomStudy, DicomSeries, DicomInstance, DicomWebConfig } from '../types/dicom';
import { getAccessToken } from './auth';

const DEFAULT_CONFIG: DicomWebConfig = {
  baseUrl: '/dcm4chee-arc/aets/DCM4CHEE/rs',
  wadoUrl: '/dcm4chee-arc/aets/DCM4CHEE/wado',
  username: 'admin',
  password: 'Sih.123',
};

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
    console.log('Headers:', headers);
    
    const response = await fetch(url, { headers });

    console.log('Response status:', response.status);
    
    if (!response.ok) {
      console.error('Request failed:', response.status, response.statusText);
      throw new Error(`DICOMweb error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  private async fetchDicom(url: string): Promise<ArrayBuffer> {
    const headers: Record<string, string> = {
      'Accept': 'application/dicom',
    };

    if (this.config.username && this.config.password) {
      try {
        const token = await getAccessToken(this.config.username, this.config.password);
        headers['Authorization'] = `Bearer ${token}`;
      } catch (error) {
        const auth = btoa(`${this.config.username}:${this.config.password}`);
        headers['Authorization'] = `Basic ${auth}`;
      }
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`DICOMweb error: ${response.status} ${response.statusText}`);
    }

    return response.arrayBuffer();
  }

  async searchStudies(queryParams: Record<string, string> = {}): Promise<DicomStudy[]> {
    const params = new URLSearchParams(queryParams);
    const url = `${this.config.baseUrl}/studies?${params.toString()}`;
    
    const data = await this.fetchJson<any[]>(url);
    
    return data.map((item: any) => ({
      studyInstanceUID: item['0020000D']?.Value?.[0] || '',
      patientName: item['00100010']?.Value?.[0]?.Alphabetic || item['00100010']?.Value?.[0] || '',
      patientID: item['00100020']?.Value?.[0] || '',
      studyDate: item['00080020']?.Value?.[0] || '',
      studyDescription: item['00081030']?.Value?.[0] || '',
      modality: item['00080060']?.Value?.[0] || '',
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
    const url = `${this.config.baseUrl}/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances`;
    
    const data = await this.fetchJson<any[]>(url);
    
    return data.map((item: any) => ({
      sopInstanceUID: item['00080018']?.Value?.[0] || '',
      instanceNumber: item['00200013']?.Value?.[0] || 0,
      rows: item['00280010']?.Value?.[0] || 0,
      columns: item['00280011']?.Value?.[0] || 0,
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
      
      return {
        sopInstanceUID: item['00080018']?.Value?.[0] || '',
        instanceNumber: item['00200013']?.Value?.[0] || 0,
        rows: item['00280010']?.Value?.[0] || 0,
        columns: item['00280011']?.Value?.[0] || 0,
        bitsAllocated: item['00280100']?.Value?.[0] || 0,
        bitsStored: item['00280101']?.Value?.[0] || 0,
        highBit: item['00280102']?.Value?.[0] || 0,
        pixelRepresentation: item['00280103']?.Value?.[0] || 0,
        windowCenter: item['00281050']?.Value?.[0] || 0,
        windowWidth: item['00281051']?.Value?.[0] || 0,
        rescaleIntercept: item['00281052']?.Value?.[0] || 0,
        rescaleSlope: item['00281053']?.Value?.[0] || 1,
        photometricInterpretation: item['00280004']?.Value?.[0] || '',
        samplesPerPixel: item['00280002']?.Value?.[0] || 1,
      };
    } catch (error) {
      console.error('Failed to fetch instance metadata:', error);
      return {};
    }
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
}

export const dicomWebService = new DicomWebService();
export default DicomWebService;
