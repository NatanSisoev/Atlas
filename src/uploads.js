// Files added through the app: streamed to disk while hashing, stored content-addressed.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { HttpError, MIME } from './util.js';

export const MAX_UPLOAD = 300 * 1024 * 1024;
const ID_RE = /^[a-f0-9]{16}$/;
// Never served inline: the browser would run them on our origin.
const ACTIVE_EXT = new Set(['.html', '.htm', '.xhtml', '.xht', '.js', '.mjs', '.xml', '.xsl', '.svgz', '.shtml', '.php', '.wasm']);
const INLINE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.heic', '.mp4', '.m4v', '.mov', '.webm', '.mp3', '.m4a', '.wav', '.ogg', '.pdf', '.txt', '.md', '.csv', '.json', '.svg']);

export function cleanName(raw) {
  let name = '';
  try {
    name = decodeURIComponent(String(raw || ''));
  } catch {
    name = String(raw || '');
  }
  name = name.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').trim().slice(0, 180);
  return name && !/^\.+$/.test(name) ? name : 'file';
}

export function extOf(name) {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

/** How a stored upload must be served: {mime, inline, csp}. */
export function servePolicy(ext) {
  if (ACTIVE_EXT.has(ext)) return { mime: 'application/octet-stream', inline: false };
  if (ext === '.svg') return { mime: 'image/svg+xml', inline: true, csp: "sandbox; default-src 'none'; style-src 'unsafe-inline'" };
  if (INLINE_EXT.has(ext) && MIME[ext]) return { mime: MIME[ext], inline: true };
  return { mime: 'application/octet-stream', inline: false };
}

export function kindOf(ext) {
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.heic'].includes(ext)) return 'photo';
  if (['.mp4', '.m4v', '.mov', '.webm'].includes(ext)) return 'video';
  if (ext === '.pdf') return 'pdf';
  return 'file';
}

export function createUploads(cfg) {
  const byId = new Map(); // id -> filename

  async function scan() {
    byId.clear();
    for (const n of await fsp.readdir(cfg.uploads).catch(() => [])) {
      const m = /^([a-f0-9]{16})(\.[a-z0-9]{1,8})?$/.exec(n);
      if (m) byId.set(m[1], n);
    }
  }

  async function save(req) {
    const name = cleanName(req.headers['x-filename']);
    const ext = extOf(name);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD) throw new HttpError(413, 'file too large (max 300 MB)');
    await fsp.mkdir(cfg.uploads, { recursive: true });
    const tmp = path.join(cfg.uploads, `.incoming-${crypto.randomBytes(6).toString('hex')}`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > MAX_UPLOAD) return cb(new HttpError(413, 'file too large (max 300 MB)'));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, meter, fs.createWriteStream(tmp, { flags: 'wx' }));
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'upload interrupted');
    }
    if (size === 0) {
      await fsp.rm(tmp, { force: true });
      throw new HttpError(400, 'empty file');
    }
    const id = hash.digest('hex').slice(0, 16);
    const stored = `${id}${ext}`;
    const dest = path.join(cfg.uploads, stored);
    if (byId.has(id) || fs.existsSync(dest)) await fsp.rm(tmp, { force: true });
    else await fsp.rename(tmp, dest);
    if (!byId.has(id)) byId.set(id, stored);
    const policy = servePolicy(extOf(byId.get(id)));
    return {
      id,
      name,
      mime: policy.mime,
      kind: kindOf(extOf(byId.get(id))),
      size,
      url: `/media/uploads/${id}`,
      thumbUrl: `/media/uploads/${id}/thumb?w=400`,
    };
  }

  function locate(id) {
    if (!ID_RE.test(id)) throw new HttpError(404, 'not found');
    const n = byId.get(id);
    if (!n) throw new HttpError(404, 'not found');
    const ext = extOf(n);
    return { file: path.join(cfg.uploads, n), ext, ...servePolicy(ext), kind: kindOf(ext) };
  }

  return { scan, save, locate, count: () => byId.size };
}
