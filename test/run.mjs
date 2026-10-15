// node test/run.mjs — starts the server on generated fixtures and checks the API end to end.
// With GOPRO_TEST_LINK set, also exercises a real GoPro share link (read-only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, makePng, makePdf } from './fixtures.mjs';
import { parseShareLink, imageHost, mapItem, pickPlayable } from '../src/gopro.js';
import { decodeRelPath, hostAllowed } from '../src/security.js';
import { labelFor } from '../src/local.js';
import { parseImageInfo, exifDateToIso } from '../src/imageinfo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
let current = '';

async function test(name, fn) {
  current = name;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL  ${name}\n        ${String(err && err.message).split('\n').join('\n        ')}`);
  }
}
const skip = (name, why) => { results.push({ name, ok: true, skipped: true }); console.log(`  SKIP  ${name} (${why})`); };

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Raw HTTP so paths are sent exactly as written (fetch would normalise `..`). */
function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (method !== 'GET' && method !== 'HEAD' && !('X-Requested-With' in h) && !h.__noCsrf) h['X-Requested-With'] = 'corkboard';
    delete h.__noCsrf;
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    if (data && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (data && !('Content-Length' in h)) h['Content-Length'] = data.length;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function startServer(ws, env = {}) {
  const port = await freePort();
  const childEnv = { ...process.env, ...env };
  if (childEnv.HTTPS_PROXY && !childEnv.NODE_USE_ENV_PROXY) childEnv.NODE_USE_ENV_PROXY = '1';
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'corkboard.js'), 'serve', ws, '--port', String(port)], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (log.includes('open http')) break;
    if (child.exitCode != null) throw new Error(`server exited:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!log.includes('open http')) throw new Error(`server did not start:\n${log}`);
  return { port, child, log: () => log, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }) };
}

// ---------------------------------------------------------------- unit
async function unitTests() {
  console.log('\nunit');
  await test('GoPro share link parsing', () => {
    const id = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
    for (const s of [
      `https://gopro.com/v/${id}`, `https://gopro.com/v/${id}/`, `https://gopro.com/v/${id}?foo=bar#x`,
      `http://www.gopro.com/v/${id}`, `gopro.com/v/${id}`, ` ${id} `, id.toUpperCase(), `https://GoPro.com/v/${id.toUpperCase()}`,
    ]) assert.equal(parseShareLink(s), id, s);
    for (const s of ['', 'nope', `https://evil.com/v/${id}`, `https://gopro.com.evil.com/v/${id}`, `https://gopro.com/x/${id}`,
      `javascript:alert(1)//gopro.com/v/${id}`, `https://gopro.com/v/${id}/extra`, 'https://gopro.com/v/1234']) assert.equal(parseShareLink(s), null, s);
  });
  await test('GoPro image host is stable and in 1..4', () => {
    const h = imageHost('abc.def-ghi');
    assert.match(h, /^https:\/\/images-0[1-4]\.gopro\.com$/);
    assert.equal(h, imageHost('abc.def-ghi'));
  });
  await test('GoPro item mapping and stream choice', () => {
    const m = mapItem({ medium: { id: '6a7cbf1e399618aae5e3c796', filename: 'GX010701.MP4', type: 'Video', captured_at: '2026-08-12T07:52:41Z', captured_at_timezone: '+03:00', width: 3840, height: 2160, file_size: 7871647755, token: 'aa.bb.cc', source_duration: '3337' } });
    assert.equal(m.durationSec, 3.3);
    assert.equal(m.tz, '+03:00');
    assert.equal(mapItem({ medium: { id: '../../x' } }), null);
    const dl = { _embedded: { files: [{ url: 'https://cdn/x1080.mp4', width: 1920, height: 1080, video_codec: 'h264', available: true }], variations: [{ label: 'source', url: 'https://cdn/src.mp4', available: true }, { label: 'edit_proxy', url: 'https://cdn/720.mp4', available: true }] } };
    assert.equal(pickPlayable(dl), 'https://cdn/x1080.mp4');
    assert.equal(pickPlayable({ _embedded: { files: [], variations: [{ label: 'source', url: 'https://cdn/src.mp4' }, { label: 'edit_proxy', url: 'https://cdn/720.mp4' }] } }), 'https://cdn/720.mp4');
    assert.equal(pickPlayable({}), null);
  });
  await test('path decoding rejects traversal', () => {
    assert.equal(decodeRelPath('day%20two/0003_sunset_%C3%A9.png'), 'day two/0003_sunset_é.png');
    for (const bad of ['..%2fsecret.jpg', '%2e%2e/secret.jpg', '..', 'a/../b.jpg', 'a%5c..%5cb.jpg', 'C%3A%5Cx.jpg', '/etc/passwd', 'a//b.jpg', '.corkboard/x.json', 'a%00.jpg', '%E0%A4%A.jpg']) {
      assert.throws(() => decodeRelPath(bad), undefined, bad);
    }
  });
  await test('Host allow-list', () => {
    const cfg = { host: '127.0.0.1', allowTailscale: true };
    for (const h of ['localhost:5180', '127.0.0.1:5180', '[::1]:5180', 'my-laptop.tail1234.ts.net', 'LOCALHOST']) assert.ok(hostAllowed(h, cfg), h);
    for (const h of ['evil.com', 'localhost.evil.com', 'ts.net', 'x.ts.net.evil.com', '', '192.168.1.5:5180']) assert.ok(!hostAllowed(h, cfg), h);
    assert.ok(!hostAllowed('a.b.ts.net', { ...cfg, allowTailscale: false }));
  });
  await test('labels and dates', () => {
    assert.deepEqual(labelFor('0013_p_doamnei_adv.mp4'), { index: 13, label: 'p doamnei adv' });
    assert.deepEqual(labelFor('IMG_1234.JPG'), { index: null, label: 'IMG 1234' });
    assert.equal(exifDateToIso('2025:08:12 15:00:19', '+03:00'), '2025-08-12T15:00:19+03:00');
    assert.equal(exifDateToIso('0000:00:00 00:00:00'), null);
    assert.deepEqual(parseImageInfo(makePng(40, 30, [1, 2, 3])), { width: 40, height: 30 });
  });
}

// ---------------------------------------------------------------- integration
async function integration(ws, tools) {
  console.log('\nintegration (tools: ' + Object.entries(tools).map(([k, v]) => `${k} ${v ? 'yes' : 'no'}`).join(', ') + ')');
  const srv = await startServer(ws);
  const { port } = srv;
  const R = (m, p, o) => request(port, m, p, o);
  try {
    await test('health', async () => {
      const r = await R('GET', '/api/health');
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.workspace.title, 'ws');
      assert.equal(r.json.counts.local, tools.ffmpeg ? 3 : 2);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    });

    await test('frontend is served with a CSP', async () => {
      const r = await R('GET', '/');
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /text\/html/);
      assert.match(r.headers['content-security-policy'], /script-src 'self'/);
      assert.equal((await R('GET', '/nope.js')).status, 404);
      assert.equal((await R('GET', '/..%2f..%2fpackage.json')).status, 404);
    });

    await test('bad Host → 403, Tailscale name allowed', async () => {
      assert.equal((await R('GET', '/api/health', { headers: { Host: 'evil.example' } })).status, 403);
      assert.equal((await R('GET', '/api/health', { headers: { Host: `localhost.evil.example:${port}` } })).status, 403);
      assert.equal((await R('GET', '/', { headers: { Host: 'laptop.tailabc.ts.net' } })).status, 200);
    });

    await test('settings', async () => {
      let r = await R('GET', '/api/settings');
      assert.equal(r.json.title, 'ws');
      r = await R('PUT', '/api/settings', { body: { title: 'Summer <b>trip</b>', people: [{ name: 'Ana', color: '#e76f51' }, { name: '', color: 'x' }, { name: 'Ben', color: 'red;}' }] } });
      assert.equal(r.status, 200);
      assert.equal(r.json.title, 'Summer <b>trip</b>');
      assert.deepEqual(r.json.people.map((p) => p.color), ['#e76f51', '#4a7bd0']);
      assert.equal((await R('PUT', '/api/settings', { body: { displayDir: '../' } })).status, 400);
      assert.equal((await R('PUT', '/api/settings', { body: { displayDir: '/etc' } })).status, 400);
      assert.equal((await R('PUT', '/api/settings', { body: { title: '' } })).status, 400);
    });

    await test('CSRF: writes need X-Requested-With and same Origin', async () => {
      assert.equal((await R('POST', '/api/boards', { body: { title: 'x' }, headers: { __noCsrf: true, 'X-Requested-With': undefined } })).status, 403);
      assert.equal((await R('POST', '/api/boards', { body: { title: 'x' }, headers: { Origin: 'https://evil.example' } })).status, 403);
      assert.equal((await R('POST', '/api/boards', { body: 'title=x', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    });

    let board;
    await test('boards: default board, create, get, list', async () => {
      let r = await R('GET', '/api/boards');
      assert.equal(r.status, 200);
      assert.equal(r.json.length, 1);
      assert.equal(r.json[0].title, 'Summer <b>trip</b>');
      r = await R('POST', '/api/boards', { body: { title: 'Day two' } });
      assert.equal(r.status, 201);
      board = r.json;
      assert.equal(board.rev, 1);
      assert.deepEqual(board.cards, []);
      r = await R('GET', `/api/boards/${board.id}`);
      assert.equal(r.json.title, 'Day two');
      r = await R('GET', '/api/boards');
      assert.equal(r.json.length, 2);
      assert.equal((await R('GET', '/api/boards/..%2f..%2fsettings')).status, 404);
      assert.equal((await R('GET', '/api/boards/nope')).status, 404);
    });

    await test('boards: save with If-Match, 409 conflict, 428 without rev', async () => {
      const doc = { ...board, cards: [{ id: 'c1', type: 'note', x: 10, y: 20, w: 200, h: 180, rot: -2, z: 1, text: 'hello <img src=x onerror=alert(1)>' }] };
      let r = await R('PUT', `/api/boards/${board.id}`, { body: doc, headers: { 'If-Match': '1' } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.rev, 2);
      r = await R('PUT', `/api/boards/${board.id}`, { body: { ...doc, cards: [] }, headers: { 'If-Match': '1' } });
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'conflict');
      assert.equal(r.json.current.rev, 2);
      assert.equal(r.json.current.cards[0].text, 'hello <img src=x onerror=alert(1)>');
      assert.equal((await R('PUT', `/api/boards/${board.id}`, { body: doc })).status, 428);
      assert.equal((await R('PUT', `/api/boards/${board.id}`, { body: { ...doc, cards: [{ id: 'c1', type: 'bogus' }] }, headers: { 'If-Match': '2' } })).status, 400);
      assert.equal((await R('PUT', `/api/boards/${board.id}`, { body: '{oops', headers: { 'If-Match': '2' } })).status, 400);
      r = await R('PUT', `/api/boards/${board.id}`, { body: { ...doc, title: 'Day 2' }, headers: { 'If-Match': '"2"' } });
      assert.equal(r.json.rev, 3);
      r = await R('GET', `/api/boards/${board.id}`);
      assert.equal(r.json.title, 'Day 2');
      assert.equal(r.json.cards.length, 1);
    });

    await test('boards: backups kept, delete moves to trash', async () => {
      const bdir = path.join(ws, '.corkboard', 'backups', board.id);
      const backups = fs.readdirSync(bdir);
      assert.equal(backups.length, 2);
      const revs = backups.map((n) => JSON.parse(fs.readFileSync(path.join(bdir, n), 'utf8')).rev).sort();
      assert.deepEqual(revs, [1, 2]);
      const r = await R('DELETE', `/api/boards/${board.id}`);
      assert.equal(r.status, 200);
      assert.equal((await R('GET', `/api/boards/${board.id}`)).status, 404);
      const trash = fs.readdirSync(path.join(ws, '.corkboard', 'trash', 'boards'));
      assert.equal(trash.length, 1);
      assert.match(trash[0], new RegExp(`${board.id}\\.json$`));
      assert.ok(!fs.readdirSync(path.join(ws, '.corkboard', 'boards')).some((n) => n.endsWith('.tmp')));
    });

    await test('concurrent saves never interleave', async () => {
      const b = (await R('POST', '/api/boards', { body: { title: 'race' } })).json;
      const results = await Promise.all([1, 2, 3, 4, 5].map((i) => R('PUT', `/api/boards/${b.id}`, { body: { ...b, cards: [{ id: `c${i}`, type: 'note', x: i, y: 0, w: 100, h: 100 }] }, headers: { 'If-Match': '1' } })));
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409]);
      await R('DELETE', `/api/boards/${b.id}`);
    });

    let items;
    await test('local media listing', async () => {
      const r = await R('GET', '/api/local');
      assert.equal(r.status, 200);
      items = r.json.items;
      const names = items.map((i) => i.path);
      assert.deepEqual(names, ['0001_beach_day.jpg', ...(tools.ffmpeg ? ['0002_waves.mp4'] : []), 'day two/0003_sunset_é.png']);
      const photo = items[0];
      assert.equal(photo.index, 1);
      assert.equal(photo.label, 'beach day');
      assert.equal(photo.type, 'photo');
      assert.equal(photo.hasDisplay, true);
      if (tools.magick) assert.deepEqual([photo.width, photo.height], [640, 480]);
      if (tools.exiftool) assert.equal(photo.capturedAt, '2025-08-12T15:00:19+03:00');
      const png = items.at(-1);
      assert.deepEqual([png.width, png.height, png.hasDisplay], [40, 30, false]);
      if (tools.ffmpeg) {
        const v = items[1];
        assert.equal(v.type, 'video');
        assert.ok(v.durationSec > 1.5 && v.durationSec < 2.5, `duration ${v.durationSec}`);
        assert.equal(v.capturedAt?.slice(0, 10), '2025-08-13');
      }
      assert.ok(fs.existsSync(path.join(ws, '.corkboard', 'cache', 'local-index.json')));
    });

    await test('thumbnails', async () => {
      let r = await R('GET', '/media/local/thumb/0001_beach_day.jpg?w=200');
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /^image\/jpeg/);
      if (tools.magick) {
        const info = (await import('../src/imageinfo.js')).parseImageInfo(r.buf);
        assert.equal(info.width, 200);
        r = await R('GET', '/media/local/thumb/0001_beach_day.jpg?w=200&v=1');
        assert.match(r.headers['cache-control'], /immutable/);
      }
      if (tools.magick) {
        r = await R('GET', '/media/local/thumb/0001_beach_day.jpg?w=150');
        assert.equal((await import('../src/imageinfo.js')).parseImageInfo(r.buf).width, 200, 'widths snap to fixed steps');
      }
      r = await R('GET', '/media/local/thumb/day%20two/0003_sunset_%C3%A9.png?w=99999');
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /^image\//);
      if (tools.ffmpeg) {
        r = await R('GET', '/media/local/thumb/0002_waves.mp4?w=400');
        assert.equal(r.status, 200);
        assert.match(r.headers['content-type'], /^image\/jpeg/);
        assert.ok(r.buf.length > 500);
      }
    });

    await test('display copy vs original, Range requests', async () => {
      const orig = fs.readFileSync(path.join(ws, '0001_beach_day.jpg'));
      const disp = fs.readFileSync(path.join(ws, 'compressed', '0001_beach_day.jpg'));
      let r = await R('GET', '/media/local/display/0001_beach_day.jpg');
      assert.equal(r.status, 200);
      assert.ok(r.buf.equals(disp));
      r = await R('GET', '/media/local/original/0001_beach_day.jpg');
      assert.ok(r.buf.equals(orig));
      assert.equal(r.headers['accept-ranges'], 'bytes');
      r = await R('GET', '/media/local/original/0001_beach_day.jpg', { headers: { Range: 'bytes=0-9' } });
      assert.equal(r.status, 206);
      assert.equal(r.headers['content-range'], `bytes 0-9/${orig.length}`);
      assert.ok(r.buf.equals(orig.subarray(0, 10)));
      r = await R('GET', '/media/local/original/0001_beach_day.jpg', { headers: { Range: 'bytes=-4' } });
      assert.equal(r.status, 206);
      assert.ok(r.buf.equals(orig.subarray(orig.length - 4)));
      r = await R('GET', '/media/local/original/0001_beach_day.jpg', { headers: { Range: `bytes=${orig.length + 10}-` } });
      assert.equal(r.status, 416);
      r = await R('GET', '/media/local/original/0001_beach_day.jpg?download=1');
      assert.match(r.headers['content-disposition'], /^attachment/);
      if (tools.ffmpeg) {
        r = await R('GET', '/media/local/display/0002_waves.mp4', { headers: { Range: 'bytes=0-' } });
        assert.equal(r.status, 206);
        assert.equal(r.headers['content-type'], 'video/mp4');
      }
      r = await R('HEAD', '/media/local/original/day%20two/0003_sunset_%C3%A9.png');
      assert.equal(r.status, 200);
      assert.equal(r.buf.length, 0);
    });

    await test('path traversal and non-media are refused', async () => {
      const attempts = [
        '/media/local/original/..%2fsecret.jpg',
        '/media/local/original/..%2F..%2Fsecret.jpg',
        '/media/local/original/%2e%2e/secret.jpg',
        '/media/local/original/%2E%2E%2Fsecret.jpg',
        '/media/local/original/../secret.jpg',
        '/media/local/original/..%5csecret.jpg',
        '/media/local/original/..\\secret.jpg',
        '/media/local/original/day%20two/..%2f..%2fsecret.jpg',
        `/media/local/original/${encodeURIComponent(path.join(path.dirname(ws), 'secret.jpg'))}`,
        '/media/local/original//etc/passwd',
        '/media/local/original/C:%5CWindows%5Cwin.ini',
        '/media/local/original/C%3A/Windows/win.ini',
        '/media/local/original/notes.txt',
        '/media/local/original/.corkboard/settings.json',
        '/media/local/original/.hidden/0009_skip.jpg',
        '/media/local/original/%00.jpg',
        '/media/local/display/..%2fsecret.jpg',
        '/media/local/thumb/..%2fsecret.jpg',
        '/media/local/original/compressed%2f..%2f..%2fsecret.jpg',
        '/media/uploads/..%2f..%2fsettings.json',
        '/media/uploads/0123456789abcdef',
        '/media/gopro/thumb/..%2f..%2fx',
        '/media/gopro/play/..%2f..%2fx',
      ];
      for (const p of attempts) {
        const r = await R('GET', p);
        assert.ok([400, 403, 404].includes(r.status), `${p} → ${r.status}`);
        assert.ok(!r.buf.includes('TOP SECRET'), `${p} leaked`);
      }
    });

    let pngUp;
    await test('uploads: PNG round trip and dedup', async () => {
      const png = makePng(64, 48, [10, 120, 200]);
      let r = await R('POST', '/api/uploads', { body: png, headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('Screen shot ✈ 1.png') } });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      pngUp = r.json;
      assert.match(pngUp.id, /^[a-f0-9]{16}$/);
      assert.equal(pngUp.name, 'Screen shot ✈ 1.png');
      assert.equal(pngUp.mime, 'image/png');
      assert.equal(pngUp.size, png.length);
      r = await R('GET', pngUp.url);
      assert.ok(r.buf.equals(png));
      assert.equal(r.headers['content-type'], 'image/png');
      assert.match(r.headers['cache-control'], /immutable/);
      r = await R('POST', '/api/uploads', { body: png, headers: { 'Content-Type': 'image/png', 'X-Filename': 'again.png' } });
      assert.equal(r.json.id, pngUp.id);
      assert.equal(fs.readdirSync(path.join(ws, '.corkboard', 'uploads')).filter((n) => n.startsWith(pngUp.id)).length, 1);
      r = await R('GET', `${pngUp.thumbUrl}`);
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /^image\//);
      r = await R('GET', `${pngUp.url}?download=1&name=${encodeURIComponent('a"b\r\n.png')}`);
      assert.match(r.headers['content-disposition'], /^attachment; filename="a_b__\.png"/);
    });

    await test('uploads: PDF with preview', async () => {
      const r = await R('POST', '/api/uploads', { body: makePdf(), headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'ticket.pdf' } });
      assert.equal(r.status, 201);
      assert.equal(r.json.mime, 'application/pdf');
      assert.equal(r.json.kind, 'pdf');
      const t = await R('GET', r.json.thumbUrl);
      assert.equal(t.status, 200);
      if (tools.magick && tools.gs) assert.match(t.headers['content-type'], /^image\/jpeg/);
      else assert.match(t.headers['content-type'], /^image\//);
    });

    await test('uploads: active content is never served inline', async () => {
      let r = await R('POST', '/api/uploads', { body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', headers: { 'Content-Type': 'image/svg+xml', 'X-Filename': 'x.svg' } });
      let g = await R('GET', r.json.url);
      assert.equal(g.headers['content-type'], 'image/svg+xml');
      assert.match(g.headers['content-security-policy'], /sandbox/);
      r = await R('POST', '/api/uploads', { body: '<script>alert(1)</script>', headers: { 'Content-Type': 'text/html', 'X-Filename': 'evil.html' } });
      g = await R('GET', r.json.url);
      assert.equal(g.headers['content-type'], 'application/octet-stream');
      assert.match(g.headers['content-disposition'], /^attachment/);
      r = await R('POST', '/api/uploads', { body: 'MZ...', headers: { 'Content-Type': 'application/x-msdownload', 'X-Filename': '..%2F..%2Fsetup.exe' } });
      assert.equal(r.json.name, 'setup.exe');
      g = await R('GET', r.json.url);
      assert.match(g.headers['content-disposition'], /^attachment/);
      assert.ok(!fs.existsSync(path.join(ws, 'setup.exe')));
    });

    await test('uploads: decoders follow the extension, never the content', async () => {
      const mvg = "push graphic-context\nviewbox 0 0 640 480\nimage over 0,0 0,0 'text:/etc/passwd'\npop graphic-context\n";
      const r = await R('POST', '/api/uploads', { body: mvg, headers: { 'Content-Type': 'image/png', 'X-Filename': 'innocent.png' } });
      const t = await R('GET', r.json.thumbUrl);
      assert.equal(t.status, 200);
      assert.ok(!/^image\/jpeg/.test(t.headers['content-type']), 'ImageMagick must not render MVG disguised as PNG');
      const hls = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nconcat:file:///etc/passwd\n#EXT-X-ENDLIST\n';
      const v = await R('POST', '/api/uploads', { body: hls, headers: { 'Content-Type': 'video/mp4', 'X-Filename': 'clip.mp4' } });
      const vt = await R('GET', v.json.thumbUrl);
      assert.match(vt.headers['content-type'], /^image\/svg\+xml/, 'ffmpeg must not read an HLS playlist disguised as MP4');
    });

    await test('uploads: limits', async () => {
      const r = await R('POST', '/api/uploads', { body: Buffer.alloc(10), headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'big.bin', 'Content-Length': String(400 * 1024 * 1024) } }).catch((e) => ({ status: 'reset', e }));
      assert.ok(r.status === 413 || r.status === 'reset', String(r.status));
      assert.equal((await R('POST', '/api/uploads', { body: Buffer.alloc(0), headers: { 'Content-Type': 'text/plain', 'X-Filename': 'empty.txt' } })).status, 400);
      assert.ok(!fs.readdirSync(path.join(ws, '.corkboard', 'uploads')).some((n) => n.startsWith('.incoming')));
      const big = '{"title":"' + 'x'.repeat(6 * 1024 * 1024) + '"}';
      assert.equal((await R('POST', '/api/boards', { body: big }).catch(() => ({ status: 413 }))).status, 413);
    });

    await test('GoPro routes (offline)', async () => {
      let r = await R('POST', '/api/gopro/links', { body: { url: 'https://evil.example/v/123' } });
      assert.equal(r.status, 400);
      r = await R('GET', '/media/gopro/thumb/abc.DEF_ghi-123?w=5000');
      assert.equal(r.status, 302);
      assert.match(r.headers.location, /^https:\/\/images-0[1-4]\.gopro\.com\/resize\/2560w\/abc\.DEF_ghi-123$/);
      r = await R('GET', '/media/gopro/thumb/abc.DEF_ghi-123?w=500');
      assert.match(r.headers.location, /\/resize\/640w\//);
      r = await R('GET', '/media/gopro/play/0123456789abcdef01234567');
      assert.equal(r.status, 404);
      r = await R('GET', '/api/gopro/links/not-a-uuid/items');
      assert.equal(r.status, 404);
      r = await R('GET', '/api/gopro/links');
      assert.deepEqual(r.json, []);
    });

    const live = process.env.GOPRO_TEST_LINK;
    if (!live) skip('GoPro live share link', 'set GOPRO_TEST_LINK to run');
    else {
      await test('GoPro live share link', async () => {
        let r = await R('POST', '/api/gopro/links', { body: { url: live } });
        assert.equal(r.status, 201, JSON.stringify(r.json));
        const link = r.json;
        assert.ok(link.mediaCount > 0);
        r = await R('GET', `/api/gopro/links/${link.id}/items`);
        assert.ok(r.json.items.length > 0, 'no items');
        assert.equal(r.json.items.length, link.mediaCount);
        const photo = r.json.items.find((i) => i.mediaType === 'Photo') || r.json.items[0];
        r = await R('GET', `/media/gopro/thumb/${photo.token}?w=300`);
        assert.equal(r.status, 302);
        const img = await fetch(r.headers.location);
        assert.equal(img.status, 200);
        assert.match(img.headers.get('content-type') || '', /^image\//);
        const video = (await R('GET', `/api/gopro/links/${link.id}/items`)).json.items.find((i) => i.mediaType === 'Video');
        if (video) {
          r = await R('GET', `/media/gopro/play/${video.mediumId}`);
          assert.equal(r.status, 302, JSON.stringify(r.json));
          const v = await fetch(r.headers.location, { headers: { Range: 'bytes=0-1023' } });
          assert.ok([200, 206].includes(v.status), `video ${v.status}`);
          // The CDN says binary/octet-stream; check the bytes are an MP4 instead.
          const head = Buffer.from(await v.arrayBuffer()).subarray(0, 12);
          assert.equal(head.toString('latin1', 4, 8), 'ftyp', 'not an MP4');
          r = await R('GET', `/media/gopro/play/${video.mediumId}?via=server`, { headers: { Range: 'bytes=0-1023' } });
          assert.equal(r.status, 206);
          assert.equal(r.headers['content-type'], 'video/mp4');
          assert.equal(r.buf.length, 1024);
          assert.equal(r.buf.toString('latin1', 4, 8), 'ftyp');
        }
        r = await R('POST', `/api/gopro/links/${link.id}/refresh`);
        assert.equal(r.status, 200);
        r = await R('DELETE', `/api/gopro/links/${link.id}`);
        assert.equal(r.status, 200);
        assert.deepEqual((await R('GET', '/api/gopro/links')).json, []);
      });
    }

    await test('server survives garbage', async () => {
      await new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => s.end('GARBAGE\r\n\r\n'));
        s.resume();
        s.on('close', resolve);
        s.on('error', resolve);
      });
      assert.equal((await R('GET', '/api/health')).status, 200);
      assert.equal((await R('PATCH', '/api/boards')).status, 405);
    });
  } finally {
    await srv.stop();
    if (results.some((r) => !r.ok)) console.log('\n--- server log ---\n' + srv.log().split('\n').slice(-40).join('\n'));
  }
}

async function noTools(ws) {
  console.log('\nwithout external tools (CORKBOARD_NO_TOOLS=1)');
  fs.rmSync(path.join(ws, '.corkboard'), { recursive: true, force: true });
  fs.mkdirSync(path.join(ws, '.corkboard'));
  fs.writeFileSync(path.join(ws, '.corkboard', 'settings.json'), '{"title": "half-written');
  const srv = await startServer(ws, { CORKBOARD_NO_TOOLS: '1' });
  const R = (m, p, o) => request(srv.port, m, p, o);
  try {
    await test('degrades gracefully', async () => {
      const h = (await R('GET', '/api/health')).json;
      assert.deepEqual(h.tools, { ffmpeg: false, magick: false, exiftool: false });
      assert.ok(fs.readdirSync(path.join(ws, '.corkboard')).some((n) => n.startsWith('settings.json.unreadable-')), 'corrupt settings kept aside');
      const items = (await R('GET', '/api/local')).json.items;
      assert.ok(items.length >= 2);
      let r = await R('GET', '/media/local/thumb/0001_beach_day.jpg?w=200');
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /^image\/jpeg/);
      if (items.some((i) => i.type === 'video')) {
        r = await R('GET', '/media/local/thumb/0002_waves.mp4');
        assert.equal(r.status, 200);
        assert.match(r.headers['content-type'], /^image\/svg\+xml/);
        assert.match(r.headers['content-security-policy'], /sandbox/);
      }
      const png = items.find((i) => i.path.endsWith('.png'));
      assert.deepEqual([png.width, png.height], [40, 30]);
    });
  } finally {
    await srv.stop();
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corkboard-test-'));
let exitCode = 0;
try {
  const { ws, tools } = makeWorkspace(tmpRoot);
  try { (await import('node:child_process')).execFileSync('gs', ['-v'], { stdio: 'ignore' }); tools.gs = true; } catch { tools.gs = false; }
  await unitTests();
  await integration(ws, tools);
  await noTools(ws);
} catch (err) {
  console.log(`\nFATAL during "${current}": ${err.stack || err}`);
  exitCode = 1;
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length - skipped} passed, ${failed.length} failed, ${skipped} skipped`);
process.exit(failed.length || exitCode ? 1 : 0);
