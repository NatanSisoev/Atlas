// Read-only API client. Same-origin GETs only; the server needs no custom header for reads.
// When the network fails, the service worker answers /api/* from its cache and marks the
// response with `X-Atlas-Cache: fallback`, which the UI shows as a quiet offline line.
import type { AtlasIndex, ChapterData, ChapterSummary, Item, ItemUrls, Page, Person } from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Loaded<T> {
  data: T;
  fromCache: boolean;
}

async function getJson(path: string, signal?: AbortSignal): Promise<Loaded<unknown>> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' }, credentials: 'same-origin', signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError(0, 'network');
  }
  if (!res.ok) {
    let message = res.statusText || 'error';
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  return { data: await res.json(), fromCache: res.headers.get('x-atlas-cache') === 'fallback' };
}

// ---- light normalisation: the shapes are fixed by contract, but never crash on a bad field ----

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Only same-origin absolute paths ("/media/…"); anything else becomes empty. */
export function safePath(v: unknown): string {
  return typeof v === 'string' && /^\/(?![/\\])/.test(v) ? v : '';
}

/**
 * A label is a caption only when it reads as words. "0042", "IMG 20250812 150019", "GOPR0123",
 * "DSC 0042" or "PXL 20250812..." are file names from a camera, not something a person wrote.
 */
export function captionFrom(label: string): string {
  const t = label.trim();
  if (!t) return '';
  if (/^[\d\s_.-]+$/.test(t)) return '';
  if (/^(img|dsc[fn]?|pxl|gopr|gp|gx|gh|mvi|vid|mov|dji|sam|wp|pano|burst|photo|image|video|screenshot)[\s_-]*\d/i.test(t)) return '';
  if (/^\d{8}[\s_-]?\d{6}/.test(t)) return '';
  return t;
}

function normItem(raw: unknown): Item | null {
  const r = obj(raw);
  const id = str(r.id);
  if (!id) return null;
  const u = obj(r.urls);
  const urls: ItemUrls = {
    t400: safePath(u.t400),
    t1200: safePath(u.t1200),
    display: safePath(u.display),
    original: safePath(u.original),
    download: safePath(u.download),
  };
  const label = str(r.label).trim();
  return {
    id,
    kind: r.kind === 'video' ? 'video' : 'photo',
    name: str(r.name),
    label,
    caption: captionFrom(label),
    index: typeof r.index === 'number' && Number.isFinite(r.index) ? r.index : null,
    takenLocal: strOrNull(r.takenLocal),
    w: numOrNull(r.w),
    h: numOrNull(r.h),
    durationSec: numOrNull(r.durationSec),
    hasDisplay: r.hasDisplay === true,
    urls,
  };
}

function normChapter(raw: unknown): ChapterSummary | null {
  const r = obj(raw);
  const id = str(r.id);
  if (!id) return null;
  const status = r.status;
  return {
    id,
    title: str(r.title),
    from: strOrNull(r.from),
    to: strOrNull(r.to),
    status: status === 'upcoming' || status === 'ongoing' || status === 'past' ? status : 'someday',
    range: strOrNull(r.range),
    itemCount: num(r.itemCount),
    pageCount: num(r.pageCount),
    photoCount: num(r.photoCount),
    videoCount: num(r.videoCount),
    cover: r.cover ? normItem(r.cover) : null,
  };
}

function normAtlas(raw: unknown): AtlasIndex {
  const r = obj(raw);
  const people: Person[] = (Array.isArray(r.people) ? r.people : [])
    .map((p) => obj(p))
    .filter((p) => typeof p.name === 'string' && p.name.trim())
    .map((p) => ({ name: str(p.name).trim(), color: /^#[0-9a-f]{3,8}$/i.test(str(p.color)) ? str(p.color) : '#5E5D59' }));
  const chapters = (Array.isArray(r.chapters) ? r.chapters : []).map(normChapter).filter((c): c is ChapterSummary => !!c);
  return { schemaVersion: num(r.schemaVersion, 1), title: str(r.title), people, chapters };
}

function normChapterData(raw: unknown): ChapterData {
  const r = obj(raw);
  const chapter = normChapter(r.chapter);
  if (!chapter) throw new ApiError(500, 'bad chapter');
  const items: Record<string, Item> = {};
  for (const [key, value] of Object.entries(obj(r.items))) {
    const it = normItem(value);
    if (it) items[key] = it;
  }
  const pages: Page[] = (Array.isArray(r.pages) ? r.pages : []).map((p, i) => {
    const pr = obj(p);
    const plate = obj(pr.plate);
    return {
      id: str(pr.id, `p${i + 1}`),
      date: strOrNull(pr.date),
      plate: pr.plate
        ? { weekday: str(plate.weekday), day: str(plate.day), month: str(plate.month), long: str(plate.long), full: str(plate.full) }
        : null,
      items: (Array.isArray(pr.items) ? pr.items : []).filter((id): id is string => typeof id === 'string' && !!items[id]),
    };
  });
  return { chapter, pages: pages.filter((p) => p.items.length > 0), items };
}

export async function fetchAtlas(signal?: AbortSignal): Promise<Loaded<AtlasIndex>> {
  const res = await getJson('/api/atlas', signal);
  return { data: normAtlas(res.data), fromCache: res.fromCache };
}

export async function fetchChapter(id: string, signal?: AbortSignal): Promise<Loaded<ChapterData>> {
  const res = await getJson(`/api/chapters/${encodeURIComponent(id)}`, signal);
  return { data: normChapterData(res.data), fromCache: res.fromCache };
}
