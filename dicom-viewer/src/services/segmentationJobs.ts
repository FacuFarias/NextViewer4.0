import { getAccessToken, getCurrentToken } from './auth';
import type {
  EnqueueSegmentationItem,
  SegmentationJob,
  StudySegmentationStatus,
} from '../types/segmentationJobs';

const API_ROOT = '/report-api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getCurrentToken() || await getAccessToken();
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_ROOT}${path}`, { ...options, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `Segmentation jobs API error: ${response.status}`);
  return body as T;
}

export const segmentationJobService = {
  async statuses(studyInstanceUIDs: string[]): Promise<StudySegmentationStatus[]> {
    if (!studyInstanceUIDs.length) return [];
    const result = await request<{ items: StudySegmentationStatus[] }>('/segmentation-status/query', {
      method: 'POST', body: JSON.stringify({ studyInstanceUIDs }),
    });
    return result.items;
  },

  async enqueue(input: {
    items: EnqueueSegmentationItem[];
    modelName: string;
    modelVersion: string;
    idempotencyKey: string;
  }): Promise<SegmentationJob[]> {
    const result = await request<{ items: SegmentationJob[] }>('/segmentation-jobs', {
      method: 'POST', body: JSON.stringify(input),
    });
    return result.items;
  },

  get(id: string): Promise<SegmentationJob> {
    return request<SegmentationJob>(`/segmentation-jobs/${encodeURIComponent(id)}`);
  },
};
