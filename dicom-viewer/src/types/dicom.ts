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
  /** Study that owns the series. Required when a patient prior is displayed. */
  studyInstanceUID?: string;
  seriesInstanceUID: string;
  seriesNumber: number;
  seriesDescription: string;
  modality: string;
  numberOfInstances?: number;
  bodyPartExamined?: string;
  laterality?: string;
  imageLaterality?: string;
  viewPosition?: string;
  instances: DicomInstance[];
}

export interface DicomInstance {
  sopInstanceUID: string;
  sopClassUID?: string;
  instanceNumber: number;
  numberOfFrames?: number;
  frameNumber?: number;
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
  transferSyntaxUID?: string;
  bodyPartExamined?: string;
  laterality?: string;
  imageLaterality?: string;
  viewPosition?: string;
}

export interface DicomWebConfig {
  baseUrl: string;
  wadoUrl: string;
}

export interface WindowLevel {
  windowWidth: number;
  windowCenter: number;
}

export type ViewMode = 'studies' | 'viewer';
export type ViewerLayoutMode =
  | '1x1' | '1x2' | '1x3'
  | '2x1' | '2x2' | '2x3'
  | '3x1' | '3x2' | '3x3'
  | 'mpr';

export interface ClinicalViewportState {
  id: string;
  slot: number;
  label?: string;
  series: DicomSeries | null;
  instance: DicomInstance | null;
  imageIndex: number;
  windowLevel: WindowLevel;
  isLoaded: boolean;
  error?: string;
}

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
  activeViewportId: string;
  viewports: ClinicalViewportState[];
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
