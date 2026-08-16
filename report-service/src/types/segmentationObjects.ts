export type SegmentationObjectStatus = 'draft' | 'superseded' | 'archived';

export interface SegmentationObjectRecord {
  id: string;
  studyInstanceUID: string;
  sourceSeriesInstanceUID: string;
  segmentationSeriesInstanceUID: string;
  segmentationSOPInstanceUID: string;
  name: string;
  description: string | null;
  ontologyVersion: string;
  dimensions: [number, number, number];
  spacing: [number, number, number];
  frameOfReferenceUID: string | null;
  version: number;
  supersedesObjectId: string | null;
  createdBy: string | null;
  status: SegmentationObjectStatus;
  s3Bucket: string | null;
  s3Key: string | null;
  s3VersionId: string | null;
  s3ETag: string | null;
  checksumSha256: string | null;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSegmentationObjectInput {
  studyInstanceUID: string;
  sourceSeriesInstanceUID: string;
  segmentationSeriesInstanceUID: string;
  segmentationSOPInstanceUID: string;
  name: string;
  description?: string | null;
  ontologyVersion: string;
  dimensions: [number, number, number];
  spacing: [number, number, number];
  frameOfReferenceUID?: string | null;
  version?: number;
  supersedesObjectId?: string | null;
  status?: SegmentationObjectStatus;
}

export interface UpdateSegmentationObjectInput {
  name?: string;
  description?: string | null;
  status?: SegmentationObjectStatus;
}
