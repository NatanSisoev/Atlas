// Cached JPEG thumbnails via ImageMagick (photos, PDFs) and ffmpeg (videos), with placeholders.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, heavy } from './tools.js';
import { clamp } from './util.js';

const BROWSER_IMAGES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

export function thumbWidth(raw, lo = 64, hi = 1200, dflt = 400) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.round(clamp(n, lo, hi) / 8) * 8;
}

export function placeholderSvg(kind = 'file', label = '') {
  const icons = {
    photo: '<path d="M30 70l18-22 14 16 10-12 18 18z" fill="#c9b79c"/><circle cx="66" cy="40" r="7" fill="#c9b79c"/>',
    video: '<path d="M42 32v36l30-18z" fill="#c9b79c"/>',
    pdf: '<text x="50" y="58" font-size="20" text-anchor="middle" fill="#b0503d" font-family="sans-serif" font-weight="700">PDF</text>',
    file: '<path d="M36 24h20l12 12v40H36z" fill="none" stroke="#c9b79c" stroke-width="4"/>',
  };
  const text = label ? `<text x="50" y="92" font-size="7" text-anchor="middle" fill="#9c8a70" font-family="sans-serif">${escapeXml(label.slice(0, 28))}</text>` : '';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="400" height="400"><rect width="100" height="100" fill="#efe6d6"/>${icons[kind] || icons.file}${text}</svg>`);
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function createThumbs(cfg, tools, log = () => {}) {
  const inflight = new Map();

  async function generate(src, kind, w, dest) {
    const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.tmp.jpg`;
    let ok = false;
    if (kind === 'video' && tools.ffmpeg) {
      for (const ss of ['1', '0']) {
        const r = await run(tools.ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-y', '-ss', ss, '-i', src,
          '-frames:v', '1', '-vf', `scale='min(${w},iw)':-2`, '-q:v', '4', '-f', 'image2', tmp,
        ], { timeout: 60_000 });
        if (r.ok && (await fsp.stat(tmp).then((s) => s.size > 0, () => false))) { ok = true; break; }
      }
    } else if ((kind === 'photo' || kind === 'pdf') && tools.magick) {
      const input = kind === 'pdf' ? ['-density', '96', `${src}[0]`, '-background', 'white', '-flatten'] : [`${src}[0]`, '-auto-orient'];
      const r = await run(tools.magick.cmd, [
        ...tools.magick.prefix, ...input,
        '-thumbnail', `${w}x${w * 3}>`, '-strip', '-quality', '82', '-interlace', 'JPEG', `jpg:${tmp}`,
      ], { timeout: 90_000 });
      ok = r.ok && (await fsp.stat(tmp).then((s) => s.size > 0, () => false));
      if (!r.ok) log(`thumbnail failed for ${path.basename(src)}: ${r.stderr.split('\n')[0].slice(0, 160)}`);
    }
    if (!ok) {
      await fsp.rm(tmp, { force: true });
      return false;
    }
    await fsp.rename(tmp, dest);
    return true;
  }

  /**
   * Resolve a thumbnail for src. Returns {file, mime} for a cached JPEG, {file, mime, raw:true}
   * when the source image itself should be served, or {svg} for a placeholder.
   */
  async function get(src, kind, w) {
    let st;
    try {
      st = await fsp.stat(src);
    } catch {
      return { svg: placeholderSvg(kind) };
    }
    const ext = path.extname(src).toLowerCase();
    const canGenerate = kind === 'video' ? tools.ffmpeg : tools.magick;
    if (!canGenerate) {
      if (kind === 'photo' && BROWSER_IMAGES.has(ext)) return { file: src, raw: true };
      return { svg: placeholderSvg(kind) };
    }
    const key = crypto.createHash('sha1').update(`${src}\0${st.size}\0${st.mtimeMs}\0${w}\0v1`).digest('hex');
    const dest = path.join(cfg.thumbs, key.slice(0, 2), `${key}.jpg`);
    try {
      await fsp.access(dest);
      return { file: dest, mime: 'image/jpeg' };
    } catch {}
    const failMark = `${dest}.failed`;
    if (await fsp.access(failMark).then(() => true, () => false)) {
      return kind === 'photo' && BROWSER_IMAGES.has(ext) ? { file: src, raw: true } : { svg: placeholderSvg(kind) };
    }
    if (!inflight.has(key)) {
      inflight.set(key, (async () => {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const ok = await heavy(() => generate(src, kind, w, dest));
        if (!ok) await fsp.writeFile(failMark, '').catch(() => {});
        return ok;
      })().finally(() => inflight.delete(key)));
    }
    const ok = await inflight.get(key);
    if (ok) return { file: dest, mime: 'image/jpeg' };
    return kind === 'photo' && BROWSER_IMAGES.has(ext) ? { file: src, raw: true } : { svg: placeholderSvg(kind) };
  }

  return { get };
}
