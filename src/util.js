// Small shared helpers: HTTP responses, bodies, atomic JSON files, file serving.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export function sendJson(res, status, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(res.req?.method === 'HEAD' ? undefined : body);
}

export function sendError(res, status, message, extra) {
  if (res.headersSent) { res.destroy(); return; }
  // After refusing a body we have not read, close the connection instead of draining it.
  const close = status === 413 || (res.req && !res.req.complete);
  sendJson(res, status, { error: message, ...(extra || {}) }, close ? { Connection: 'close' } : {});
}

export function redirect(res, url, cacheSeconds = 0) {
  res.writeHead(302, {
    Location: url,
    'Cache-Control': cacheSeconds > 0 ? `private, max-age=${cacheSeconds}` : 'no-store',
    'Content-Length': 0,
  });
  res.end();
}

export async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'body too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req, limit = 5 * 1024 * 1024) {
  const type = String(req.headers['content-type'] || '');
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'expected application/json');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && (err.code === 'ENOENT' || err instanceof SyntaxError)) return fallback;
    throw err;
  }
}

// Windows can briefly refuse a rename while an antivirus or indexer holds the file.
async function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (i >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 30 * 2 ** i));
    }
  }
}

/** Write a file atomically: temp file in the same folder, fsync, rename over the target. */
export async function writeFileAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

export function writeJsonAtomic(file, obj) {
  return writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

export async function moveToTrash(trashDir, file, name) {
  await fsp.mkdir(trashDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(trashDir, `${stamp}_${name}`);
  await renameWithRetry(file, dest);
  return dest;
}

/** Simple promise chain per key, so read-modify-write sequences never interleave. */
export function keyedLock() {
  const tails = new Map();
  return async function withLock(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    let release;
    const next = new Promise((r) => (release = r));
    const tail = prev.then(() => next);
    tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

/** Concurrency limiter: limit(fn) runs at most n fns at once. */
export function limiter(n) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < n && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); });
    }
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // ignore multi-range / malformed: send whole file
  let start, end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

export function contentDisposition(type, filename) {
  const safe = String(filename || 'file').replace(/[\r\n"\\]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * Stream a file with Range support.
 * opts: {mime, cache: 'immutable'|'short'|'none'|'revalidate', download, filename, headers}
 */
export async function sendFile(req, res, file, opts = {}) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'not found');
  }
  if (!st.isFile()) throw new HttpError(404, 'not found');
  const size = st.size;
  const etag = `W/"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': opts.mime || mimeFor(file),
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
    ETag: etag,
    ...(opts.headers || {}),
  };
  headers['Cache-Control'] = {
    immutable: 'private, max-age=31536000, immutable',
    short: 'private, max-age=3600',
    none: 'no-store',
    revalidate: 'no-cache',
  }[opts.cache || 'revalidate'];
  if (opts.download) headers['Content-Disposition'] = contentDisposition('attachment', opts.filename || path.basename(file));
  else if (opts.filename) headers['Content-Disposition'] = contentDisposition('inline', opts.filename);

  if (req.headers['if-none-match'] === etag && !req.headers.range) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  let status = 200;
  let start = 0;
  let end = size - 1;
  if (req.headers.range) {
    const r = parseRange(req.headers.range, size);
    if (r === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
      res.end();
      return;
    }
    if (r) {
      status = 206;
      ({ start, end } = r);
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }
  await new Promise((resolve) => {
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => { res.destroy(); resolve(); });
    res.on('close', () => { stream.destroy(); resolve(); });
    stream.pipe(res);
  });
}

export function sendBuffer(req, res, buf, mime, cache = 'revalidate', extra = {}) {
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': buf.length,
    'Cache-Control': cache === 'immutable' ? 'private, max-age=31536000, immutable' : cache === 'none' ? 'no-store' : 'no-cache',
    ...extra,
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
