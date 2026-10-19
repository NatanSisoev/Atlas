// App-wide state: the atlas index, a small in-memory chapter cache and UI flags.
import { ApiError, fetchAtlas, fetchChapter, normAtlas, normChapterData } from './api';
import { API_UPDATED } from './cache-names';
import type { AtlasIndex, ChapterData, ChapterSummary } from './types';

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export const store = $state<{
  atlas: AtlasIndex | null;
  atlasState: LoadState;
  atlasError: ApiError | null;
  atlasFromCache: boolean;
  /** The saved copy is shown because the laptop was slow to answer (not unreachable). */
  atlasSlow: boolean;
  settingsOpen: boolean;
  /** Bumped when the service worker hands over a fresh copy of a chapter (see applyFresh). */
  chapterEpoch: number;
}>({ atlas: null, atlasState: 'idle', atlasError: null, atlasFromCache: false, atlasSlow: false, settingsOpen: false, chapterEpoch: 0 });

/**
 * Which elements carry the shared view-transition names during the next route change:
 * `hero` (a chapter's cover, Cover <-> Story) and `media` (a thumbnail <-> the viewer).
 */
export const vt = $state<{ hero: string | null; media: string | null }>({ hero: null, media: null });

let atlasInflight: Promise<void> | null = null;

export function loadAtlas(): Promise<void> {
  if (atlasInflight) return atlasInflight;
  if (!store.atlas) store.atlasState = 'loading';
  atlasInflight = fetchAtlas()
    .then(({ data, fromCache, slow }) => {
      store.atlas = data;
      store.atlasFromCache = fromCache;
      store.atlasSlow = slow;
      store.atlasError = null;
      store.atlasState = 'ready';
      document.title = data.title ? `${data.title} · Atlas` : 'Atlas';
    })
    .catch((err: unknown) => {
      store.atlasError = err instanceof ApiError ? err : new ApiError(0, 'network');
      if (!store.atlas) store.atlasState = 'error';
    })
    .finally(() => {
      atlasInflight = null;
    });
  return atlasInflight;
}

export function chapterSummary(id: string): ChapterSummary | null {
  return store.atlas?.chapters.find((c) => c.id === id) ?? null;
}

export interface CachedChapter {
  data: ChapterData;
  fromCache: boolean;
  slow: boolean;
}

const chapters = new Map<string, CachedChapter>();
const chapterInflight = new Map<string, Promise<CachedChapter>>();

export function cachedChapter(id: string): CachedChapter | null {
  return chapters.get(id) ?? null;
}

/** Every chapter asked for in this page's life (the offline warm-up asks again for them). */
export const requestedChapters = new Set<string>();

export function loadChapter(id: string): Promise<CachedChapter> {
  const running = chapterInflight.get(id);
  if (running) return running;
  requestedChapters.add(id);
  const p = fetchChapter(id)
    .then((res) => {
      const entry = { data: res.data, fromCache: res.fromCache, slow: res.slow };
      // Keep a network copy over a cached fallback that arrives later.
      const prev = chapters.get(id);
      if (!prev || !res.fromCache || prev.fromCache) chapters.set(id, entry);
      return chapters.get(id) as CachedChapter;
    })
    .finally(() => chapterInflight.delete(id));
  chapterInflight.set(id, p);
  return p;
}

/** Warm the chapter (e.g. on hover/touch of its cover) so the story opens instantly. */
export function prefetchChapter(id: string): void {
  if (!chapters.has(id)) loadChapter(id).catch(() => {});
}

/** The thumbnail URL a tile was showing when it was opened: the viewer starts from it. */
export const seedSrc = new Map<string, string>();

/**
 * The service worker answered from its cache because the laptop was slow, and the network copy has
 * now arrived: show it (the network copy wins over any saved one).
 */
export function applyFresh(path: string, raw: unknown): void {
  try {
    if (path === '/api/atlas') {
      store.atlas = normAtlas(raw);
      store.atlasFromCache = false;
      store.atlasSlow = false;
      store.atlasError = null;
      store.atlasState = 'ready';
      return;
    }
    const m = /^\/api\/chapters\/([^/]+)$/.exec(path);
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    if (!requestedChapters.has(id)) return;
    chapters.set(id, { data: normChapterData(raw), fromCache: false, slow: false });
    store.chapterEpoch++;
  } catch {
    /* a bad body or path: keep what is shown */
  }
}

/** Listen for fresh copies posted by the service worker (see src/sw.ts). */
export function listenForFreshCopies(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: unknown; path?: unknown; data?: unknown } | null;
    if (d && d.type === API_UPDATED && typeof d.path === 'string') applyFresh(d.path, d.data);
  });
}

/**
 * While a saved copy is shown, try again when the network comes back and on a slow backoff
 * (5 s, 15 s, then every minute). Returns the stop function.
 */
export function retryWhileStale(reload: () => void): () => void {
  const delays = [5000, 15000, 60000];
  let n = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    timer = setTimeout(() => {
      if (document.visibilityState === 'visible') reload();
      n = Math.min(n + 1, delays.length - 1);
      arm();
    }, delays[n]);
  };
  const online = () => reload();
  window.addEventListener('online', online);
  arm();
  return () => {
    if (timer) clearTimeout(timer);
    window.removeEventListener('online', online);
  };
}
