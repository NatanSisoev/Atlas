// node test/e2e.mjs [--shots <dir>] [--only <text>] — the book (M1) end to end in headless Chromium.
// Generates a curated trip (test/fixtures.mjs makeBookWorkspace), starts `atlas serve` on it with
// the built web/dist, and reads it on an Android-sized phone and a desktop, light and dark:
// Cover → Story (plates, justified rows, captions, lazy images) → Viewer (swipe/keys, details) →
// Play → Settings (title style) → the old board at /board/. Then the service worker: offline after
// one visit (Story, Viewer, Play), a proxy answering 502 (Tailscale Serve with Atlas stopped), a
// slow laptop, a new deploy, and no ImageMagick (originals never cached as thumbnails).
// Also checks Fetch Metadata, CSP and CORP. Optional: prints SKIP and exits 0 when Playwright or
// its Chromium is not installed (Playwright never downloads browsers on npm install).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeBookWorkspace } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// ATLAS_E2E_DIST: read another build of the client (e.g. an older one, to see a test fail).
const DIST = process.env.ATLAS_E2E_DIST ? path.resolve(process.env.ATLAS_E2E_DIST) : path.join(ROOT, 'web', 'dist');
const argv = process.argv.slice(2);
const shotsDir = argv.includes('--shots') ? path.resolve(argv[argv.indexOf('--shots') + 1] || 'shots') : null;
/** Run only the tests whose name contains this text (the security check always runs). */
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] || '' : '';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('SKIP e2e: playwright is not installed (npm install)');
  process.exit(0);
}
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('FAIL e2e: web/dist is missing; run `npm run build` first');
  process.exit(1);
}
let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  console.log(`SKIP e2e: Chromium for Playwright is not available (${String(err.message).split('\n')[0]})`);
  process.exit(0);
}

// ---------------------------------------------------------------- harness
const results = [];
async function test(name, fn) {
  if (only && !name.includes(only) && !name.startsWith('security')) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL  ${name}\n        ${String(err && (err.stack || err.message)).split('\n').slice(0, 8).join('\n        ')}`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function request(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers: { Host: `127.0.0.1:${port}`, ...headers }, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startServer(ws, extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env, ATLAS_WEB_DIST: DIST, ATLAS_PUBLIC_HOST: '', ...extraEnv };
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'atlas.js'), 'serve', ws, '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100 && !log.includes('open http'); i++) {
    if (child.exitCode != null) throw new Error(`server exited:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!log.includes('open http')) throw new Error(`server did not start:\n${log}`);
  let stopped = false;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    log: () => log,
    stop: () =>
      new Promise((r) => {
        if (stopped || child.exitCode != null) return r();
        stopped = true;
        child.once('exit', r);
        child.kill('SIGTERM');
      }),
  };
}

/**
 * A reverse proxy in front of a server, the way `tailscale serve` sits in front of Atlas: it
 * answers 502 when the server is down. `delay(re, ms)` holds the next request matching `re`
 * (once per distinct path); `upstream` can be switched (a deploy); `close()` takes it away.
 */
async function startProxy(upstreamPort) {
  const port = await freePort();
  const delays = [];
  const log = [];
  const proxy = {
    port,
    base: `http://127.0.0.1:${port}`,
    upstream: upstreamPort,
    log,
    /** Requests seen for exactly this path (query ignored). */
    count: (p) => log.filter((u) => u.split('?')[0] === p).length,
    delay: (re, ms) => delays.push({ re, ms, seen: new Set() }),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  const server = http.createServer((req, res) => {
    log.push(req.url);
    const pathOnly = req.url.split('?')[0];
    let wait = 0;
    for (const d of delays) {
      if (d.re.test(pathOnly) && !d.seen.has(pathOnly)) {
        d.seen.add(pathOnly);
        wait = Math.max(wait, d.ms);
      }
    }
    setTimeout(() => {
      const up = http.request({ host: '127.0.0.1', port: proxy.upstream, method: req.method, path: req.url, headers: req.headers, agent: false }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway');
      });
      req.pipe(up);
    }, wait);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return proxy;
}

/** A copy of the generated workspace for a test that changes it or needs its own server. */
function copyWorkspace(ws, name) {
  const dest = path.join(tmpRoot, name);
  fs.cpSync(ws, dest, { recursive: true, preserveTimestamps: true });
  return dest;
}

/** Evaluate `fn` in the page until it returns true (it may return a diagnostic value meanwhile). */
async function poll(page, fn, arg, { timeout = 15000, what = 'a condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    last = await page.evaluate(fn, arg);
    if (last === true) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
    await page.waitForTimeout(200);
  }
}

const THUMB_CACHE = 'atlas-thumbs-v2';
const API_CACHE = 'atlas-api-v1';

/** Both book JSON documents are in the worker's cache. */
const apiCached = (page) =>
  poll(
    page,
    async (name) => {
      const api = await caches.open(name);
      return !!(await api.match('/api/chapters/folder')) && !!(await api.match('/api/atlas'));
    },
    API_CACHE,
    { what: 'the book JSON in the worker cache' },
  );

/** The visible slide of the viewer shows its picture (a video: plays, or its still behind the note). */
const viewerSlideShown = (page) =>
  page.waitForFunction(
    () => {
      const s = document.querySelector('.viewer .slide:not([aria-hidden="true"])');
      const v = s?.querySelector('video');
      if (v) return v.readyState >= 1;
      const img = s?.querySelector('img');
      return !!img && img.complete && img.naturalWidth > 0;
    },
    null,
    { timeout: 6000 },
  );

const DEVICES = {
  phone: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};

/** Video decoding is not available in every Chromium build; those requests may abort. */
const isVideoUrl = (u) => /\.(mp4|mov|m4v|webm)(\?|$)/i.test(u);

async function newPage(base, device, scheme, extra = {}) {
  const context = await browser.newContext({ ...DEVICES[device], colorScheme: scheme, baseURL: base, ...extra });
  const page = await context.newPage();
  const problems = [];
  const requested = new Set();
  page.on('console', (m) => {
    if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('request', (r) => requested.add(new URL(r.url()).pathname + new URL(r.url()).search));
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText || '';
    if (isVideoUrl(r.url()) || why === 'net::ERR_ABORTED') return; // aborted lazy images / video ranges
    problems.push(`request failed: ${r.url()} ${why}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !isVideoUrl(r.url())) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return { context, page, problems, requested };
}

async function shot(page, name) {
  if (!shotsDir) return;
  await page.waitForTimeout(450); // let fades settle
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

async function cleanUp(page, problems) {
  const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
  assert.deepEqual([...problems, ...csp.map((c) => `CSP violation: ${c}`)], [], 'console errors, failed requests or CSP violations');
}

/** Every story tile image currently in the DOM has loaded (or is lazily waiting off screen). */
async function imagesInViewLoaded(page) {
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('.page .frame img')];
    const vh = innerHeight;
    const inView = imgs.filter((i) => {
      const r = i.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh;
    });
    return inView.every((i) => i.complete && i.naturalWidth > 0);
  }, null, { timeout: 15000 });
}

async function scrollThrough(page) {
  for (let y = 0; y < 40; y++) {
    const done = await page.evaluate(() => {
      scrollBy(0, innerHeight * 0.8);
      return innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
    });
    await page.waitForTimeout(120);
    if (done) break;
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.page .frame img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 20000 });
}

/** Wait for a running View Transition to finish (taps during one land on the transition). */
async function settled(page) {
  await page.waitForFunction(() => {
    try {
      return !document.documentElement.matches(':active-view-transition');
    } catch {
      return true; // a browser without the pseudo-class
    }
  });
  await page.waitForTimeout(60);
}

const enc = (s) => encodeURIComponent(s);
const itemUrl = (name) => `/c/folder/i/${enc(`l:${name}`)}`;

/** A real touch swipe (touchstart/move/end → pointer events) through the DevTools protocol. */
async function swipe(page, from, to, ms = 160) {
  const cdp = await page.context().newCDPSession(page);
  const steps = 8;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await page.waitForTimeout(ms / steps);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

// ---------------------------------------------------------------- the read-through
async function readThrough(srv, book, device, scheme) {
  const tag = `${device}-${scheme}`;
  const phone = device === 'phone';
  const { context, page, problems, requested } = await newPage(srv.base, device, scheme);
  const W = DEVICES[device].viewport.width;
  const H = DEVICES[device].viewport.height;
  const tap = (loc) => (phone ? loc.tap() : loc.click());
  try {
    // Cover
    await page.goto('/');
    const card = page.locator('a.chapter');
    await card.waitFor();
    assert.equal(await card.count(), 1);
    assert.equal((await card.locator('h3').textContent()).trim(), book.expected.title);
    const meta = (await card.locator('.t-meta').textContent()).trim();
    assert.match(meta, /26 photos & videos · 4 days/, meta);
    assert.match(await card.locator('.t-kicker').textContent(), /12–15 Aug 2025/);
    await page.waitForFunction(() => {
      const img = document.querySelector('a.chapter img');
      return img && img.complete && img.naturalWidth > 0;
    });
    await shot(page, `${tag}-cover`);

    // Story
    await tap(card);
    await page.waitForURL('**/c/folder');
    await page.locator('section.page').nth(3).waitFor();
    await settled(page);
    const pages = page.locator('section.page');
    assert.equal(await pages.count(), 4);
    const plates = await pages.locator('.plate').allTextContents();
    assert.deepEqual(plates.map((t) => t.replace(/\s+/g, ' ').trim()), ['TUE 12 AUG Day 1', 'WED 13 AUG Day 2', 'THU 14 AUG Day 3', 'FRI 15 AUG Day 4']);
    const perPage = await pages.evaluateAll((els) => els.map((el) => el.querySelectorAll('.frame').length));
    assert.deepEqual(perPage, book.expected.pages.map((p) => p.names.length));
    // Captions: every item except the number-only 0013 has one; 0006 (01:40) is still on Day 1.
    assert.equal(await page.locator('.page figcaption').count(), perPage.reduce((a, b) => a + b, 0) - 1);
    assert.equal(await page.locator(`[data-item="l:0013.jpg"]`).locator('xpath=..').locator('figcaption').count(), 0);
    assert.equal(await pages.nth(0).locator('[data-item="l:0006_night_swim.jpg"]').count(), 1);
    assert.equal(await pages.nth(1).locator('[data-item="l:0013.jpg"]').count(), 1, '0013 keeps its place on Day 2');
    assert.match(await page.locator('[data-item="l:0001_arrival_in_constanța.jpg"] img').getAttribute('alt'), /constanța/);
    if (!phone) {
      // Keyboard: back, Play, then the photos in story order, each with a visible focus ring.
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const focus = () => page.evaluate(() => [document.activeElement?.getAttribute('aria-label'), getComputedStyle(document.activeElement).outlineStyle]);
      assert.deepEqual(await focus(), ['Play this chapter', 'solid']);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.item), 'l:0001_arrival_in_constanța.jpg');
      assert.equal((await focus())[1], 'solid');
    }
    // Videos: a poster with a duration pill and a play glyph.
    assert.equal(await page.locator('.frame .pill').count(), book.expected.videoCount);
    await imagesInViewLoaded(page);
    // Lazy: the last page's thumbnails are not fetched before it comes near the screen.
    const lastThumb = [...requested].some((u) => u.includes(enc('0026_home.jpg')) && u.startsWith('/media/local/thumb/'));
    assert.equal(lastThumb, false, 'the last page loaded eagerly');
    await shot(page, `${tag}-story`);

    // Justified rows never crop and fill the measure.
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.rows')].map((rowsEl) => ({
        width: rowsEl.getBoundingClientRect().width,
        rows: [...rowsEl.querySelectorAll('.row')].map((row) => ({
          short: row.classList.contains('short'),
          used: row.scrollWidth,
          tiles: [...row.querySelectorAll('.frame')].map((f) => {
            const r = f.getBoundingClientRect();
            return { w: r.width, h: r.height };
          }),
        })),
      })),
    );
    for (const pg of rows) {
      assert.ok(pg.width <= W, `rows wider than the screen (${pg.width})`);
      for (const r of pg.rows) {
        if (!r.short) assert.ok(Math.abs(r.used - pg.width) <= 2, `row ${r.used} ≠ ${pg.width}`);
        else assert.ok(r.used <= pg.width + 1);
      }
    }

    // Scroll through the book: the bar collapses, every image loads.
    await scrollThrough(page);
    assert.equal(await page.locator('nav.bar.solid').count(), 1, 'the bar is solid after scrolling');
    await page.waitForFunction(() => [...document.querySelectorAll('.page .frame img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 20000 });
    const crop = await page.evaluate(() =>
      [...document.querySelectorAll('.page .frame img')]
        .map((i) => {
          const r = i.parentElement.getBoundingClientRect();
          return { id: i.parentElement.dataset.item, a: i.naturalWidth / i.naturalHeight, b: r.width / r.height };
        })
        .filter((x) => Math.abs(x.a - x.b) / x.a > 0.04),
    );
    assert.deepEqual(crop, [], 'tiles with a different shape than their photo');
    await page.locator('#page-p2').scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const el = document.getElementById('page-p2');
      scrollTo(0, scrollY + el.getBoundingClientRect().top - 80);
    });
    await imagesInViewLoaded(page);
    await shot(page, `${tag}-story-day2`);

    // Viewer
    const harbour = page.locator('[data-item="l:0008_harbour.jpg"]');
    if (!phone) {
      // Keyboard: the tile is a link; Enter opens it.
      await harbour.focus();
      await page.keyboard.press('Enter');
    } else await tap(harbour);
    await page.waitForURL(`**${itemUrl('0008_harbour.jpg')}`);
    const viewer = page.locator('.viewer');
    await viewer.waitFor();
    await settled(page);
    assert.match(await page.locator('.viewer .count').textContent(), /^8 \/ 26$/);
    // Focus moves into the dialog itself (keys work at once; no stray focus ring on a button).
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'dialog');
    // t1200 first, then the display copy.
    await page.waitForFunction(() => {
      const img = document.querySelector('.viewer .slide:not([aria-hidden="true"]) img:last-of-type');
      return img && img.complete && img.naturalWidth > 0;
    });
    await shot(page, `${tag}-viewer`);
    if (phone) {
      await swipe(page, { x: W * 0.8, y: H / 2 }, { x: W * 0.15, y: H / 2 });
      await page.waitForURL(`**${itemUrl('0009_fishermen.jpg')}`);
      await swipe(page, { x: W * 0.15, y: H / 2 }, { x: W * 0.85, y: H / 2 });
      await page.waitForURL(`**${itemUrl('0008_harbour.jpg')}`);
      await swipe(page, { x: W / 2, y: H * 0.7 }, { x: W / 2, y: H * 0.35 }); // up: details
    } else {
      await page.keyboard.press('ArrowRight');
      await page.waitForURL(`**${itemUrl('0009_fishermen.jpg')}`);
      await page.keyboard.press('ArrowLeft');
      await page.waitForURL(`**${itemUrl('0008_harbour.jpg')}`);
      await page.keyboard.press('i');
    }
    const sheet = page.locator('.viewer .sheet');
    await sheet.waitFor();
    const sheetText = (await sheet.textContent()).replace(/\s+/g, ' ');
    for (const s of ['harbour', '0008_harbour.jpg', 'Open original', 'Download', 'Wednesday 13 August 2025', '09:45', '1920 × 1080']) assert.ok(sheetText.includes(s), `details lack "${s}": ${sheetText}`);
    assert.equal(await sheet.locator('a[download]').getAttribute('href'), `/media/local/original/0008_harbour.jpg?download=1`);
    await shot(page, `${tag}-info`);
    if (phone) await tap(page.getByRole('button', { name: 'Hide details' }));
    else await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    // A video: plays, or says calmly that it cannot and offers the original.
    await page.goto(itemUrl('0010_waves.mp4'));
    await page.locator('.viewer video, .viewer .cant-play').first().waitFor();
    await page.waitForTimeout(1200);
    if (await page.locator('.viewer .cant-play').count()) {
      assert.match(await page.locator('.cant-play').textContent(), /can’t play in this browser/);
      assert.equal(await page.locator('.cant-play a', { hasText: 'Open original' }).count(), 1);
      await shot(page, `${tag}-viewer-video`);
    }
    await page.goto(itemUrl('0008_harbour.jpg'));
    await viewer.waitFor();
    await settled(page);
    if (phone) await swipe(page, { x: W / 2, y: H * 0.3 }, { x: W / 2, y: H * 0.75 }); // down: close
    else await page.keyboard.press('Escape');
    await page.waitForURL('**/c/folder');
    await viewer.waitFor({ state: 'detached' });
    await settled(page);
    if (!phone) {
      await page.waitForFunction(() => document.activeElement?.dataset?.item === 'l:0008_harbour.jpg');
    }

    // Play
    await tap(page.locator('nav.bar button.play'));
    await page.waitForURL('**/c/folder/play');
    const player = page.locator('.player');
    await player.waitFor();
    await page.waitForTimeout(600);
    assert.match(await player.textContent(), /Black Sea, August/);
    await shot(page, `${tag}-play-title`);
    await page.waitForFunction(() => /Day 1/.test(document.querySelector('.player .stage')?.textContent || ''), null, { timeout: 8000 });
    await page.keyboard.press('ArrowRight');
    await page.locator('.player .photo img').first().waitFor();
    await page.waitForTimeout(900);
    await shot(page, `${tag}-play-photo`);
    await page.keyboard.press(' ');
    await page.getByRole('button', { name: 'Resume' }).waitFor();
    await page.keyboard.press('Escape');
    if (!/\/c\/folder$/.test(page.url())) await page.keyboard.press('Escape'); // the first may only leave fullscreen
    await page.waitForURL('**/c/folder');
    await player.waitFor({ state: 'detached' });
    await settled(page);

    // Settings: title style and "this device is"
    await tap(page.locator('nav.bar a[aria-label="All chapters"]'));
    await page.waitForURL((u) => u.pathname === '/');
    await settled(page);
    await tap(page.getByRole('button', { name: 'Settings' }));
    const dialog = page.locator('dialog[open]');
    await dialog.waitFor();
    await page.waitForTimeout(300);
    await shot(page, `${tag}-settings`);
    await tap(dialog.locator('label.type', { hasText: 'Sans' }));
    assert.equal(await page.evaluate(() => document.documentElement.dataset.type), 'sans');
    await tap(dialog.locator('label.person', { hasText: 'Ana' }));
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('atlas:type'), localStorage.getItem('atlas:me')]), ['sans', 'Ana']);
    await shot(page, `${tag}-settings-sans`);
    await tap(dialog.getByRole('button', { name: 'Close settings' }));
    await page.locator('dialog[open]').waitFor({ state: 'detached' });
    await shot(page, `${tag}-cover-sans`);
    await page.reload();
    await page.locator('a.chapter').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.type), 'sans', 'the type choice survives a reload');
    await tap(page.locator('a.chapter'));
    await page.locator('section.page').first().waitFor();
    await settled(page);
    await imagesInViewLoaded(page);
    await shot(page, `${tag}-story-sans`);
    await page.evaluate(() => localStorage.setItem('atlas:type', 'serif'));

    // The old board still works at /board/.
    await page.goto('/board/');
    await page.locator('#stage').waitFor();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.trim() === 'Saved' && document.querySelector('#boardTitle')?.textContent);
    assert.equal(await page.locator('link[rel=stylesheet][href="styles.css"]').count(), 1);
    // Its library still reads the folder through /api and /media.
    await tap(page.locator('#libraryBtn'));
    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll('#libLocal .tile img')];
      return imgs.length >= 20 && imgs.slice(0, 4).every((i) => i.complete && i.naturalWidth > 0);
    }, null, { timeout: 15000 });
    if (scheme === 'light') await shot(page, `${tag}-board`);

    await cleanUp(page, problems);
  } catch (err) {
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${tag}-FAILED.png`) }).catch(() => {});
    if (problems.length) err.message += `\n${problems.join('\n')}`;
    throw err;
  } finally {
    await context.close();
  }
}

async function offline(book) {
  // Its own server, behind a proxy that holds /sw.js back: the first screen loads from the network
  // before the worker controls the page, so only the warm-up can put it in the worker's caches.
  const ws = copyWorkspace(book.ws, 'offline');
  const srv = await startServer(ws);
  const proxy = await startProxy(srv.port);
  const { context, page, problems } = await newPage(proxy.base, 'phone', 'light');
  try {
    proxy.delay(/^\/sw\.js$/, 3000);
    await page.goto('/c/folder');
    await page.locator('section.page').first().waitFor();
    await imagesInViewLoaded(page);
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), false, 'the worker took over before the first screen loaded');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
    // One visit, never reloaded online: the page asks again (through the worker) for the book's
    // JSON and for every thumbnail it already shows.
    await apiCached(page);
    await poll(
      page,
      async (name) => {
        const thumbs = await caches.open(name);
        const keys = new Set((await thumbs.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search));
        const inView = [...document.querySelectorAll('.page .frame img')].filter((i) => {
          const r = i.getBoundingClientRect();
          return r.bottom > 0 && r.top < innerHeight && i.currentSrc;
        });
        const missing = inView.map((i) => new URL(i.currentSrc).pathname + new URL(i.currentSrc).search).filter((u) => !keys.has(u));
        return (inView.length > 0 && missing.length === 0) || { inView: inView.length, missing };
      },
      THUMB_CACHE,
      { what: 'the thumbnails on screen in the worker cache' },
    );

    // Online, navigations still reach the server (so its current CSP reaches installed apps).
    const before = proxy.count('/c/folder');
    const nav = await page.goto('/c/folder');
    assert.equal(proxy.count('/c/folder'), before + 1, 'an online navigation was answered from the precache');
    assert.equal(nav.fromServiceWorker(), true);
    assert.match(nav.headers()['content-security-policy'] || '', /script-src 'self'/);
    await page.locator('section.page').first().waitFor();

    // Read the whole book once online (through the worker now).
    await scrollThrough(page);
    await page.waitForTimeout(500);
    // Only real thumbnails are kept: immutable, and smaller than the files they show.
    const sizes = Object.fromEntries(fs.readdirSync(ws).filter((n) => /\.(jpg|mp4)$/.test(n)).map((n) => [n, fs.statSync(path.join(ws, n)).size]));
    const kept = await page.evaluate(async (name) => {
      const c = await caches.open(name);
      const out = [];
      for (const req of await c.keys()) {
        const res = await c.match(req);
        out.push({ url: req.url, cc: res.headers.get('cache-control'), size: (await res.blob()).size });
      }
      return out;
    }, THUMB_CACHE);
    assert.ok(kept.length >= 26, `only ${kept.length} thumbnails cached`);
    for (const k of kept) {
      const file = decodeURIComponent(new URL(k.url).pathname.split('/').pop());
      assert.match(k.cc || '', /immutable/, k.url);
      assert.ok(k.size < sizes[file], `${file}: a ${k.size}-byte "thumbnail" of a ${sizes[file]}-byte file`);
    }

    // The laptop is off and the phone has no network. (Chromium's offline emulation does not
    // cover the service worker's own fetches, so the server really goes away.) The browser's own
    // HTTP cache is emptied too: only the worker may answer.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    await cdp.detach();
    await proxy.close();
    await srv.stop();
    await context.setOffline(true);
    await page.reload();
    await page.locator('section.page').nth(3).waitFor();
    assert.match(await page.locator('.offline-note').textContent(), /^\s*Offline · showing the last saved copy\s*$/);
    await imagesInViewLoaded(page);
    await shot(page, 'phone-light-offline');
    await scrollThrough(page);

    // The viewer offline, from a tile that only cached its small thumbnail, through the chapter.
    const order = await page.evaluate(() => [...document.querySelectorAll('.page [data-item]')].map((el) => el.dataset.item));
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator('[data-item="l:0002_the_old_casino.jpg"]').tap();
    await page.waitForURL(`**${itemUrl('0002_the_old_casino.jpg')}`);
    await settled(page);
    await viewerSlideShown(page);
    for (let k = order.indexOf('l:0002_the_old_casino.jpg') + 1; k < order.length; k++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForURL(`**/i/${enc(order[k])}`);
      await viewerSlideShown(page).catch(() => {
        throw new Error(`offline viewer: ${order[k]} shows nothing`);
      });
    }
    // A link straight to a photo, offline.
    await page.goto(itemUrl('0005_lanterns.jpg'));
    await page.locator('.viewer').waitFor();
    await viewerSlideShown(page);
    // Play offline: the title, Day 1, then the first two photos.
    await page.goto('/c/folder/play');
    await page.locator('.player').waitFor();
    for (const name of ['0001_arrival_in_constanța.jpg', '0002_the_old_casino.jpg']) {
      await page.keyboard.press('ArrowRight');
      if (name.startsWith('0001')) await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => {
        const img = document.querySelector('.player .slide:not(.leaving) .photo img');
        return !!img && img.complete && img.naturalWidth > 0;
      }, null, { timeout: 6000 });
    }

    await page.goto('/').catch(() => {}); // a fresh navigation is answered by the worker too
    await page.locator('a.chapter').waitFor();
    assert.match(await page.locator('.offline-note').textContent(), /Offline/);
    await context.setOffline(false);
    await page.reload();
    await page.locator('a.chapter').waitFor();
    assert.match(await page.locator('.offline-note').textContent(), /Offline/);
    // Only the expected failures happened (network attempts of the API, media and the worker update).
    const unexpected = problems.filter((p) => !/\/api\/|\/sw\.js|\/media\/local\/display\/|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_FAILED|Failed to load resource/.test(p));
    assert.deepEqual(unexpected, []);
  } finally {
    await context.close();
    await proxy.close().catch(() => {});
    await srv.stop();
  }
}

/** Atlas stopped while the laptop (and `tailscale serve`) is up: every request gets a 502. */
async function gateway(book) {
  const ws = copyWorkspace(book.ws, 'gateway');
  const srv = await startServer(ws);
  const proxy = await startProxy(srv.port);
  const { context, page } = await newPage(proxy.base, 'phone', 'light');
  try {
    await page.goto('/c/folder');
    await page.locator('section.page').first().waitFor();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
    await apiCached(page);
    await srv.stop();
    assert.equal((await request(proxy.port, '/api/atlas')).status, 502, 'the proxy answers 502');
    await page.reload();
    await page.locator('section.page').nth(3).waitFor();
    assert.match(await page.locator('.offline-note').textContent(), /^\s*Offline · showing the last saved copy\s*$/);
    await page.goto('/');
    await page.locator('a.chapter').waitFor();
    assert.match(await page.locator('.offline-note').textContent(), /Offline/);
  } finally {
    await context.close();
    await proxy.close();
    await srv.stop();
  }
}

/** The laptop answers after the worker's 6 s timeout: the saved copy first, then the fresh one, by itself. */
async function slowLaptop(book) {
  const ws = copyWorkspace(book.ws, 'slow');
  const srv = await startServer(ws);
  const proxy = await startProxy(srv.port);
  const { context, page, problems } = await newPage(proxy.base, 'phone', 'light');
  try {
    await page.goto('/c/folder');
    await page.locator('section.page').nth(3).waitFor();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
    await apiCached(page);
    const tiles = () => page.locator('.page .frame').count();
    assert.equal(await tiles(), 26);
    // A new photo reaches the laptop, and its next scan takes longer than the worker waits.
    fs.copyFileSync(path.join(ws, '0026_home.jpg'), path.join(ws, '0027_one_more.jpg'));
    proxy.delay(/^\/api\/(atlas|chapters\/folder)$/, 9000);
    const asked = proxy.count('/api/chapters/folder');
    await page.reload();
    await page.locator('section.page').nth(3).waitFor({ timeout: 12000 });
    assert.match(await page.locator('.offline-note').textContent(), /slow to answer · showing the last saved copy/);
    assert.equal(await tiles(), 26);
    // The fresh copy replaces it when it lands: no reload, no retry, no visibilitychange.
    await page.waitForFunction(() => document.querySelectorAll('.page .frame').length === 27 && !document.querySelector('.offline-note'), null, { timeout: 15000 });
    assert.equal(proxy.count('/api/chapters/folder'), asked + 1, 'the chapter was asked for again');
    // The cover got its fresh copy the same way.
    await page.locator('nav.bar a[aria-label="All chapters"]').tap();
    await page.locator('a.chapter').waitFor();
    assert.match(await page.locator('a.chapter .t-meta').textContent(), /27 photos & videos/);
    assert.equal(await page.locator('.offline-note').count(), 0);
    await cleanUp(page, problems);
  } finally {
    await context.close();
    await proxy.close();
    await srv.stop();
  }
}

/** A new build on the same origin: an app that comes back to the front checks and reloads into it. */
async function deploy(book) {
  const distB = path.join(tmpRoot, 'dist-b');
  fs.cpSync(DIST, distB, { recursive: true });
  const html = fs.readFileSync(path.join(distB, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(distB, 'index.html'), html.replace('<head>', '<head>\n    <meta name="atlas-build" content="B" />'));
  fs.appendFileSync(path.join(distB, 'sw.js'), '\n// build B\n');
  const a = await startServer(copyWorkspace(book.ws, 'deploy-a'));
  const b = await startServer(copyWorkspace(book.ws, 'deploy-b'), { ATLAS_WEB_DIST: distB });
  const proxy = await startProxy(a.port);
  const { context, page } = await newPage(proxy.base, 'phone', 'light');
  const isB = () => page.evaluate(() => !!document.querySelector('meta[name="atlas-build"]'));
  try {
    await page.goto('/c/folder');
    await page.locator('section.page').first().waitFor();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
    await page.waitForTimeout(500);
    assert.equal(await isB(), false);
    proxy.upstream = b.port; // the deploy
    const checks = proxy.count('/sw.js');
    const reloaded = page.waitForEvent('load', { timeout: 15000 });
    // The phone unlocks with the app still in memory.
    await page.evaluate(() => {
      for (const v of ['hidden', 'visible']) {
        Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      }
    });
    await reloaded;
    await page.locator('section.page').first().waitFor();
    assert.ok(proxy.count('/sw.js') > checks, 'no update check when the app came back');
    assert.equal(await isB(), true, 'still the old build after the update');
  } finally {
    await context.close();
    await proxy.close();
    await a.stop();
    await b.stop();
  }
}

/** Without ImageMagick the server sends the photos themselves as thumbnails: never kept. */
async function noToolsCache(book) {
  const srv = await startServer(copyWorkspace(book.ws, 'notools'), { ATLAS_NO_TOOLS: '1' });
  const { context, page, problems } = await newPage(srv.base, 'phone', 'light');
  try {
    await page.goto('/c/folder');
    await page.locator('section.page').first().waitFor();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
    await page.reload();
    await page.locator('section.page').nth(3).waitFor();
    await scrollThrough(page);
    await page.waitForTimeout(500);
    // In any of the worker's caches (whatever their names).
    const kept = await page.evaluate(async () => {
      const out = [];
      for (const name of await caches.keys()) {
        for (const r of await (await caches.open(name)).keys()) if (new URL(r.url).pathname.startsWith('/media/')) out.push(`${name}: ${r.url}`);
      }
      return out;
    });
    assert.deepEqual(kept, [], 'full-size files kept as thumbnails');
    await cleanUp(page, problems);
  } finally {
    await context.close();
    await srv.stop();
  }
}

/** Esc, Close or Back during a step animation: the viewer stays closed and the chapter keeps its history entry. */
async function viewerCloseRace(srv) {
  const { context, page, problems } = await newPage(srv.base, 'desktop', 'light');
  try {
    for (const [how, ms] of [['Escape', 40], ['close', 40], ['back', 40], ['back', 200]]) {
      await page.goto('/c/folder');
      await page.locator('section.page').first().waitFor();
      await settled(page);
      await page.locator('[data-item="l:0008_harbour.jpg"]').click();
      await page.waitForURL(`**${itemUrl('0008_harbour.jpg')}`);
      await page.locator('.viewer').waitFor();
      await settled(page);
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(ms);
      if (how === 'Escape') await page.keyboard.press('Escape');
      else if (how === 'close') await page.getByRole('button', { name: 'Close', exact: true }).click();
      else await page.evaluate(() => history.back());
      await page.waitForTimeout(1200);
      assert.equal(new URL(page.url()).pathname, '/c/folder', `${how} at ${ms} ms`);
      assert.equal(await page.locator('.viewer').count(), 0, `${how} at ${ms} ms: the viewer opened again`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      assert.equal(new URL(page.url()).pathname, '/c/folder', `${how} at ${ms} ms: the chapter's history entry was replaced`);
    }
    await cleanUp(page, problems);
  } finally {
    await context.close();
  }
}

/** With the details open, a swipe down (on the photo or the grip) hides only them; a tap too. */
async function viewerSheet(srv) {
  const { context, page, problems } = await newPage(srv.base, 'phone', 'dark');
  const { width: W, height: H } = DEVICES.phone.viewport;
  const sheet = page.locator('.viewer .sheet');
  const url = itemUrl('0008_harbour.jpg');
  const open = async () => {
    await swipe(page, { x: W / 2, y: H * 0.7 }, { x: W / 2, y: H * 0.35 });
    await sheet.waitFor();
    await page.waitForTimeout(450);
  };
  try {
    await page.goto(url);
    await page.locator('.viewer').waitFor();
    await settled(page);
    await open();
    await swipe(page, { x: W / 2, y: H * 0.15 }, { x: W / 2, y: H * 0.45 });
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.viewer').count(), 1, 'the swipe closed the whole viewer');
    assert.equal(new URL(page.url()).pathname, url);
    await open();
    const grip = await page.locator('.viewer .sheet .grip').boundingBox();
    await swipe(page, { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, { x: grip.x + grip.width / 2, y: grip.y + 160 });
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.viewer').count(), 1);
    await open();
    await page.touchscreen.tap(W / 2, H * 0.2);
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.viewer.chrome').count(), 1, 'the tap that hid the details also hid the chrome');
    await cleanUp(page, problems);
  } finally {
    await context.close();
  }
}

/** Play: a pause during the wait after an unplayable video, the end card, and Play again after a pause. */
async function playFlow(srv) {
  const { context, page, problems } = await newPage(srv.base, 'desktop', 'light');
  try {
    await page.goto('/c/folder/play');
    await page.locator('.player').waitFor();
    // Title, Day 1, 0001–0006, Day 2, 0007–0009, then the video 0010.
    for (let k = 0; k < 12; k++) await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => /10 \/ 26/.test(document.querySelector('.player .count')?.textContent || ''));
    const failed = await page
      .waitForFunction(() => /can’t play/.test(document.querySelector('.player')?.textContent || ''), null, { timeout: 2500 })
      .then(() => true, () => false);
    if (failed) {
      await page.keyboard.press(' ');
      await page.waitForTimeout(500);
      await page.keyboard.press(' ');
      await page.waitForFunction(() => /11 \/ 26/.test(document.querySelector('.player .count')?.textContent || ''), null, { timeout: 4500 });
    } else console.log('        (this Chromium plays the fixture video: the unplayable-video wait is not exercised)');
    // Paused, then to the end: the end card has no pause control and no stale "Paused".
    await page.keyboard.press(' ');
    await page.getByRole('button', { name: 'Resume' }).waitFor();
    for (let k = 0; k < 40 && !/The end/.test(await page.locator('.player .stage').textContent()); k++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(1000);
    assert.match(await page.locator('.player .stage').textContent(), /The end/);
    assert.equal(await page.locator('.player .controls').count(), 0, 'pause controls on the end card');
    assert.equal((await page.locator('.player .sr-only').textContent()).trim(), '');
    await shot(page, 'desktop-light-play-end');
    await page.getByRole('button', { name: 'Play again' }).click();
    await page.waitForFunction(() => /Day 1/.test(document.querySelector('.player .slide:not(.leaving)')?.textContent || ''), null, { timeout: 4500 });
    await cleanUp(page, problems);
  } finally {
    await context.close();
  }
}

/** Classic (non-overlay) scrollbars, as on Windows: the viewer and Play still span the window. */
async function fullWidthOverlays(srv) {
  const b = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    const context = await b.newContext({ viewport: { width: 1440, height: 900 }, baseURL: srv.base });
    const page = await context.newPage();
    await page.goto('/c/folder');
    await page.locator('section.page').first().waitFor();
    const gutter = await page.evaluate(() => innerWidth - document.documentElement.clientWidth);
    for (const [url, sel] of [[itemUrl('0008_harbour.jpg'), '.viewer'], ['/c/folder/play', '.player']]) {
      await page.goto(url);
      await page.locator(sel).waitFor();
      await page.waitForTimeout(300);
      const [w, inner] = await page.evaluate((q) => [document.querySelector(q).getBoundingClientRect().width, innerWidth], sel);
      assert.equal(w, inner, `${sel} is ${w}px in a ${inner}px window (scrollbar gutter ${gutter}px)`);
    }
  } finally {
    await b.close();
  }
}

async function reducedMotion(srv) {
  const { context, page, problems } = await newPage(srv.base, 'desktop', 'light', { reducedMotion: 'reduce' });
  try {
    await page.goto('/c/folder/play');
    await page.locator('.player').waitFor();
    await page.keyboard.press('ArrowRight'); // Day 1
    await page.keyboard.press('ArrowRight'); // the first photo
    await page.locator('.player .photo img').first().waitFor();
    await page.waitForTimeout(1200);
    const anim = await page.evaluate(() => [...document.querySelectorAll('.player .photo')].map((el) => getComputedStyle(el).animationName));
    assert.ok(anim.length > 0 && anim.every((a) => a === 'none'), `photos still drift: ${anim}`);
    await cleanUp(page, problems);
  } finally {
    await context.close();
  }
}

async function security(srv) {
  const { port } = srv;
  assert.equal((await request(port, '/api/atlas', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request(port, '/api/atlas', { 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await request(port, '/media/local/thumb/0001_arrival_in_constan%C8%9Ba.jpg?w=400', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request(port, '/api/atlas', { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await request(port, '/api/atlas')).status, 200);
  const home = await request(port, '/', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' });
  assert.equal(home.status, 200, 'a link from elsewhere still opens the app');
  assert.match(home.headers['content-security-policy'] || '', /script-src 'self'(;|$)/);
  assert.match(home.headers['cache-control'] || '', /no-cache/);
  const deep = await request(port, itemUrl('0008_harbour.jpg'));
  assert.equal(deep.status, 200);
  assert.ok(deep.headers['content-security-policy']);
  const thumb = await request(port, '/media/local/thumb/0008_harbour.jpg?w=400&v=1');
  assert.equal(thumb.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal((await request(port, '/board')).status, 301);
  assert.equal((await request(port, '/sw.js')).headers['cache-control'], 'no-cache');
}

// ---------------------------------------------------------------- main
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e2e-'));
let srv;
try {
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
  const book = makeBookWorkspace(tmpRoot);
  srv = await startServer(book.ws);
  console.log(`\nthe book in Chromium (${book.ws.includes('book') ? 'generated trip' : ''}, ${srv.base})`);
  await test('security: Fetch Metadata, CSP, CORP, caching', () => security(srv));
  for (const device of ['phone', 'desktop']) {
    for (const scheme of ['light', 'dark']) {
      await test(`${device} ${scheme}: cover → story → viewer → play → settings → /board/`, () => readThrough(srv, book, device, scheme));
    }
  }
  await test('reduced motion: Play crossfades without the drift', () => reducedMotion(srv));
  await test('viewer: Esc, Close or Back during a step animation stays closed', () => viewerCloseRace(srv));
  await test('viewer: with the details open, a swipe down or a tap hides only them', () => viewerSheet(srv));
  await test('play: pause during an unplayable video, the end card, Play again after a pause', () => playFlow(srv));
  await test('classic scrollbars: the viewer and Play span the whole window', () => fullWidthOverlays(srv));
  await test('no ImageMagick: originals sent as thumbnails are never kept by the worker', () => noToolsCache(book));
  await test('offline after one visit: shell, story, viewer and Play from the service worker', () => offline(book));
  await test('Atlas stopped behind a proxy (502): the saved copy, marked offline', () => gateway(book));
  await test('slow laptop: the saved copy first, then the fresh one by itself', () => slowLaptop(book));
  await test('a new deploy: an app back from the background reloads into it', () => deploy(book));
} catch (err) {
  results.push({ name: 'setup', ok: false, err });
  console.log(`FATAL ${err.stack || err}`);
} finally {
  await browser.close();
  if (srv) await srv.stop();
  if (results.some((r) => !r.ok) && srv) console.log('\n--- server log ---\n' + srv.log().split('\n').slice(-30).join('\n'));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
