export type SegmentationJobStatus =
  | 'queued' | 'leased' | 'processing' | 'uploading'
  | 'publishing' | 'completed' | 'failed' | 'cancelled';

export type StudySegmentationState =
  | 'without_seg' | 'queued' | 'processing' | 'with_seg' | 'failed';

export interface ManifestObject {
  sopInstanceUID: string;
  key: string;
  versionId?: string;
  etag?: string;
  size?: number;
  instanceNumber?: number;
  imagePositionPatient?: number[];
}

export interface SegmentationInputManifest {
  bucket: string;
  studyInstanceUID: string;
  seriesInstanceUID: string;
  createdAt: string;
  objects: ManifestObject[];
}

export interface SegmentationJobRecord {
  id: string;
  studyInstanceUID: string;
  sourceSeriesInstanceUID: string;
  modelName: string;
  modelVersion: string;
  inputManifest: SegmentationInputManifest;
  status: SegmentationJobStatus;
  priority: number;
  progress: number;
  stage: string | null;
  attemptCount: number;
  maxAttempts: number;
  requestedBy: string | null;
  outputBucket: string | null;
  outputKey: string | null;
  segmentationObjectId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface StudySegmentationStatusRecord {
  studyInstanceUID: string;
  hasSeg: boolean;
  segmentationCount: number;
  state: StudySegmentationState;
  activeJobId: string | null;
  latestSegmentationObjectId: string | null;
  updatedAt: string | null;
  lastError?: string;
  progress?: number;
  stage?: string;
}

export interface CompleteSegmentationJobInput {
  bucket: string;
  key: string;
  versionId?: string;
  etag?: string;
  checksumSha256: string;
  sizeBytes: number;
  segmentationSeriesInstanceUID: string;
  segmentationSOPInstanceUID: string;
  frameOfReferenceUID?: string | null;
  dimensions: [number, number, number];
  spacing: [number, number, number];
  ontologyVersion: string;
  name: string;
  description?: string | null;
  weightsHash?: string | null;
  parameters?: Record<string, unknown>;
}
