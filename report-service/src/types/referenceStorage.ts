export type ReferenceScanStatus = 'pending' | 'scanning' | 'ready' | 'error';
export type ReferenceImportStatus = 'queued' | 'importing' | 'completed' | 'failed' | 'cancelled';

export interface ReferenceSegmentationSummary {
  id: string;
  origin: 'HUMAN' | 'AI' | 'IMPORTED';
  name: string;
  status: string;
  version: number;
  segmentSummary: Array<{ number?: number; label: string; description?: string }>;
  createdAt: string;
}

export interface ReferenceMeasurementSummary {
  labelCode: string;
  labelName: string;
  toolName: string;
  geometryType: string;
  source: string;
  count: number;
}

export interface ReferenceImportJob {
  id: string;
  referenceStudyId: string;
  status: ReferenceImportStatus;
  requestedBy: string | null;
  totalInstances: number;
  importedInstances: number;
  failedInstances: number;
  progress: number;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface ReferenceStudy {
  id: string;
  accessionNumber: string;
  studyInstanceUID: string | null;
  representativeSeriesInstanceUID: string | null;
  representativeSOPInstanceUID: string | null;
  modality: string | null;
  studyDate: string | null;
  studyDescription: string | null;
  patientId: string | null;
  patientName: string | null;
  sourceBucket: string;
  sourcePrefix: string;
  objectCount: number;
  totalSizeBytes: number;
  scanStatus: ReferenceScanStatus;
  scanError: string | null;
  lastScannedAt: string | null;
  pacsVerifiedAt: string | null;
  pacsPresent: boolean;
  hasSeg: boolean;
  segmentationCount: number;
  segmentationOrigins: string[];
  segmentations: ReferenceSegmentationSummary[];
  measurements: ReferenceMeasurementSummary[];
  latestImport: ReferenceImportJob | null;
  createdAt: string;
  updatedAt: string;
}
