export type AnnotationSetStatus = 'draft' | 'in_review' | 'approved' | 'rejected' | 'archived';
export type AnnotationStatus = 'draft' | 'reviewed' | 'approved' | 'rejected' | 'archived';
export type AnnotationSource = 'HUMAN' | 'AI' | 'AI_CORRECTED';

export interface AnnotationSetRecord {
  id: string;
  studyInstanceUID: string;
  name: string;
  description: string | null;
  ontologyVersion: string;
  status: AnnotationSetStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationGeometry {
  coordinateSystem: 'IMAGE_PIXEL';
  imageWidth: number;
  imageHeight: number;
  points: Array<{ x: number; y: number }>;
  patientPoints?: Array<{ x: number; y: number; z: number }>;
  shape?: Record<string, unknown>;
}

export interface AnnotationRecord {
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
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  cornerstoneAnnotationUID: string | null;
  imageMetadata: {
    modality?: string;
    rows?: number;
    columns?: number;
    pixelSpacing?: number[];
    imagePositionPatient?: number[];
    imageOrientationPatient?: number[];
    frameOfReferenceUID?: string;
    seriesNumber?: number;
  };
}

export interface CreateAnnotationSetInput {
  studyInstanceUID: string;
  name: string;
  description?: string | null;
  ontologyVersion: string;
  status?: AnnotationSetStatus;
  isDefault?: boolean;
}

export interface UpdateAnnotationSetInput {
  name?: string;
  description?: string | null;
  status?: AnnotationSetStatus;
}

export interface CreateAnnotationInput {
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
  modelRunId?: string | null;
  confidence?: number | null;
  expectedVersion?: number;
  cornerstoneAnnotationUID?: string | null;
  imageMetadata?: AnnotationRecord['imageMetadata'];
  clientMutationId?: string;
}

export interface UpdateAnnotationInput {
  labelCode?: string;
  labelName?: string;
  toolName?: string;
  color?: string | null;
  geometryType?: string;
  geometry?: AnnotationGeometry;
  status?: AnnotationStatus;
  confidence?: number | null;
  expectedVersion: number;
  cornerstoneAnnotationUID?: string | null;
}

export interface AnnotationFilters {
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
  frameNumber?: number;
  annotationSetId?: string;
  labelCode?: string;
  source?: AnnotationSource;
  status?: AnnotationStatus;
  latestOnly?: boolean;
  limit: number;
  offset: number;
}

export interface AuthenticatedUser {
  username: string | null;
  roles: string[];
}
