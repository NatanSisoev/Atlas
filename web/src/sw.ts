// Service worker (built by vite-plugin-pwa, injectManifest):
// - the app shell (HTML, JS, CSS, fonts, icons) is precached, so the installed app opens offline;
// - thumbnails (versioned, so immutable) are cache-first with an entry cap;
// - the book's JSON is network-first with a cached fallback, marked so the UI can say "Offline";
// - video and full-size media are never cached here (they stream with Range requests).
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import type { WorkboxPlugin } from 'workbox-core/types';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// App routes ("/" and "/c/...") open the precached shell; the old board, the API and media are not ours.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { allowlist: [/^\/$/, /^\/c\//] }));

const sameOrigin = (url: URL) => url.origin === self.location.origin;

/** Never keep a placeholder (SVG) thumbnail: the real one may exist next time. */
const skipPlaceholders: WorkboxPlugin = {
  cacheWillUpdate: async ({ response }) => (/svg/i.test(response.headers.get('content-type') || '') ? null : response),
};

// Only versioned thumbnails (`&v=<mtime>`, as the book asks for them) are immutable; the old
// board's unversioned ones go to the network as before.
registerRoute(
  ({ url, request }) =>
    sameOrigin(url) && request.method === 'GET' && url.pathname.startsWith('/media/local/thumb/') && url.searchParams.has('v'),
  new CacheFirst({
    cacheName: 'atlas-thumbs-v1',
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      skipPlaceholders,
      new ExpirationPlugin({ maxEntries: 3000, purgeOnQuotaError: true }),
    ],
  }),
);

/** Responses answered from the cache because the network failed carry X-Atlas-Cache: fallback. */
const markFallback: WorkboxPlugin = {
  cachedResponseWillBeUsed: async ({ cachedResponse }) => {
    if (!cachedResponse) return cachedResponse;
    const headers = new Headers(cachedResponse.headers);
    headers.set('X-Atlas-Cache', 'fallback');
    const body = await cachedResponse.blob();
    return new Response(body, { status: cachedResponse.status, statusText: cachedResponse.statusText, headers });
  },
};

registerRoute(
  ({ url, request }) =>
    sameOrigin(url) &&
    request.method === 'GET' &&
    (url.pathname === '/api/atlas' || url.pathname.startsWith('/api/chapters/') || url.pathname === '/api/health'),
  new NetworkFirst({
    cacheName: 'atlas-api-v1',
    networkTimeoutSeconds: 6,
    plugins: [new CacheableResponsePlugin({ statuses: [200] }), markFallback],
  }),
);
