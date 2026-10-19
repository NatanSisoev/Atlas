// Service worker (built by vite-plugin-pwa, injectManifest):
// - the app shell (HTML, JS, CSS, fonts, icons) is precached, so the installed app opens offline;
//   navigations still go to the network first, so the server's current CSP and security headers
//   reach installed apps (the precached shell, with its install-time headers, is the offline copy);
// - generated thumbnails (versioned and sent as immutable) are cache-first with an entry cap;
//   offline, a width that was never fetched is answered by a cached width of the same version;
// - the book's JSON is network-first with a cached fallback, marked so the UI can say "Offline"
//   (or that the laptop is slow, in which case the fresh copy is posted to the page when it lands);
// - a reverse proxy's 502/503/504 (Tailscale Serve while Atlas is stopped) counts as offline;
// - video and full-size media are never cached here (they stream with Range requests), and
//   neither is a thumbnail the server could not make (it then sends the source file itself).
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import type { WorkboxPlugin } from 'workbox-core/types';
import { API_CACHE, API_UPDATED, THUMB_CACHE, OLD_CACHES } from './lib/cache-names';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Caches of earlier builds that runtime routing no longer uses (cleanupOutdatedCaches only knows
// precaches). atlas-thumbs-v1 could hold full-size originals stored as "thumbnails".
self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all(OLD_CACHES.map((name) => caches.delete(name))));
});

const sameOrigin = (url: URL) => url.origin === self.location.origin;

/** Behind `tailscale serve` (or any proxy) a stopped Atlas answers 502/503/504: treat that as offline. */
const gatewayDown: WorkboxPlugin = {
  fetchDidSucceed: async ({ response }) => {
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new Error(`gateway ${response.status}`);
    }
    return response;
  },
};

// ---- navigations: "/" and "/c/..." (the old board, the API and media are not ours) ----

const shell = createHandlerBoundToURL('/index.html');
const NAV_TIMEOUT_MS = 3000;

registerRoute(
  new NavigationRoute(
    async (options) => {
      try {
        const res = await Promise.race([
          fetch(options.request),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS)),
        ]);
        if (res && res.ok) return res;
      } catch {
        /* offline: the shell */
      }
      return shell(options);
    },
    { allowlist: [/^\/$/, /^\/c\//] },
  ),
);

// ---- thumbnails ----

/**
 * Keep only real generated thumbnails, which the server marks immutable. The source file sent
 * when ImageMagick is missing or failed (no-store, full size, with its EXIF) and SVG placeholders
 * (no-store) always go to the network, so a real thumbnail can take their place later.
 */
const onlyImmutable: WorkboxPlugin = {
  cacheWillUpdate: async ({ response }) => (/\bimmutable\b/i.test(response.headers.get('cache-control') || '') ? response : null),
};

const WIDTHS = ['2400', '1200', '800', '400', '200', '128'];

/**
 * Offline, answer a width that was never fetched with a cached width of the same version (a tile
 * on a phone may have cached only t400 while the viewer asks for t1200). Sharpest first; the path
 * and `v` stay the same, so a stale version is never shown. Fallbacks are not written to the cache.
 */
const siblingWidth: WorkboxPlugin = {
  handlerDidError: async ({ request }) => {
    const url = new URL(request.url);
    const want = url.searchParams.get('w');
    const cache = await caches.open(THUMB_CACHE);
    for (const w of WIDTHS) {
      if (w === want) continue;
      url.searchParams.set('w', w);
      const hit = await cache.match(url.href);
      if (hit) return hit;
    }
    return undefined;
  },
};

// Only versioned thumbnails (`&v=<mtime>`, as the book asks for them) can be immutable; the old
// board's unversioned ones go to the network as before.
registerRoute(
  ({ url, request }) =>
    sameOrigin(url) && request.method === 'GET' && url.pathname.startsWith('/media/local/thumb/') && url.searchParams.has('v'),
  new CacheFirst({
    cacheName: THUMB_CACHE,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      onlyImmutable,
      gatewayDown,
      new ExpirationPlugin({ maxEntries: 3000, purgeOnQuotaError: true }),
      siblingWidth,
    ],
  }),
);

// ---- the book's JSON ----

/**
 * A cached copy answered instead of the network carries `X-Atlas-Cache: fallback` (the network
 * failed) or `slow` (it did not answer within the timeout). When a slow answer lands after a cached
 * copy was served, the fresh JSON is posted to the open pages so they can swap it in.
 */
const markFallback: WorkboxPlugin = {
  fetchDidFail: async ({ state }) => {
    if (state) state.failed = true;
  },
  cachedResponseWillBeUsed: async ({ cachedResponse, state }) => {
    if (!cachedResponse) return cachedResponse;
    if (state) state.servedFallback = true;
    const headers = new Headers(cachedResponse.headers);
    headers.set('X-Atlas-Cache', state?.failed ? 'fallback' : 'slow');
    const body = await cachedResponse.blob();
    return new Response(body, { status: cachedResponse.status, statusText: cachedResponse.statusText, headers });
  },
  cacheDidUpdate: async ({ request, newResponse, state }) => {
    if (!state?.servedFallback) return;
    let data: unknown;
    try {
      data = await newResponse.json();
    } catch {
      return;
    }
    const path = new URL(request.url).pathname;
    for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: API_UPDATED, path, data });
  },
};

registerRoute(
  ({ url, request }) =>
    sameOrigin(url) &&
    request.method === 'GET' &&
    (url.pathname === '/api/atlas' || url.pathname.startsWith('/api/chapters/') || url.pathname === '/api/health'),
  new NetworkFirst({
    cacheName: API_CACHE,
    networkTimeoutSeconds: 6,
    plugins: [new CacheableResponsePlugin({ statuses: [200] }), gatewayDown, markFallback],
  }),
);
