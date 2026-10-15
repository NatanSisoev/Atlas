// Boards: JSON docs with optimistic concurrency (rev), atomic writes, backups and a trash.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError, readJson, writeJsonAtomic, moveToTrash, keyedLock, isPlainObject } from './util.js';

export const CARD_TYPES = new Set(['photo', 'video', 'note', 'message', 'file', 'link', 'frame']);
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_CARDS = 5000;
const BACKUP_KEEP_RECENT = 30;
const BACKUP_KEEP_TOTAL = 100;
const BACKUP_BUCKET_MS = 10 * 60 * 1000;

export function newId(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
}

const finite = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v, max) => (v == null ? undefined : String(v).slice(0, max));

/** Light validation: shape and sizes only; the frontend owns the semantics. */
export function cleanBoard(doc, current) {
  if (!isPlainObject(doc)) throw new HttpError(400, 'board must be an object');
  if (!Array.isArray(doc.cards)) throw new HttpError(400, 'cards must be an array');
  if (doc.cards.length > MAX_CARDS) throw new HttpError(400, `too many cards (max ${MAX_CARDS})`);
  const ids = new Set();
  const cards = doc.cards.map((c, i) => {
    if (!isPlainObject(c)) throw new HttpError(400, `card ${i} must be an object`);
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) throw new HttpError(400, `card ${i} has a bad id`);
    if (ids.has(c.id)) throw new HttpError(400, `duplicate card id ${c.id}`);
    ids.add(c.id);
    if (!CARD_TYPES.has(c.type)) throw new HttpError(400, `card ${c.id} has an unknown type`);
    const out = { ...c };
    for (const k of ['x', 'y', 'w', 'h', 'rot', 'z']) out[k] = finite(c[k]);
    out.w = Math.max(20, Math.min(20000, out.w || 200));
    out.h = Math.max(20, Math.min(20000, out.h || 200));
    for (const k of ['text', 'caption', 'title', 'url', 'from', 'at', 'color']) {
      if (k in c) out[k] = str(c[k], k === 'text' ? 100_000 : 2000);
    }
    if ('src' in c && c.src != null && !isPlainObject(c.src)) throw new HttpError(400, `card ${c.id} has a bad src`);
    return out;
  });
  const strings = Array.isArray(doc.strings)
    ? doc.strings.filter((s) => isPlainObject(s) && ids.has(s.from) && ids.has(s.to) && s.from !== s.to).map((s) => ({
        id: ID_RE.test(String(s.id)) ? String(s.id) : newId('s'),
        from: s.from,
        to: s.to,
        color: str(s.color, 40) || '#b3261e',
      }))
    : [];
  const vp = isPlainObject(doc.viewport) ? doc.viewport : current.viewport || {};
  return {
    id: current.id,
    title: str(doc.title, 200)?.trim() || current.title,
    rev: current.rev,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
    viewport: { x: finite(vp.x), y: finite(vp.y), zoom: Math.min(4, Math.max(0.1, finite(vp.zoom, 1))) },
    cards,
    strings,
  };
}

export function createBoards(cfg, log = () => {}) {
  const lock = keyedLock();
  const fileOf = (id) => {
    if (!ID_RE.test(id)) throw new HttpError(404, 'board not found');
    return path.join(cfg.boards, `${id}.json`);
  };

  async function read(id) {
    try {
      return JSON.parse(await fsp.readFile(fileOf(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') throw new HttpError(404, 'board not found');
      if (err instanceof SyntaxError) throw new HttpError(500, `board ${id} is unreadable; restore it from .atlas/backups/${id}/`);
      throw err;
    }
  }

  async function all() {
    const names = (await fsp.readdir(cfg.boards).catch(() => [])).filter((n) => n.endsWith('.json'));
    const docs = [];
    for (const n of names) {
      const doc = await readJson(path.join(cfg.boards, n), null).catch(() => null);
      if (doc && doc.id) docs.push(doc);
      else log(`skipping unreadable board file ${n}`);
    }
    return docs;
  }

  async function create(title) {
    const now = new Date().toISOString();
    const doc = {
      id: newId('b'),
      title: String(title || 'Untitled board').trim().slice(0, 200) || 'Untitled board',
      rev: 1,
      createdAt: now,
      updatedAt: now,
      viewport: { x: 0, y: 0, zoom: 1 },
      cards: [],
      strings: [],
    };
    await writeJsonAtomic(fileOf(doc.id), doc);
    return doc;
  }

  async function list() {
    let docs = await all();
    if (!docs.length) docs = [await lock('__create_default', async () => {
      const again = await all();
      return again[0] || create(cfg.settings.title);
    })];
    return docs
      .map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt, cardCount: Array.isArray(d.cards) ? d.cards.length : 0 }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async function backup(current) {
    const dir = path.join(cfg.backups, current.id);
    const stamp = new Date().toISOString().replace(/:/g, '-');
    await writeJsonAtomic(path.join(dir, `${stamp}_r${current.rev}.json`), current);
    await pruneBackups(dir);
  }

  /** Keep the newest 30 backups, then one per 10-minute window, up to 100 files. */
  async function pruneBackups(dir) {
    const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort().reverse();
    const keep = new Set(names.slice(0, BACKUP_KEEP_RECENT));
    const buckets = new Set();
    for (const n of names.slice(BACKUP_KEEP_RECENT)) {
      const t = Date.parse(n.slice(0, 24).replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}\.\d{3}Z)$/, '$1:$2:$3'));
      const bucket = Number.isFinite(t) ? Math.floor(t / BACKUP_BUCKET_MS) : n;
      if (!buckets.has(bucket) && keep.size < BACKUP_KEEP_TOTAL) {
        buckets.add(bucket);
        keep.add(n);
      }
    }
    for (const n of names) if (!keep.has(n)) await fsp.rm(path.join(dir, n), { force: true }).catch(() => {});
  }

  async function save(id, body, ifMatch) {
    const wanted = Number(String(ifMatch ?? '').replace(/^W\//, '').replace(/"/g, '').trim());
    if (ifMatch == null || ifMatch === '' || !Number.isInteger(wanted)) throw new HttpError(428, 'If-Match header with the board rev is required');
    return lock(id, async () => {
      const current = await read(id);
      if (current.rev !== wanted) throw new HttpError(409, 'conflict', { current });
      const next = cleanBoard(body, current);
      next.rev = current.rev + 1;
      next.updatedAt = new Date().toISOString();
      await backup(current);
      await writeJsonAtomic(fileOf(id), next);
      return { rev: next.rev, updatedAt: next.updatedAt };
    });
  }

  async function remove(id) {
    return lock(id, async () => {
      const file = fileOf(id);
      await read(id);
      await moveToTrash(path.join(cfg.trash, 'boards'), file, `${id}.json`);
      return { ok: true };
    });
  }

  return { list, create, get: read, save, remove, count: async () => (await all()).length };
}
