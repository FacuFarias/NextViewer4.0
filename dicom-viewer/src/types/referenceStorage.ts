export interface ReferenceImportJob {
  id: string;
  referenceStudyId: string;
  status: 'queued' | 'importing' | 'completed' | 'failed' | 'cancelled';
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
  modality: string | null;
  studyDate: string | null;
  studyDescription: string | null;
  patientId: string | null;
  sourceBucket: string;
  sourcePrefix: string;
  objectCount: number;
  totalSizeBytes: number;
  scanStatus: 'pending' | 'scanning' | 'ready' | 'error';
  scanError: string | null;
  lastScannedAt: string | null;
  pacsVerifiedAt: string | null;
  pacsPresent: boolean;
  hasSeg: boolean;
  segmentationCount: number;
  segmentationOrigins: string[];
  segmentations: Array<{
    id: string; origin: string; name: string; status: string; version: number;
    segmentSummary: Array<{ number?: number; label: string; description?: string }>;
    createdAt: string;
  }>;
  measurements: Array<{
    labelCode: string; labelName: string; toolName: string; geometryType: string;
    source: string; count: number;
  }>;
  latestImport: ReferenceImportJob | null;
  createdAt: string;
  updatedAt: string;
}
