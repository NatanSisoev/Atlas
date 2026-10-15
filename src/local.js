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
const INDEX_VERSION = 2;

export function mediaType(file) {
  const ext = path.extname(file).toLowerCase();
  return PHOTO_EXT.has(ext) ? 'photo' : VIDEO_EXT.has(ext) ? 'video' : null;
}

/** "0013_p_doamnei_adv.mp4" → {index: 13, label: "p doamnei adv"} */
export function labelFor(name) {
  const stem = name.slice(0, name.length - path.extname(name).length);
  const m = /^(\d+)_(.*)$/.exec(stem);
  const rest = m ? m[2] : stem;
  return { index: m ? Number(m[1]) : null, label: rest.replace(/_+/g, ' ').trim() };
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
   * .corkboard/display (written by `prepare --apply`): same relative path, or same stem as .jpg/.mp4.
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
        '-DateTimeOriginal', '-OffsetTimeOriginal', '-CreateDate', '-MediaCreateDate',
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
      const j = JSON.parse(r.stdout.toString('utf8'));
      const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
      const rot = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((s) => 'rotation' in s)?.rotation ?? 0)) % 180;
      let width = v.width || null;
      let height = v.height || null;
      if (rot === 90) [width, height] = [height, width];
      const ct = j.format?.tags?.creation_time;
      return {
        width, height,
        durationSec: Number(j.format?.duration) || null,
        capturedAt: ct ? String(ct).replace(/\.\d+Z$/, '').replace(/Z$/, '') : null,
      };
    } catch {
      return {};
    }
  }

  function metaFromExif(row, type) {
    let width = Number(row.ImageWidth) || null;
    let height = Number(row.ImageHeight) || null;
    const orient = Number(row.Orientation);
    const rot = Math.abs(Number(row.Rotation) || 0) % 180;
    if ((type === 'photo' && orient >= 5 && orient <= 8) || (type === 'video' && rot === 90)) [width, height] = [height, width];
    // QuickTime dates: GoPro cameras write local time there, so keep them as naive local times.
    const capturedAt =
      exifDateToIso(row.DateTimeOriginal, row.OffsetTimeOriginal) ||
      exifDateToIso(row.CreateDate)?.replace(/([+-]\d{2}:\d{2}|Z)$/, '') ||
      exifDateToIso(row.MediaCreateDate)?.replace(/([+-]\d{2}:\d{2}|Z)$/, '') ||
      null;
    return { width, height, capturedAt, durationSec: type === 'video' ? Number(row.Duration) || null : null };
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
          meta = metaFromExif(exif[r], type);
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
