// @ts-check
// The read-only book (M1): the workspace folder drafted as one chapter at read time.
// Nothing is stored; the story is recomputed from today's local media index on every read.
import { draftFolderChapter, isCuratedNames } from '../model/view.js';
import { formatPlate, formatRange } from '../model/time.js';

export const SCHEMA_VERSION = 1;
export const FOLDER_CHAPTER_ID = 'folder';

/**
 * @typedef {{ path: string, name: string, label: string, index: number | null, type: 'photo' | 'video',
 *   size: number, mtime: string, capturedAt: string | null, width: number | null, height: number | null,
 *   durationSec: number | null, hasDisplay: boolean }} LocalItem
 * @typedef {{ id: string, kind: 'photo' | 'video', name: string, label: string, index: number | null,
 *   takenLocal: string | null, w: number | null, h: number | null, durationSec: number | null, hasDisplay: boolean,
 *   urls: { t400: string, t1200: string, display: string, original: string, download: string } }} StoryItem
 */

/** "day two/é.png" → "day%20two/%C3%A9.png" (each segment encoded, slashes kept). @param {string} p */
export const encodePath = (p) => String(p).split('/').map(encodeURIComponent).join('/');

/**
 * Local index entry → API item. Thumbnail URLs carry the file's mtime so they can be cached forever.
 * @param {LocalItem} it
 * @returns {StoryItem}
 */
export function storyItem(it) {
  const enc = encodePath(it.path);
  const v = Date.parse(it.mtime) || 0;
  return {
    id: `l:${it.path}`,
    kind: it.type,
    name: it.name,
    label: it.label,
    index: it.index,
    takenLocal: it.capturedAt || null,
    w: it.width || null,
    h: it.height || null,
    durationSec: it.durationSec || null,
    hasDisplay: Boolean(it.hasDisplay),
    urls: {
      t400: `/media/local/thumb/${enc}?w=400&v=${v}`,
      t1200: `/media/local/thumb/${enc}?w=1200&v=${v}`,
      display: `/media/local/display/${enc}`,
      original: `/media/local/original/${enc}`,
      download: `/media/local/original/${enc}?download=1`,
    },
  };
}

/**
 * Draft the folder chapter from a local listing; null when the folder has no media.
 * @param {LocalItem[]} list
 * @param {{ title: string, today?: string }} opts
 */
export function draftFolder(list, { title, today }) {
  if (!Array.isArray(list) || !list.length) return null;
  const items = list.map(storyItem);
  const byId = new Map(items.map((it) => [it.id, it]));
  const { chapter, pages } = draftFolderChapter({
    id: FOLDER_CHAPTER_ID,
    title,
    items: items.map((it) => ({ id: it.id, name: it.name, index: it.index, takenLocal: it.takenLocal, kind: it.kind })),
    curated: isCuratedNames(list.map((it) => it.name)),
    today,
  });
  const summary = {
    id: chapter.id,
    title: chapter.title,
    from: chapter.from,
    to: chapter.to,
    status: chapter.status,
    range: formatRange(chapter.from, chapter.to),
    itemCount: chapter.itemCount,
    pageCount: chapter.pageCount,
    photoCount: items.filter((it) => it.kind === 'photo').length,
    videoCount: items.filter((it) => it.kind === 'video').length,
    cover: (chapter.coverId && byId.get(chapter.coverId)) || null,
  };
  /** @type {Record<string, StoryItem>} */
  const itemMap = {};
  for (const p of pages) for (const id of p.items) itemMap[id] = /** @type {StoryItem} */ (byId.get(id));
  return {
    chapter: summary,
    pages: pages.map((p) => ({ id: p.id, date: p.date, plate: formatPlate(p.date), items: p.items })),
    items: itemMap,
  };
}

/**
 * @param {{ settings: { title: string, people: { name: string, color: string }[] } }} cfg
 * @param {{ list: () => Promise<LocalItem[]> }} local
 */
export function createStory(cfg, local) {
  // local.list() hands out the same array until its next rescan (at most every 2 s), so one
  // draft serves the burst of reads a page load makes.
  /** @type {{ list: LocalItem[], title: string, draft: ReturnType<typeof draftFolder> } | null} */
  let memo = null;

  async function folder() {
    const list = await local.list();
    const title = cfg.settings.title;
    if (!memo || memo.list !== list || memo.title !== title) memo = { list, title, draft: draftFolder(list, { title }) };
    return memo.draft;
  }

  /** GET /api/atlas */
  async function atlas() {
    const draft = await folder();
    return {
      schemaVersion: SCHEMA_VERSION,
      title: cfg.settings.title,
      people: cfg.settings.people,
      chapters: draft ? [draft.chapter] : [],
    };
  }

  /** GET /api/chapters/:id → the chapter, or null when unknown. @param {string} id */
  async function chapter(id) {
    if (id !== FOLDER_CHAPTER_ID) return null;
    return folder();
  }

  return { atlas, chapter };
}
