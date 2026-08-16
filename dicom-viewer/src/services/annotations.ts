import { getAccessToken, getCurrentToken } from './auth';
import {
  AnnotationSet,
  CreateAnnotationPayload,
  PersistedAnnotation,
  UpdateAnnotationPayload,
} from '../types/annotations';

const API_ROOT = '/report-api';

export class AnnotationApiError extends Error {
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
    throw new AnnotationApiError(response.status, body?.error || `Annotation API error: ${response.status}`);
  }
  return body as T;
}

export const annotationService = {
  createAnnotationSet(input: {
    studyInstanceUID: string;
    name: string;
    description?: string | null;
    ontologyVersion: string;
    status?: AnnotationSet['status'];
    isDefault?: boolean;
  }): Promise<AnnotationSet> {
    return request<AnnotationSet>('/annotation-sets', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  getAnnotationSet(id: string): Promise<AnnotationSet> {
    return request<AnnotationSet>(`/annotation-sets/${encodeURIComponent(id)}`);
  },

  listAnnotationSets(studyInstanceUID: string): Promise<AnnotationSet[]> {
    return request<AnnotationSet[]>(`/studies/${encodeURIComponent(studyInstanceUID)}/annotation-sets`);
  },

  createAnnotation(input: CreateAnnotationPayload): Promise<PersistedAnnotation> {
    return request<PersistedAnnotation>('/annotations', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  createAnnotationsBulk(inputs: CreateAnnotationPayload[], clientMutationId: string): Promise<PersistedAnnotation[]> {
    return request<{ items: PersistedAnnotation[] }>('/annotations/bulk', {
      method: 'POST',
      body: JSON.stringify({ annotations: inputs, clientMutationId }),
    }).then(result => result.items);
  },

  listAnnotations(filters: Record<string, string | number | boolean | undefined>): Promise<{ items: PersistedAnnotation[]; total: number }> {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined) params.set(key, String(value));
    });
    return request<{ items: PersistedAnnotation[]; total: number }>(`/annotations?${params.toString()}`);
  },

  updateAnnotation(id: string, input: UpdateAnnotationPayload): Promise<PersistedAnnotation> {
    return request<PersistedAnnotation>(`/annotations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  deleteAnnotation(id: string, expectedVersion?: number): Promise<PersistedAnnotation> {
    return request<PersistedAnnotation>(`/annotations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  },

  getAnnotationHistory(id: string): Promise<PersistedAnnotation[]> {
    return request<PersistedAnnotation[]>(`/annotations/${encodeURIComponent(id)}/history`);
  },
};
