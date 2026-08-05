export interface DicomStudy {
  studyInstanceUID: string;
  patientName: string;
  patientID: string;
  patientBirthDate?: string;
  patientSex?: string;
  studyDate: string;
  studyTime?: string;
  studyDescription: string;
  accessionNumber?: string;
  modality: string;
  numberOfSeries?: number;
  numberOfInstances?: number;
  series: DicomSeries[];
}

export interface DicomSeries {
  seriesInstanceUID: string;
  seriesNumber: number;
  seriesDescription: string;
  modality: string;
  numberOfInstances?: number;
  instances: DicomInstance[];
}

export interface DicomInstance {
  sopInstanceUID: string;
  instanceNumber: number;
  rows: number;
  columns: number;
  bitsAllocated: number;
  bitsStored?: number;
  highBit?: number;
  pixelRepresentation?: number;
  windowCenter?: number;
  windowWidth?: number;
  rescaleIntercept?: number;
  rescaleSlope?: number;
  photometricInterpretation: string;
  samplesPerPixel?: number;
  pixelSpacing?: number[];
  imagePositionPatient?: number[];
  imageOrientationPatient?: number[];
  frameOfReferenceUID?: string;
  modality?: string;
  seriesNumber?: number;
}

export interface DicomWebConfig {
  baseUrl: string;
  wadoUrl?: string;
  username?: string;
  password?: string;
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
}

export interface WindowLevel {
  windowWidth: number;
  windowCenter: number;
}

export type ViewMode = 'studies' | 'viewer';
export type ViewerLayoutMode = 'stack' | 'mpr';

export interface ViewerState {
  viewMode: ViewMode;
  layoutMode: ViewerLayoutMode;
  isLoaded: boolean;
  isLoading: boolean;
  error: string | null;
  currentStudy: DicomStudy | null;
  currentSeries: DicomSeries | null;
  currentInstance: DicomInstance | null;
  windowLevel: WindowLevel;
  imageIndex: number;
}

export interface StudySearchParams {
  patientName?: string;
  patientID?: string;
  studyDate?: string;
  modality?: string;
  studyDescription?: string;
  accessionNumber?: string;
  limit?: number;
  offset?: number;
}
