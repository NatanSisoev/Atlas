// GoPro share links (https://gopro.com/v/<uuid>): anonymous listing, thumbnails and playback URLs.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError, readJson, writeJsonAtomic, moveToTrash, keyedLock } from './util.js';

const API = 'https://api.gopro.com';
const ACCEPT_COLLECTIONS = 'application/vnd.gopro.jk.collections+json; version=2.0.0';
const ACCEPT_MEDIA = 'application/vnd.gopro.jk.media+json; version=2.0.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MEDIUM_RE = /^[a-f0-9]{16,40}$/;
export const TOKEN_RE = /^[A-Za-z0-9._-]{8,2048}$/;
const PLAY_TTL_MS = 40 * 60 * 1000;

/** Accepts a share URL (with or without query/trailing slash/www) or a bare UUID; returns the lowercase id or null. */
export function parseShareLink(input) {
  const s = String(input ?? '').trim();
  if (UUID_RE.test(s.toLowerCase())) return s.toLowerCase();
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'gopro.com' && !host.endsWith('.gopro.com')) return null;
  const m = /^\/v\/([0-9a-fA-F-]{36})\/?$/.exec(u.pathname);
  if (!m || !UUID_RE.test(m[1].toLowerCase())) return null;
  return m[1].toLowerCase();
}

export function imageHost(token) {
  let h = 0;
  for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) >>> 0;
  return `https://images-0${1 + (h % 4)}.gopro.com`;
}

// GoPro's resizer only answers a few fixed widths (others 404).
export const GOPRO_WIDTHS = [450, 640, 1280, 1920, 2560];

export function snapWidth(w) {
  return GOPRO_WIDTHS.find((x) => x >= w) || GOPRO_WIDTHS.at(-1);
}

export function thumbUrl(token, w) {
  return `${imageHost(token)}/resize/${snapWidth(w)}w/${token}`;
}

async function getJson(url, accept, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: accept, 'User-Agent': UA, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(25_000),
      redirect: 'follow',
    });
  } catch (err) {
    throw new HttpError(502, `GoPro is not reachable (${err.cause?.code || err.name || 'network error'})`);
  }
  if (res.status === 404 || res.status === 403 || res.status === 401) throw new HttpError(404, 'GoPro link not found or no longer shared');
  if (!res.ok) throw new HttpError(502, `GoPro answered ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new HttpError(502, 'GoPro sent an unreadable answer');
  }
}

export function mapItem(it) {
  const m = it && it.medium;
  if (!m || !MEDIUM_RE.test(String(m.id))) return null;
  const dur = Number(m.source_duration);
  return {
    mediumId: String(m.id),
    filename: String(m.filename || ''),
    mediaType: String(m.type || 'Photo'),
    capturedAt: m.captured_at || null,
    tz: /^[+-]\d{2}:\d{2}$/.test(String(m.captured_at_timezone)) ? m.captured_at_timezone : null,
    width: Number(m.width) || null,
    height: Number(m.height) || null,
    fileSize: Number(m.file_size) || null,
    token: TOKEN_RE.test(String(m.token)) ? String(m.token) : null,
    durationSec: Number.isFinite(dur) && dur > 0 ? Math.round(dur / 100) / 10 : null,
    itemCount: Number(m.item_count) || 1,
  };
}

/** Pick the best phone-friendly stream from a /media/:id/download answer. */
export function pickPlayable(dl) {
  const files = dl?._embedded?.files || [];
  const vars = dl?._embedded?.variations || [];
  const ok = (f) => f && f.available !== false && typeof f.url === 'string' && /^https:\/\//.test(f.url);
  const h264 = (f) => String(f.video_codec || '').toLowerCase() === 'h264';
  return (
    files.find((f) => ok(f) && h264(f) && Number(f.height) === 1080) ||
    files.find((f) => ok(f) && h264(f) && Number(f.width) === 1080) ||
    vars.find((v) => ok(v) && v.label === 'high_res_proxy_mp4') ||
    vars.find((v) => ok(v) && v.label === 'edit_proxy') ||
    vars.find((v) => ok(v) && v.label === 'source') ||
    files.find(ok) ||
    null
  )?.url || null;
}

export function pickSource(dl) {
  const vars = dl?._embedded?.variations || [];
  const files = dl?._embedded?.files || [];
  const ok = (f) => f && f.available !== false && typeof f.url === 'string' && /^https:\/\//.test(f.url);
  return (vars.find((v) => ok(v) && v.label === 'source') || files.find(ok))?.url || null;
}

export function createGoPro(cfg, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const lock = keyedLock();
  const playCache = new Map(); // mediumId -> {play, source, at}
  let known = null; // Set of mediumIds in saved links

  const fileOf = (id) => {
    if (!UUID_RE.test(id)) throw new HttpError(404, 'link not found');
    return path.join(cfg.gopro, `${id}.json`);
  };

  async function readLink(id) {
    const doc = await readJson(fileOf(id), null).catch(() => null);
    if (!doc) throw new HttpError(404, 'link not found');
    return doc;
  }

  async function allLinks() {
    const names = (await fsp.readdir(cfg.gopro).catch(() => [])).filter((n) => n.endsWith('.json'));
    const out = [];
    for (const n of names) {
      const d = await readJson(path.join(cfg.gopro, n), null).catch(() => null);
      if (d && d.id) out.push(d);
    }
    return out;
  }

  async function knownIds() {
    if (!known) {
      known = new Set();
      for (const l of await allLinks()) for (const it of l.items || []) known.add(it.mediumId);
    }
    return known;
  }

  const summary = (d) => ({
    id: d.id,
    title: d.title,
    url: `https://gopro.com/v/${d.id}`,
    mediaCount: d.mediaCount,
    createdAt: d.createdAt,
    fetchedAt: d.fetchedAt,
  });

  async function fetchLink(id) {
    const meta = await getJson(
      `${API}/collections/${id}?fields=title,gopro_user_id,media_count,created_at,cloneable,livestream_collection`,
      ACCEPT_COLLECTIONS,
      fetchImpl,
    );
    const items = [];
    let title = meta.title;
    for (let page = 1, total = 1; page <= total && page <= 100; page++) {
      const j = await getJson(`${API}/media/items/${id}?page=${page}&per_page=200`, ACCEPT_MEDIA, fetchImpl);
      title = title || j.title;
      total = Number(j?._pages?.total_pages) || 1;
      for (const it of j.items || []) {
        const m = mapItem(it);
        if (m) items.push(m);
      }
    }
    items.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)) || a.filename.localeCompare(b.filename));
    return {
      id,
      title: String(title || 'GoPro share').slice(0, 200),
      mediaCount: Number(meta.media_count) || items.length,
      createdAt: meta.created_at || null,
      fetchedAt: new Date().toISOString(),
      items,
    };
  }

  async function add(url) {
    const id = parseShareLink(url);
    if (!id) throw new HttpError(400, 'That does not look like a GoPro share link (https://gopro.com/v/…)');
    return lock(id, async () => {
      const doc = await fetchLink(id);
      await writeJsonAtomic(fileOf(id), doc);
      known = null;
      log(`GoPro link ${id.slice(0, 8)}…: ${doc.items.length} items`);
      return summary(doc);
    });
  }

  async function refresh(id) {
    await readLink(id);
    return add(id);
  }

  async function remove(id) {
    return lock(id, async () => {
      await readLink(id);
      await moveToTrash(path.join(cfg.trash, 'gopro'), fileOf(id), `${id}.json`);
      known = null;
      return { ok: true };
    });
  }

  async function list() {
    return (await allLinks()).map(summary).sort((a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt)));
  }

  async function items(id) {
    const d = await readLink(id);
    return { link: summary(d), items: d.items || [] };
  }

  async function download(mediumId) {
    if (!MEDIUM_RE.test(mediumId)) throw new HttpError(404, 'not found');
    if (!(await knownIds()).has(mediumId)) throw new HttpError(404, 'not in any saved GoPro link');
    const hit = playCache.get(mediumId);
    if (hit && Date.now() - hit.at < PLAY_TTL_MS) return hit;
    const dl = await getJson(`${API}/media/${mediumId}/download`, ACCEPT_MEDIA, fetchImpl);
    const entry = { play: pickPlayable(dl), source: pickSource(dl), at: Date.now() };
    if (!entry.play && !entry.source) throw new HttpError(404, 'GoPro has no playable file for this item');
    playCache.set(mediumId, entry);
    if (playCache.size > 2000) playCache.delete(playCache.keys().next().value);
    return entry;
  }

  return {
    add, refresh, remove, list, items,
    playUrl: async (id) => { const e = await download(id); return e.play || e.source; },
    sourceUrl: async (id) => { const e = await download(id); return e.source || e.play; },
    count: async () => (await allLinks()).length,
  };
}
