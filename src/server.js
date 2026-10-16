// HTTP server: routing, guards, logging.
import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, sendJson, sendError, sendFile, sendBuffer, readJsonBody, redirect, mimeFor } from './util.js';
import { hostAllowed, checkCsrf, checkFetchMetadata, decodeRelPath, resolveInside, SECURITY_HEADERS, APP_CSP } from './security.js';
import { publicSettings, updateSettings, DEFAULT_WEB_DIST } from './config.js';
import { createBoards } from './boards.js';
import { createLocalIndex, mediaType } from './local.js';
import { createThumbs, thumbWidth, placeholderSvg } from './thumbs.js';
import { createGoPro, thumbUrl, TOKEN_RE, MEDIUM_RE } from './gopro.js';
import { createUploads } from './uploads.js';
import { toolSummary } from './tools.js';
import { createStory, SCHEMA_VERSION } from './story.js';

// The old canvas app, served under /board/ until the book can edit (M3).
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
export const VERSION = '0.1.0';

// Files of the built web client that must be revalidated on every load (everything under
// /assets/ is content-hashed and cached for a year).
const WEB_NO_CACHE = new Set(['index.html', 'sw.js', 'registerSW.js', 'manifest.webmanifest']);

/** Shown at / when web/dist has not been built. Static, no script (CSP script-src 'self'). */
const BUILD_HINT = Buffer.from(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Atlas</title>
<style>
  body { margin: 0; font: 17px/1.5 system-ui, sans-serif; background: #f7f6f2; color: #191918; }
  main { max-width: 34rem; margin: 18vh auto 0; padding: 0 24px; }
  h1 { font-weight: 600; font-size: 28px; margin: 0 0 12px; }
  pre { background: rgba(25, 25, 24, .06); padding: 12px 16px; border-radius: 8px; }
  a { color: inherit; }
  @media (prefers-color-scheme: dark) { body { background: #0e0e0d; color: #ecebe7; } pre { background: rgba(236, 235, 231, .08); } }
</style>
</head>
<body>
<main>
  <h1>Atlas is not built yet</h1>
  <p>The web app in <code>web/</code> has not been built. In the Atlas folder run:</p>
  <pre>npm install
npm run build</pre>
  <p>then reload this page. The old board still works at <a href="/board/">/board/</a>.</p>
</main>
</body>
</html>
`);

export async function createApp(cfg, tools, { log = console.log, fetchImpl } = {}) {
  const boards = createBoards(cfg, log);
  const local = createLocalIndex(cfg, tools, log);
  const thumbs = createThumbs(cfg, tools, log);
  const gopro = createGoPro(cfg, { fetchImpl: fetchImpl || globalThis.fetch, log });
  const uploads = createUploads(cfg);
  const story = createStory(cfg, local);
  const webDist = path.resolve(cfg.webDist || DEFAULT_WEB_DIST);
  await uploads.scan();

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---- API ----
  route('GET', /^\/api\/health$/, async (req, res) => {
    // Never wait for a first full media scan here (it can take a while on big folders).
    let localCount = local.peekCount();
    if (localCount == null) localCount = await Promise.race([local.list().then((i) => i.length), new Promise((r) => setTimeout(() => r(null), 1500))]);
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      schemaVersion: SCHEMA_VERSION,
      workspace: { title: cfg.settings.title },
      counts: { local: localCount, boards: await boards.count(), goproLinks: await gopro.count() },
      tools: toolSummary(tools),
    });
  });

  // ---- the book (read-only in M1) ----
  route('GET', /^\/api\/atlas$/, async (req, res) => sendJson(res, 200, await story.atlas()));
  route('GET', /^\/api\/chapters\/([^/]+)$/, async (req, res, m) => {
    let id;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      throw new HttpError(404, 'chapter not found');
    }
    const out = await story.chapter(id);
    if (!out) throw new HttpError(404, 'chapter not found');
    sendJson(res, 200, out);
  });

  route('GET', /^\/api\/settings$/, async (req, res) => sendJson(res, 200, publicSettings(cfg)));
  route('PUT', /^\/api\/settings$/, async (req, res) => {
    const out = await updateSettings(cfg, await readJsonBody(req));
    local.invalidate();
    sendJson(res, 200, out);
  });

  route('GET', /^\/api\/boards$/, async (req, res) => sendJson(res, 200, await boards.list()));
  route('POST', /^\/api\/boards$/, async (req, res) => {
    const body = await readJsonBody(req);
    sendJson(res, 201, await boards.create(body.title));
  });
  route('GET', /^\/api\/boards\/([^/]+)$/, async (req, res, m) => sendJson(res, 200, await boards.get(m[1])));
  route('PUT', /^\/api\/boards\/([^/]+)$/, async (req, res, m) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, await boards.save(m[1], body, req.headers['if-match']));
  });
  route('DELETE', /^\/api\/boards\/([^/]+)$/, async (req, res, m) => sendJson(res, 200, await boards.remove(m[1])));

  route('GET', /^\/api\/local$/, async (req, res) => sendJson(res, 200, { items: await local.list() }));

  route('GET', /^\/api\/gopro\/links$/, async (req, res) => sendJson(res, 200, await gopro.list()));
  route('POST', /^\/api\/gopro\/links$/, async (req, res) => {
    const body = await readJsonBody(req, 64 * 1024);
    sendJson(res, 201, await gopro.add(body.url));
  });
  route('POST', /^\/api\/gopro\/links\/([^/]+)\/refresh$/, async (req, res, m) => sendJson(res, 200, await gopro.refresh(m[1])));
  route('DELETE', /^\/api\/gopro\/links\/([^/]+)$/, async (req, res, m) => sendJson(res, 200, await gopro.remove(m[1])));
  route('GET', /^\/api\/gopro\/links\/([^/]+)\/items$/, async (req, res, m) => sendJson(res, 200, await gopro.items(m[1])));

  route('POST', /^\/api\/uploads$/, async (req, res) => sendJson(res, 201, await uploads.save(req)));

  // ---- media ----
  async function localFile(raw, preferDisplay) {
    const rel = decodeRelPath(raw);
    const type = mediaType(rel);
    if (!type) throw new HttpError(404, 'not found');
    const original = await resolveInside(cfg.workspace, rel);
    if (path.resolve(original).startsWith(path.resolve(cfg.dataDir) + path.sep)) throw new HttpError(404, 'not found');
    if (preferDisplay) {
      const disp = local.findDisplay(rel);
      if (disp) return { file: await resolveInside(disp.root, disp.rel), type, rel };
    }
    return { file: original, type, rel };
  }

  route('GET', /^\/media\/local\/thumb\/(.+)$/, async (req, res, m, url) => {
    const { file, type } = await localFile(m[1], true);
    const w = thumbWidth(url.searchParams.get('w'));
    const t = await thumbs.get(file, type, w);
    const cache = url.searchParams.has('v') ? 'immutable' : 'revalidate';
    if (t.svg) return sendBuffer(req, res, t.svg, 'image/svg+xml', 'none', { 'Content-Security-Policy': 'sandbox' });
    await sendFile(req, res, t.file, { mime: t.mime || mimeFor(t.file), cache: t.raw ? 'revalidate' : cache });
  });
  route('GET', /^\/media\/local\/display\/(.+)$/, async (req, res, m) => {
    const { file } = await localFile(m[1], true);
    await sendFile(req, res, file, { cache: 'revalidate' });
  });
  route('GET', /^\/media\/local\/original\/(.+)$/, async (req, res, m, url) => {
    const { file } = await localFile(m[1], false);
    await sendFile(req, res, file, { cache: 'revalidate', download: url.searchParams.get('download') === '1' });
  });

  route('GET', /^\/media\/gopro\/thumb\/([^/]+)$/, async (req, res, m, url) => {
    const token = decodeURIComponent(m[1]);
    if (!TOKEN_RE.test(token)) throw new HttpError(404, 'not found');
    redirect(res, thumbUrl(token, thumbWidth(url.searchParams.get('w'), 100, 2560, 450, null)), 86400);
  });
  route('GET', /^\/media\/gopro\/play\/([^/]+)$/, async (req, res, m, url) => {
    if (!MEDIUM_RE.test(m[1])) throw new HttpError(404, 'not found');
    const target = await gopro.playUrl(m[1]);
    // GoPro's CDN labels videos binary/octet-stream; ?via=server streams through us as video/mp4
    // for players (iOS Safari) that refuse that.
    if (url.searchParams.get('via') === 'server') return proxyVideo(req, res, target);
    redirect(res, target);
  });
  route('GET', /^\/media\/gopro\/original\/([^/]+)$/, async (req, res, m) => {
    if (!MEDIUM_RE.test(m[1])) throw new HttpError(404, 'not found');
    redirect(res, await gopro.sourceUrl(m[1]));
  });

  route('GET', /^\/media\/uploads\/([^/]+)\/thumb$/, async (req, res, m, url) => {
    const u = uploads.locate(m[1]);
    const kind = u.kind === 'pdf' ? 'pdf' : u.kind;
    if (!['photo', 'video', 'pdf'].includes(kind) || u.ext === '.svg') {
      return sendBuffer(req, res, placeholderSvg(kind), 'image/svg+xml', 'none', { 'Content-Security-Policy': 'sandbox' });
    }
    const t = await thumbs.get(u.file, kind, thumbWidth(url.searchParams.get('w')));
    if (t.svg) return sendBuffer(req, res, t.svg, 'image/svg+xml', 'none', { 'Content-Security-Policy': 'sandbox' });
    await sendFile(req, res, t.file, { mime: t.raw ? u.mime : t.mime, cache: 'immutable' });
  });
  route('GET', /^\/media\/uploads\/([^/]+)$/, async (req, res, m, url) => {
    const u = uploads.locate(m[1]);
    const name = url.searchParams.get('name');
    const download = url.searchParams.get('download') === '1' || !u.inline;
    await sendFile(req, res, u.file, {
      mime: u.mime,
      cache: 'immutable',
      download,
      filename: name ? name.replace(/[\\/]/g, '_').slice(0, 180) : `${m[1]}${u.ext}`,
      headers: u.csp ? { 'Content-Security-Policy': u.csp } : {},
    });
  });

  async function proxyVideo(req, res, target) {
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const headers = {};
    if (req.headers.range) headers.Range = String(req.headers.range);
    let up;
    try {
      up = await (fetchImpl || globalThis.fetch)(target, { headers, signal: ac.signal, method: req.method === 'HEAD' ? 'HEAD' : 'GET' });
    } catch {
      throw new HttpError(502, 'GoPro video is not reachable');
    }
    if (![200, 206, 416].includes(up.status)) throw new HttpError(502, `GoPro answered ${up.status}`);
    const out = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    for (const h of ['content-length', 'content-range']) {
      const v = up.headers.get(h);
      if (v) out[h.replace(/(^|-)\w/g, (c) => c.toUpperCase())] = v;
    }
    res.writeHead(up.status, out);
    if (!up.body || req.method === 'HEAD') return res.end();
    await pipeline(Readable.fromWeb(up.body), res).catch(() => {});
  }

  // ---- static: the old board under /board/, the web client (web/dist) everywhere else ----
  async function serveBoard(req, res, pathname, url) {
    if (pathname === '/board') return redirect(res, `/board/${url.search}`, 3600, 301);
    const rel = pathname === '/board/' ? 'index.html' : pathname.slice('/board/'.length);
    let file;
    try {
      file = await resolveInside(PUBLIC, decodeRelPath(rel));
    } catch {
      throw new HttpError(404, 'not found');
    }
    await sendFile(req, res, file, {
      cache: 'revalidate',
      headers: file.endsWith('.html') ? { 'Content-Security-Policy': APP_CSP } : {},
    });
  }

  async function isFile(file) {
    return fsp.stat(file).then((st) => st.isFile(), () => false);
  }

  async function sendWebIndex(req, res) {
    const index = path.join(webDist, 'index.html');
    if (!(await isFile(index))) {
      return sendBuffer(req, res, BUILD_HINT, 'text/html; charset=utf-8', 'none', { 'Content-Security-Policy': APP_CSP }, 503);
    }
    await sendFile(req, res, index, { cache: 'revalidate', headers: { 'Content-Security-Policy': APP_CSP } });
  }

  async function serveWeb(req, res, pathname) {
    // Client routes. /c/... always gets the app shell: item ids contain file names with dots.
    if (pathname === '/' || pathname === '/index.html' || pathname === '/c' || pathname.startsWith('/c/')) return sendWebIndex(req, res);
    let rel = null;
    let file = null;
    try {
      rel = decodeRelPath(pathname.slice(1));
      file = await resolveInside(webDist, rel);
    } catch {}
    if (file && (await isFile(file))) {
      const html = file.endsWith('.html');
      return sendFile(req, res, file, {
        cache: rel.startsWith('assets/') && !WEB_NO_CACHE.has(path.posix.basename(rel)) ? 'immutable' : 'revalidate',
        headers: html ? { 'Content-Security-Policy': APP_CSP } : {},
      });
    }
    // SPA fallback: an extension-less path is a client route; a missing file is a 404.
    const last = pathname.slice(pathname.lastIndexOf('/') + 1);
    if (!path.posix.extname(last)) return sendWebIndex(req, res);
    throw new HttpError(404, 'not found');
  }

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (!hostAllowed(req.headers.host, cfg)) throw new HttpError(403, 'forbidden host');
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      throw new HttpError(400, 'bad url');
    }
    const pathname = url.pathname;
    const isApi = pathname.startsWith('/api/');
    const isMedia = pathname.startsWith('/media/');
    if (isApi) res.setHeader('Cache-Control', 'no-store');
    if (isMedia) res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if ((isApi || isMedia) && (req.method === 'GET' || req.method === 'HEAD')) checkFetchMetadata(req);
    checkCsrf(req, cfg);
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      return r.handler(req, res, m, url);
    }
    if (pathMatched) throw new HttpError(405, 'method not allowed');
    if (isApi || isMedia) throw new HttpError(404, 'not found');
    if (method !== 'GET') throw new HttpError(405, 'method not allowed');
    if (pathname === '/board' || pathname.startsWith('/board/')) return serveBoard(req, res, pathname, url);
    return serveWeb(req, res, pathname);
  }

  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    res.on('finish', () => {
      const p = String(req.url).split('?')[0];
      log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${p.length > 120 ? p.slice(0, 117) + '…' : p} ${res.statusCode} ${Date.now() - t0}ms`);
    });
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) return sendError(res, err.status, err.message, err.extra);
      log(`error: ${err && err.stack ? err.stack : err}`);
      sendError(res, 500, 'internal error');
    });
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.requestTimeout = 0; // long uploads and video streams
  server.headersTimeout = 30_000;

  return { server, boards, local, gopro, uploads };
}
