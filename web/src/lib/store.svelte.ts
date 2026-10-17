// App-wide state: the atlas index, a small in-memory chapter cache and UI flags.
import { ApiError, fetchAtlas, fetchChapter } from './api';
import type { AtlasIndex, ChapterData, ChapterSummary } from './types';

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export const store = $state<{
  atlas: AtlasIndex | null;
  atlasState: LoadState;
  atlasError: ApiError | null;
  atlasFromCache: boolean;
  settingsOpen: boolean;
}>({ atlas: null, atlasState: 'idle', atlasError: null, atlasFromCache: false, settingsOpen: false });

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
    .then(({ data, fromCache }) => {
      store.atlas = data;
      store.atlasFromCache = fromCache;
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

interface CachedChapter {
  data: ChapterData;
  fromCache: boolean;
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
      const entry = { data: res.data, fromCache: res.fromCache };
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
