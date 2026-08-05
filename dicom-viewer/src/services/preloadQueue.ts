import { dicomWebService } from './dicomWeb';
import { DICOM_PASSWORD, DICOM_USERNAME, getAccessToken, getCacheUserKey } from './auth';
import { hasCachedDicom, putCachedDicom } from './dicomCache';

export type StudyPreloadStatus = 'queued' | 'downloading' | 'complete' | 'error';

export interface SeriesPreloadItem {
  status: StudyPreloadStatus;
  completed: number;
  total: number;
  failed: number;
}

export interface PreloadQueueItem {
  studyInstanceUID: string;
  cacheVersion?: number;
  status: StudyPreloadStatus;
  completed: number;
  total: number;
  failed: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
  series?: Record<string, SeriesPreloadItem>;
}

export interface PreloadQueueState {
  items: Record<string, PreloadQueueItem>;
  activeStudyUID: string | null;
  initialized: boolean;
}

type QueueListener = (state: PreloadQueueState) => void;

const DATABASE_PREFIX = 'nextviewer-preload-queue-v1';
const STORE_NAME = 'studies';
const IMAGE_CONCURRENCY = 6;
const CACHE_VERSION = 2;

const state: PreloadQueueState = {
  items: {},
  activeStudyUID: null,
  initialized: false,
};

const listeners = new Set<QueueListener>();
const abortControllers = new Map<string, AbortController>();
let initializationPromise: Promise<void> | null = null;
let database: IDBDatabase | null = null;
let processing = false;
let memoryStore = new Map<string, PreloadQueueItem>();

function snapshot(): PreloadQueueState {
  return {
    items: { ...state.items },
    activeStudyUID: state.activeStudyUID,
    initialized: state.initialized,
  };
}

function emit(): void {
  const current = snapshot();
  listeners.forEach(listener => listener(current));
}

function setItems(items: PreloadQueueItem[]): void {
  state.items = Object.fromEntries(items.map(item => [item.studyInstanceUID, item]));
  emit();
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function openDatabase(userKey: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`${DATABASE_PREFIX}-${userKey}`, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'studyInstanceUID' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open preload database'));
  });
}

async function readPersistedItems(): Promise<PreloadQueueItem[]> {
  if (!database) return Array.from(memoryStore.values());
  const transaction = database.transaction(STORE_NAME, 'readonly');
  return requestToPromise(transaction.objectStore(STORE_NAME).getAll());
}

async function putPersistedItem(item: PreloadQueueItem): Promise<void> {
  memoryStore.set(item.studyInstanceUID, item);
  if (!database) return;
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  await requestToPromise(transaction.objectStore(STORE_NAME).put(item));
}

async function deletePersistedItem(studyInstanceUID: string): Promise<void> {
  memoryStore.delete(studyInstanceUID);
  if (!database) return;
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  await requestToPromise(transaction.objectStore(STORE_NAME).delete(studyInstanceUID));
}

async function clearPersistedItems(): Promise<void> {
  memoryStore.clear();
  if (!database) return;
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  await requestToPromise(transaction.objectStore(STORE_NAME).clear());
}

async function ensureInitialized(): Promise<void> {
  if (state.initialized) return;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    // Resolve the user before selecting the IndexedDB database. This keeps
    // queue metadata isolated even when the application is opened by another
    // authenticated user on the same browser profile.
    await getAccessToken(DICOM_USERNAME, DICOM_PASSWORD).catch(() => null);
    const databaseUserKey = getCacheUserKey();
    memoryStore = new Map<string, PreloadQueueItem>();

    if (typeof indexedDB !== 'undefined') {
      try {
        database = await openDatabase(databaseUserKey);
      } catch (error) {
        console.warn('[Preload] IndexedDB unavailable; using session queue', error);
        database = null;
      }
    }

    const persistedItems = await readPersistedItems();
    const resumedItems = persistedItems.map(item => {
      const needsValidation = item.status === 'complete' &&
        (!item.cacheVersion || !item.series);
      const shouldResume = item.status === 'downloading' || needsValidation;
      return {
        ...item,
        cacheVersion: CACHE_VERSION,
        ...(shouldResume ? { status: 'queued' as const, updatedAt: Date.now() } : {}),
      };
    });
    setItems(resumedItems);
    for (const [index, item] of resumedItems.entries()) {
      memoryStore.set(item.studyInstanceUID, item);
      const persisted = persistedItems[index];
      if (JSON.stringify(item) !== JSON.stringify(persisted)) {
        await putPersistedItem(item);
      }
    }

    state.initialized = true;
    emit();
  })().finally(() => {
    initializationPromise = null;
  });

  return initializationPromise;
}

async function updateItem(
  studyInstanceUID: string,
  changes: Partial<PreloadQueueItem>
): Promise<PreloadQueueItem | null> {
  const current = state.items[studyInstanceUID];
  if (!current) return null;

  const updated: PreloadQueueItem = {
    ...current,
    ...changes,
    updatedAt: Date.now(),
  };
  state.items = { ...state.items, [studyInstanceUID]: updated };
  emit();
  await putPersistedItem(updated);
  return updated;
}

async function removeItem(studyInstanceUID: string): Promise<void> {
  abortControllers.get(studyInstanceUID)?.abort();
  abortControllers.delete(studyInstanceUID);
  const remaining = Object.fromEntries(
    Object.entries(state.items).filter(([uid]) => uid !== studyInstanceUID)
  );
  state.items = remaining;
  if (state.activeStudyUID === studyInstanceUID) state.activeStudyUID = null;
  emit();
  await deletePersistedItem(studyInstanceUID);
}

async function downloadStudy(studyInstanceUID: string, signal: AbortSignal): Promise<void> {
  const seriesList = await dicomWebService.getStudySeries(studyInstanceUID);
  if (signal.aborted) return;

  const imageUrls: Array<{ url: string; seriesInstanceUID: string }> = [];
  for (const series of seriesList) {
    if (signal.aborted) return;
    const instances = await dicomWebService.getSeriesInstances(
      studyInstanceUID,
      series.seriesInstanceUID
    );
    instances
      .sort((a, b) => (a.instanceNumber || 0) - (b.instanceNumber || 0))
      .forEach(instance => {
        imageUrls.push({
          url: dicomWebService.getInstanceWadoUriUrl(
            studyInstanceUID,
            series.seriesInstanceUID,
            instance.sopInstanceUID
          ),
          seriesInstanceUID: series.seriesInstanceUID,
        });
      });
  }

  let completed = 0;
  const pendingUrls: Array<{ url: string; seriesInstanceUID: string }> = [];
  const seriesProgress: Record<string, SeriesPreloadItem> = {};
  for (const group of imageUrls) {
    const progress = seriesProgress[group.seriesInstanceUID] || {
      status: 'downloading' as const,
      completed: 0,
      total: 0,
      failed: 0,
    };
    progress.total += 1;
    if (await hasCachedDicom(group.url)) {
      completed += 1;
      progress.completed += 1;
    } else {
      pendingUrls.push(group);
    }
    seriesProgress[group.seriesInstanceUID] = progress;
  }

  await updateItem(studyInstanceUID, {
    cacheVersion: CACHE_VERSION,
    status: 'downloading',
    total: imageUrls.length,
    completed,
    failed: 0,
    error: undefined,
    series: seriesProgress,
  });

  let nextIndex = 0;
  let failed = 0;

  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const index = nextIndex++;
      if (index >= pendingUrls.length) return;

      const { url, seriesInstanceUID } = pendingUrls[index];
      try {
        const response = await dicomWebService.fetchImageForPreload(url, signal);
        await putCachedDicom(url, response);
        completed += 1;
        const nextSeriesProgress = {
          ...seriesProgress[seriesInstanceUID],
          completed: seriesProgress[seriesInstanceUID].completed + 1,
        };
        seriesProgress[seriesInstanceUID] = nextSeriesProgress;
        await updateItem(studyInstanceUID, {
          completed,
          series: { ...seriesProgress },
        });
      } catch (error) {
        if (signal.aborted) return;
        failed += 1;
        const nextSeriesProgress = {
          ...seriesProgress[seriesInstanceUID],
          failed: seriesProgress[seriesInstanceUID].failed + 1,
          status: 'error' as const,
        };
        seriesProgress[seriesInstanceUID] = nextSeriesProgress;
        await updateItem(studyInstanceUID, {
          failed,
          error: error instanceof Error ? error.message : 'No se pudo descargar una imagen',
          series: { ...seriesProgress },
        });
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(IMAGE_CONCURRENCY, pendingUrls.length) },
      () => worker()
    )
  );

  if (signal.aborted || !state.items[studyInstanceUID]) return;

  const completedSeries = Object.fromEntries(
    Object.entries(seriesProgress).map(([seriesInstanceUID, progress]) => [
      seriesInstanceUID,
      {
        ...progress,
        status: progress.failed > 0 ? 'error' as const : 'complete' as const,
      },
    ])
  );

  await updateItem(studyInstanceUID, {
    cacheVersion: CACHE_VERSION,
    status: failed > 0 ? 'error' : 'complete',
    completed,
    failed,
    error: failed > 0 ? `Fallaron ${failed} imágenes` : undefined,
    series: completedSeries,
  });
}

async function processQueue(): Promise<void> {
  if (processing || !state.initialized) return;
  processing = true;

  try {
    while (true) {
      const next = Object.values(state.items)
        .filter(item => item.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) break;

      const controller = new AbortController();
      abortControllers.set(next.studyInstanceUID, controller);
      state.activeStudyUID = next.studyInstanceUID;
      emit();
      await updateItem(next.studyInstanceUID, { status: 'downloading', error: undefined });

      try {
        await downloadStudy(next.studyInstanceUID, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted && state.items[next.studyInstanceUID]) {
          await updateItem(next.studyInstanceUID, {
            status: 'error',
            error: error instanceof Error ? error.message : 'No se pudo precargar el estudio',
          });
        }
      } finally {
        abortControllers.delete(next.studyInstanceUID);
        if (state.activeStudyUID === next.studyInstanceUID) {
          state.activeStudyUID = null;
          emit();
        }
      }
    }
  } finally {
    processing = false;
  }
}

export function getPreloadQueue(): PreloadQueueState {
  return snapshot();
}

export function getStudyPreloadStatus(studyInstanceUID: string): PreloadQueueItem | null {
  return state.items[studyInstanceUID] || null;
}

export function subscribeToPreloadQueue(listener: QueueListener): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => listeners.delete(listener);
}

export async function resumePersistedPreloadQueue(): Promise<void> {
  await ensureInitialized();
  void processQueue();
}

export async function toggleStudyPreload(studyInstanceUID: string): Promise<void> {
  await ensureInitialized();

  if (state.items[studyInstanceUID]) {
    await removeItem(studyInstanceUID);
    return;
  }

  const now = Date.now();
  const item: PreloadQueueItem = {
    studyInstanceUID,
    cacheVersion: CACHE_VERSION,
    status: 'queued',
    completed: 0,
    total: 0,
    failed: 0,
    createdAt: now,
    updatedAt: now,
  };
  state.items = { ...state.items, [studyInstanceUID]: item };
  emit();
  await putPersistedItem(item);
  void processQueue();
}

export async function enqueueStudiesPreload(studyInstanceUIDs: string[]): Promise<void> {
  await ensureInitialized();

  const uniqueStudyUIDs = [...new Set(studyInstanceUIDs)].filter(Boolean);
  const itemsToPersist: PreloadQueueItem[] = [];

  for (const studyInstanceUID of uniqueStudyUIDs) {
    if (state.items[studyInstanceUID]) continue;

    const now = Date.now();
    const item: PreloadQueueItem = {
      studyInstanceUID,
      cacheVersion: CACHE_VERSION,
      status: 'queued',
      completed: 0,
      total: 0,
      failed: 0,
      createdAt: now,
      updatedAt: now,
    };
    state.items = { ...state.items, [studyInstanceUID]: item };
    itemsToPersist.push(item);
  }

  if (itemsToPersist.length > 0) {
    emit();
    await Promise.all(itemsToPersist.map(putPersistedItem));
    void processQueue();
  }
}

export async function cancelStudyPreload(studyInstanceUID: string): Promise<void> {
  await ensureInitialized();
  if (state.items[studyInstanceUID]) await removeItem(studyInstanceUID);
}

export async function clearPreloadQueue(userKey?: string): Promise<void> {
  if (!state.initialized) {
    if (!userKey || typeof indexedDB === 'undefined') return;
    try {
      const userDatabase = await openDatabase(userKey);
      const transaction = userDatabase.transaction(STORE_NAME, 'readwrite');
      await requestToPromise(transaction.objectStore(STORE_NAME).clear());
      userDatabase.close();
    } catch (error) {
      console.warn('[Preload] Failed to clear persisted queue', error);
    }
    return;
  }
  abortControllers.forEach(controller => controller.abort());
  abortControllers.clear();
  state.items = {};
  state.activeStudyUID = null;
  emit();
  await clearPersistedItems();
}
