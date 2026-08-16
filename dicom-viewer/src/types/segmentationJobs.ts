export type StudySegmentationState =
  | 'without_seg' | 'queued' | 'processing' | 'with_seg' | 'failed';

export interface StudySegmentationStatus {
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

export interface EnqueueSegmentationItem {
  studyInstanceUID: string;
  sourceSeriesInstanceUID: string;
  priority?: number;
}

export interface SegmentationJob {
  id: string;
  studyInstanceUID: string;
  sourceSeriesInstanceUID: string;
  modelName: string;
  modelVersion: string;
  status: string;
  progress: number;
  stage: string | null;
  lastErrorMessage: string | null;
}
