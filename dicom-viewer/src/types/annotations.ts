export type AnnotationSource = 'HUMAN' | 'AI' | 'AI_CORRECTED';
export type AnnotationStatus = 'draft' | 'reviewed' | 'approved' | 'rejected' | 'archived';

export interface NasalSeptumDeviationMeasurement {
  measurement: 'nasal_septum_deviation';
  axis_start: { x: number; y: number };
  axis_end: { x: number; y: number };
  deviation_point: { x: number; y: number };
  projection_point: { x: number; y: number };
  axis_length_mm: number;
  deviation_length_mm: number;
  pixel_spacing: [number, number];
}

export interface AnnotationGeometry {
  coordinateSystem: 'IMAGE_PIXEL';
  imageWidth: number;
  imageHeight: number;
  points: Array<{ x: number; y: number }>;
  patientPoints?: Array<{ x: number; y: number; z: number }>;
  shape?: Record<string, unknown> & Partial<NasalSeptumDeviationMeasurement>;
}

export interface AnnotationImageMetadata {
  modality?: string;
  rows?: number;
  columns?: number;
  pixelSpacing?: number[];
  imagePositionPatient?: number[];
  imageOrientationPatient?: number[];
  frameOfReferenceUID?: string;
  seriesNumber?: number;
}

export interface AnnotationSet {
  id: string;
  studyInstanceUID: string;
  name: string;
  description: string | null;
  ontologyVersion: string;
  status: 'draft' | 'in_review' | 'approved' | 'rejected' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface PersistedAnnotation {
  id: string;
  annotationSetId: string;
  studyInstanceUID: string;
  seriesInstanceUID: string;
  sopInstanceUID: string;
  frameNumber: number | null;
  instanceNumber: number | null;
  labelCode: string;
  labelName: string;
  toolName: string;
  color: string | null;
  geometryType: string;
  geometry: AnnotationGeometry;
  source: AnnotationSource;
  status: AnnotationStatus;
  modelRunId: string | null;
  confidence: number | null;
  version: number;
  supersedesAnnotationId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  cornerstoneAnnotationUID: string | null;
  imageMetadata: AnnotationImageMetadata;
}

export interface AnnotationSaveState {
  status: 'saving' | 'saved' | 'error';
  error?: string;
}

export interface CreateAnnotationPayload {
  annotationSetId: string;
  studyInstanceUID: string;
  seriesInstanceUID: string;
  sopInstanceUID: string;
  frameNumber?: number | null;
  instanceNumber?: number | null;
  labelCode: string;
  labelName: string;
  toolName: string;
  color?: string | null;
  geometryType: string;
  geometry: AnnotationGeometry;
  source?: AnnotationSource;
  status?: AnnotationStatus;
  cornerstoneAnnotationUID?: string | null;
  imageMetadata?: AnnotationImageMetadata;
  clientMutationId?: string;
}

export interface UpdateAnnotationPayload {
  labelCode?: string;
  labelName?: string;
  toolName?: string;
  color?: string | null;
  geometryType?: string;
  geometry?: AnnotationGeometry;
  status?: AnnotationStatus;
  expectedVersion: number;
  cornerstoneAnnotationUID?: string | null;
}
