// Names shared by the service worker (src/sw.ts) and the page. Plain constants, no DOM.

/** Generated thumbnails only (v1 could hold full-size originals; it is deleted on activate). */
export const THUMB_CACHE = 'atlas-thumbs-v2';
export const API_CACHE = 'atlas-api-v1';
/** Runtime caches of earlier builds, removed when a new worker activates. */
export const OLD_CACHES = ['atlas-thumbs-v1'];

/** Message posted by the worker: a fresh copy of `path` arrived after a cached one was served. */
export const API_UPDATED = 'atlas-api-updated';
