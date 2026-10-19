// @ts-check
// Read-time drafting of chapters and pages. Pure functions, no dependencies; shared by the
// server and the web client. Nothing here writes: the story is recomputed on every read.
import { localDay, wallKey, chapterStatus, todayYmd } from './time.js';

/**
 * `dir` is the item's folder inside the source ('' at its root, "day 2" or "2025 Black Sea/day 2"
 * below it); optional, only Curated order uses it.
 * @typedef {{ id: string, name: string, index: number | null, takenLocal: string | null, kind: 'photo' | 'video', dir?: string }} DraftItem
 * @typedef {{ id: string, date: string | null, items: string[] }} DraftPage
 * @typedef {{ id: string, title: string, from: string | null, to: string | null,
 *   status: 'upcoming' | 'ongoing' | 'past' | 'someday', coverId: string | null,
 *   itemCount: number, pageCount: number }} DraftChapter
 */

const CURATED_RE = /^\d+_/;
const CURATED_SHARE = 0.8;

/**
 * A folder is Curated when at least 80% of its file names start with "NNNN_".
 * @param {string[]} names
 * @returns {boolean}
 */
export function isCuratedNames(names) {
  if (!Array.isArray(names) || names.length === 0) return false;
  const hits = names.filter((n) => CURATED_RE.test(String(n).split(/[\\/]/).pop() || '')).length;
  return hits / names.length >= CURATED_SHARE;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byName = (/** @type {DraftItem} */ a, /** @type {DraftItem} */ b) =>
  collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Folders: root ('') first, then numeric-aware ("day 2" before "day 10"). @param {string} a @param {string} b */
const byDir = (a, b) => (a === b ? 0 : a === '' ? -1 : b === '' ? 1 : collator.compare(a, b) || (a < b ? -1 : 1));
/** Ascending with nulls last. @param {any} a @param {any} b */
const nullsLast = (a, b) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : 1);

/**
 * Story order: Curated folders read in filename order, folder by folder (dir, index, name; files at
 * the root first, numbered subfolders that each restart at 0001 never interleave); others by time
 * (undated last).
 * @param {DraftItem[]} items
 * @param {boolean} curated
 * @returns {DraftItem[]}
 */
export function storyOrder(items, curated) {
  const keyed = items.map((it) => ({ it, key: curated ? (Number.isFinite(it.index) ? it.index : null) : wallKey(it.takenLocal) }));
  keyed.sort(
    (a, b) =>
      (curated ? byDir(a.it.dir || '', b.it.dir || '') : 0) || nullsLast(a.key, b.key) || byName(a.it, b.it),
  );
  return keyed.map((k) => k.it);
}

/**
 * Walk the sequence and start a page whenever the local day changes. Undated items stay on the
 * current page; leading undated items form a page with date null. Returning to an earlier day
 * starts its own page.
 * @param {DraftItem[]} ordered
 * @returns {DraftPage[]}
 */
export function paginate(ordered) {
  /** @type {DraftPage[]} */
  const pages = [];
  /** @type {DraftPage | undefined} */
  let page;
  for (const it of ordered) {
    const day = localDay(it.takenLocal);
    if (!page || (day !== null && day !== page.date)) {
      page = { id: `p${pages.length + 1}`, date: day, items: [] };
      pages.push(page);
    }
    page.items.push(it.id);
  }
  return pages;
}

/**
 * Draft a chapter from one folder of media.
 * @param {{ id: string, title: string, items: DraftItem[], curated: boolean, today?: string }} input
 * @returns {{ chapter: DraftChapter, pages: DraftPage[] }}
 */
export function draftFolderChapter({ id, title, items, curated, today }) {
  const ordered = storyOrder(items || [], !!curated);
  const pages = paginate(ordered);
  const days = pages.map((p) => p.date).filter((d) => d !== null).sort();
  const from = days[0] ?? null;
  const to = days[days.length - 1] ?? null;
  const cover = ordered.find((it) => it.kind === 'photo') || ordered[0];
  return {
    chapter: {
      id,
      title: title || '',
      from,
      to,
      status: chapterStatus(from, to, today || todayYmd()),
      coverId: cover ? cover.id : null,
      itemCount: ordered.length,
      pageCount: pages.length,
    },
    pages,
  };
}
