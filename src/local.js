// The local media index: what photos/videos live in the workspace, with capture metadata.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic, writeFileAtomic } from './util.js';
import { run } from './tools.js';
import { readImageInfo, exifDateToIso } from './imageinfo.js';
import { isInside } from './security.js';
import { FFMPEG_DEMUXER } from './thumbs.js';

export const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic']);
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);
export const MEDIA_EXT = new Set([...PHOTO_EXT, ...VIDEO_EXT]);
// 3: phone videos' QuickTime dates are UTC (only GoPro writes its local wall clock there).
const INDEX_VERSION = 3;

export function mediaType(file) {
  const ext = path.extname(file).toLowerCase();
  return PHOTO_EXT.has(ext) ? 'photo' : VIDEO_EXT.has(ext) ? 'video' : null;
}

/**
 * "0013_p_doamnei_adv.mp4" → {index: 13, label: "p doamnei adv"}; a name that is only a number
 * ("0013.jpg") keeps its place in a numbered folder: {index: 13, label: "0013"}.
 */
export function labelFor(name) {
  const stem = name.slice(0, name.length - path.extname(name).length);
  const m = /^(\d+)_(.*)$/.exec(stem);
  if (!m && /^\d{1,9}$/.test(stem)) return { index: Number(stem), label: stem };
  const rest = m ? m[2] : stem;
  return { index: m ? Number(m[1]) : null, label: rest.replace(/_+/g, ' ').trim() };
}

// ---- when a video was taken (QuickTime dates) ----

/** GoPro file names, also inside a curated name ("0013_GX010042.MP4"). */
const GOPRO_NAME = /(^|_)(G[HXSLP]\d{6}|GOPR\d{4}|GP\d{6})/i;

/**
 * Is this clip from a GoPro (exiftool row)? ExifTool reports Model, FirmwareVersion and GoProType
 * for GoPro clips but no Make, so several markers are checked.
 */
export function isGoPro(row, name = '') {
  const s = (v) => (v == null ? '' : String(v));
  return (
    /gopro/i.test(s(row.Make)) ||
    /^(HERO|GoPro)/i.test(s(row.Model)) ||
    /^H[DX]?\d/i.test(s(row.FirmwareVersion)) ||
    row.GoProType != null ||
    /gopro/i.test(s(row.HandlerDescription)) ||
    GOPRO_NAME.test(name)
  );
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "2025:08:12 05:30:00+03:00" or "2025-08-12T05:30:00+0300" → ISO with that offset; null without one. */
export function isoWithOffset(value) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*([+-]\d{2}):?(\d{2})$/.exec(String(value || '').trim());
  if (!m || m[1] === '0000' || m[2] === '00') return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}:${m[8]}`;
}

/** A UTC time ("2025:08:12 02:30:00", "2025-08-12T02:30:00.000Z") as this computer's wall clock, with its offset. */
export function utcToLocalIso(value) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value || '').trim());
  if (!m || m[1] === '0000' || m[2] === '00') return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  // QuickTime's "no date" is 1904 (or 1970 after a conversion).
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1971) return null;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(Math.abs(off) / 60))}:${pad2(Math.abs(off) % 60)}`;
}

/**
 * A video's capture time from its QuickTime dates: a creation date with an offset (Keys:CreationDate
 * on iPhones and some Androids) as written; else CreateDate/MediaCreateDate, which a GoPro writes as
 * its local wall clock (kept naive) and phones and most other cameras write as UTC (converted to
 * this computer's local time).
 */
export function quickTimeTaken(creationDate, createDates, gopro) {
  const withOffset = isoWithOffset(creationDate);
  if (withOffset) return withOffset;
  for (const v of createDates) {
    const naive = exifDateToIso(v)?.replace(/([+-]\d{2}:\d{2}|Z)$/, '');
    if (!naive) continue;
    const explicit = isoWithOffset(v);
    if (explicit && !gopro) return explicit;
    return gopro ? naive : utcToLocalIso(v);
  }
  return null;
}

/** Width, height, duration and capture time from `ffprobe -show_format -show_streams` JSON. */
export function ffprobeMeta(j, name = '') {
  const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
  const rot = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((s) => 'rotation' in s)?.rotation ?? 0)) % 180;
  let width = v.width || null;
  let height = v.height || null;
  if (rot === 90) [width, height] = [height, width];
  const tags = Object.fromEntries(Object.entries(j.format?.tags || {}).map(([k, val]) => [k.toLowerCase(), String(val)]));
  const gopro =
    /gopro/i.test(tags.make || tags['com.apple.quicktime.make'] || '') ||
    /^H[DX]?\d/i.test(tags.firmware || '') ||
    (j.streams || []).some((s) => /gopro/i.test(String(s.tags?.handler_name || ''))) ||
    GOPRO_NAME.test(name);
  return {
    width,
    height,
    durationSec: Number(j.format?.duration) || null,
    capturedAt: quickTimeTaken(tags['com.apple.quicktime.creationdate'], [tags.creation_time], gopro),
  };
}

/** Width, height, duration and capture time from an exiftool row (`-n`). */
export function metaFromExif(row, type, name = '') {
  let width = Number(row.ImageWidth) || null;
  let height = Number(row.ImageHeight) || null;
  const orient = Number(row.Orientation);
  const rot = Math.abs(Number(row.Rotation) || 0) % 180;
  if ((type === 'photo' && orient >= 5 && orient <= 8) || (type === 'video' && rot === 90)) [width, height] = [height, width];
  const original = exifDateToIso(row.DateTimeOriginal, row.OffsetTimeOriginal);
  const capturedAt =
    type === 'video'
      ? original || quickTimeTaken(row.CreationDate, [row.CreateDate, row.MediaCreateDate], isGoPro(row, name))
      : // A photo's EXIF CreateDate is its local wall clock, like DateTimeOriginal.
        original || exifDateToIso(row.CreateDate)?.replace(/([+-]\d{2}:\d{2}|Z)$/, '') || null;
  return { width, height, capturedAt: capturedAt || null, durationSec: type === 'video' ? Number(row.Duration) || null : null };
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

async function walk(root, skip, rel = '', out = []) {
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    const abs = path.join(root, r);
    if (e.isDirectory()) {
      if (skip.some((s) => samePath(s, abs))) continue;
      await walk(root, skip, r, out);
    } else if (e.isFile() && MEDIA_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(r);
    }
  }
  return out;
}

export function createLocalIndex(cfg, tools, log = () => {}) {
  const indexFile = path.join(cfg.cache, 'local-index.json');
  let cache = null;
  let running = null;
  let last = null;
  let lastAt = 0;

  async function loadCache() {
    if (cache) return cache;
    const c = await readJson(indexFile, null).catch(() => null);
    cache = c && c.version === INDEX_VERSION && c.entries ? c : { version: INDEX_VERSION, entries: {} };
    return cache;
  }

  /**
   * Display copy for rel → {root, rel} or null. Looks in the display folder, then in
   * .atlas/display (written by `prepare --apply`): same relative path, or same stem as .jpg/.mp4.
   */
  function findDisplay(rel) {
    const roots = [cfg.displayRoot, path.join(cfg.dataDir, 'display')].filter(Boolean);
    const type = mediaType(rel);
    const stem = rel.slice(0, rel.length - path.extname(rel).length);
    const candidates = [rel, `${stem}${type === 'video' ? '.mp4' : '.jpg'}`, `${stem}${path.extname(rel).toUpperCase()}`];
    for (const root of [...new Set(roots)]) {
      for (const c of candidates) {
        const abs = path.resolve(root, c);
        if (!isInside(root, abs)) continue;
        try {
          if (fs.statSync(abs).isFile()) return { root, rel: c };
        } catch {}
      }
    }
    return null;
  }

  async function exifBatch(rels) {
    const out = {};
    if (!tools.exiftool || !rels.length) return out;
    for (let i = 0; i < rels.length; i += 100) {
      const batch = rels.slice(i, i + 100);
      const argFile = path.join(cfg.cache, `exif-args-${process.pid}.txt`);
      await writeFileAtomic(argFile, batch.map((r) => path.join(cfg.workspace, r)).join('\n') + '\n');
      const r = await run(tools.exiftool, [
        '-json', '-n', '-charset', 'filename=utf8', '-api', 'LargeFileSupport=1',
        '-DateTimeOriginal', '-OffsetTimeOriginal', '-CreateDate', '-MediaCreateDate', '-CreationDate',
        '-Make', '-Model', '-FirmwareVersion', '-GoProType', '-HandlerDescription',
        '-ImageWidth', '-ImageHeight', '-Orientation', '-Rotation', '-Duration',
        '-@', argFile,
      ], { timeout: 180_000 });
      await fsp.rm(argFile, { force: true });
      let rows = [];
      try {
        rows = JSON.parse(r.stdout.toString('utf8') || '[]');
      } catch {
        log(`exiftool output unreadable (${r.stderr.slice(0, 200)})`);
      }
      for (const row of rows) {
        const rel = path.relative(cfg.workspace, path.resolve(String(row.SourceFile))).split(path.sep).join('/');
        out[rel] = row;
      }
    }
    return out;
  }

  async function ffprobeInfo(abs) {
    if (!tools.ffprobe) return {};
    const demuxer = FFMPEG_DEMUXER[path.extname(abs).toLowerCase()];
    if (!demuxer) return {};
    const r = await run(tools.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-f', demuxer, '-print_format', 'json', '-show_format', '-show_streams', abs], { timeout: 30_000 });
    if (!r.ok) return {};
    try {
      return ffprobeMeta(JSON.parse(r.stdout.toString('utf8')), path.basename(abs));
    } catch {
      return {};
    }
  }

  async function basicMeta(abs, type) {
    if (type === 'video') return ffprobeInfo(abs);
    const info = await readImageInfo(abs);
    return {
      width: info.width || null,
      height: info.height || null,
      capturedAt: exifDateToIso(info.dateTimeOriginal, info.offsetTimeOriginal) || exifDateToIso(info.dateTime),
      durationSec: null,
    };
  }

  async function build() {
    const c = await loadCache();
    const skip = [cfg.dataDir, cfg.displayRoot].filter(Boolean).map((p) => path.resolve(p));
    const rels = (await walk(cfg.workspace, skip)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const stats = {};
    await Promise.all(rels.map(async (r) => {
      try { stats[r] = await fsp.stat(path.join(cfg.workspace, r)); } catch {}
    }));
    const wantSource = tools.exiftool ? 'exiftool' : 'basic';
    const stale = rels.filter((r) => {
      const e = c.entries[r];
      const s = stats[r];
      return s && (!e || e.size !== s.size || e.mtimeMs !== Math.floor(s.mtimeMs) || (e.source !== wantSource && wantSource === 'exiftool'));
    });
    if (stale.length) {
      log(`indexing ${stale.length} file(s)${tools.exiftool ? ' with exiftool' : ''}…`);
      const exif = await exifBatch(stale);
      for (const r of stale) {
        const s = stats[r];
        const type = mediaType(r);
        let meta;
        let source = 'basic';
        if (exif[r]) {
          meta = metaFromExif(exif[r], type, r.split('/').pop());
          source = 'exiftool';
          if (type === 'video' && (!meta.durationSec || !meta.width)) {
            const p = await ffprobeInfo(path.join(cfg.workspace, r));
            meta = { ...p, ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null)) };
          }
        } else {
          meta = await basicMeta(path.join(cfg.workspace, r), type);
        }
        c.entries[r] = { size: s.size, mtimeMs: Math.floor(s.mtimeMs), source, meta };
      }
    }
    let removed = false;
    for (const r of Object.keys(c.entries)) if (!stats[r]) { delete c.entries[r]; removed = true; }
    if (stale.length || removed) await writeJsonAtomic(indexFile, c).catch((e) => log(`could not write index: ${e.message}`));

    const items = rels.filter((r) => stats[r]).map((r) => {
      const e = c.entries[r];
      const name = r.split('/').pop();
      const { index, label } = labelFor(name);
      return {
        path: r,
        name,
        label,
        index,
        type: mediaType(r),
        size: e.size,
        mtime: new Date(e.mtimeMs).toISOString(),
        capturedAt: e.meta.capturedAt || null,
        width: e.meta.width || null,
        height: e.meta.height || null,
        durationSec: e.meta.durationSec || null,
        hasDisplay: Boolean(findDisplay(r)),
      };
    });
    return items;
  }

  /** Re-scan at most every 2 s; concurrent callers share one run. */
  async function list() {
    if (last && Date.now() - lastAt < 2000) return last;
    if (!running) {
      running = build().then((items) => { last = items; lastAt = Date.now(); return items; }).finally(() => { running = null; });
    }
    return running;
  }

  /** Last known count without waiting for a scan (starts one in the background). */
  function peekCount() {
    if (!last && !running) list().catch(() => {});
    return last ? last.length : null;
  }

  return { list, findDisplay, peekCount, invalidate: () => { lastAt = 0; } };
}
