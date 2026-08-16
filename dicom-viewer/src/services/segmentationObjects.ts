import { getAccessToken, getCurrentToken } from './auth';
import {
  CreateSegmentationObjectPayload,
  SegmentationObject,
  SegmentationObjectStatus,
} from '../types/segmentationObjects';

const API_ROOT = '/report-api';

export class SegmentationObjectApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getCurrentToken() || await getAccessToken();
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${API_ROOT}${path}`, { ...options, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new SegmentationObjectApiError(
      response.status,
      body?.error || `Segmentation API error: ${response.status}`
    );
  }
  return body as T;
}

export const segmentationObjectService = {
  list(studyInstanceUID: string, sourceSeriesInstanceUID?: string): Promise<SegmentationObject[]> {
    const params = new URLSearchParams({ studyInstanceUID });
    if (sourceSeriesInstanceUID) params.set('sourceSeriesInstanceUID', sourceSeriesInstanceUID);
    return request<SegmentationObject[]>(`/segmentation-objects?${params.toString()}`);
  },

  get(id: string): Promise<SegmentationObject> {
    return request<SegmentationObject>(`/segmentation-objects/${encodeURIComponent(id)}`);
  },

  create(input: CreateSegmentationObjectPayload): Promise<SegmentationObject> {
    return request<SegmentationObject>('/segmentation-objects', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  update(id: string, input: { name?: string; description?: string | null; status?: SegmentationObjectStatus }): Promise<SegmentationObject> {
    return request<SegmentationObject>(`/segmentation-objects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  pushToS3(id: string): Promise<SegmentationObject> {
    return request<SegmentationObject>(`/segmentation-objects/${encodeURIComponent(id)}/push-s3`, {
      method: 'POST',
    });
  },
};
