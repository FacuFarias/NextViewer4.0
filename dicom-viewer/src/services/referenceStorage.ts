import { getAccessToken } from './auth';
import type { ReferenceImportJob, ReferenceStudy } from '../types/referenceStorage';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/report-api${path}`, { ...options, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `Reference storage API error: ${response.status}`);
  return body as T;
}

export const referenceStorageService = {
  list(input: { search?: string; seg?: 'all' | 'with' | 'without'; limit?: number; offset?: number }) {
    const params = new URLSearchParams({
      limit: String(input.limit || 50), offset: String(input.offset || 0), seg: input.seg || 'all',
    });
    if (input.search) params.set('search', input.search);
    return request<{ items: ReferenceStudy[]; total: number }>(`/reference-studies?${params}`);
  },
  pull(id: string) {
    return request<ReferenceImportJob>(`/reference-studies/${encodeURIComponent(id)}/pull`, { method: 'POST' });
  },
  pullBatch(referenceStudyIds: string[]) {
    return request<{ items: ReferenceImportJob[] }>('/reference-studies/pull-batch', {
      method: 'POST', body: JSON.stringify({ referenceStudyIds }),
    });
  },
};
