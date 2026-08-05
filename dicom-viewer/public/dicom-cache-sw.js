const CACHE_PREFIX = 'nextviewer-dicom-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

function isDicomImageRequest(request, requestUrl) {
  const url = new URL(requestUrl);
  return request.method === 'GET' &&
    url.pathname.includes('/dcm4chee-arc/') &&
    url.searchParams.get('requestType') === 'WADO' &&
    url.searchParams.get('contentType') === 'application/dicom';
}

function cacheNameFor(request) {
  const userKey = request.headers.get('X-Dicom-Cache-User') || 'anonymous';
  return `${CACHE_PREFIX}-${userKey}`;
}

self.addEventListener('fetch', event => {
  if (!isDicomImageRequest(event.request, event.request.url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(cacheNameFor(event.request));
    const cached = await cache.match(event.request);
    if (cached) return cached;

    const response = await fetch(event.request);
    if (response.ok) {
      await cache.put(event.request, response.clone());
    }
    return response;
  })());
});
