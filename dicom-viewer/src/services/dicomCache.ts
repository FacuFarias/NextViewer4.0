import { getCacheUserKey } from './auth';

const DICOM_CACHE_PREFIX = 'nextviewer-dicom-v1';

function isCacheStorageAvailable(): boolean {
  return typeof window !== 'undefined' && 'caches' in window;
}

export function getDicomCacheName(): string {
  return getDicomCacheNameForUser(getCacheUserKey());
}

export function getDicomCacheNameForUser(userKey: string): string {
  return `${DICOM_CACHE_PREFIX}-${userKey}`;
}

export async function hasCachedDicom(url: string): Promise<boolean> {
  if (!isCacheStorageAvailable()) return false;

  const cache = await caches.open(getDicomCacheName());
  return Boolean(await cache.match(url));
}

export async function putCachedDicom(url: string, response: Response): Promise<void> {
  if (!isCacheStorageAvailable()) {
    // Consume the response when persistent storage is not available so the
    // request still completes and can be considered downloaded for this run.
    await response.arrayBuffer();
    return;
  }

  const cache = await caches.open(getDicomCacheName());
  await cache.put(url, response.clone());
}

export async function clearPersistentDicomCache(): Promise<void> {
  if (!isCacheStorageAvailable()) return;
  await caches.delete(getDicomCacheName());
}

export async function clearPersistentDicomCacheForUser(userKey: string): Promise<void> {
  if (!isCacheStorageAvailable()) return;
  await caches.delete(getDicomCacheNameForUser(userKey));
}
