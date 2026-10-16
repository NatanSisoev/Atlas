// node test/e2e.mjs [--shots <dir>] — the book (M1) end to end in headless Chromium.
// Generates a curated trip (test/fixtures.mjs makeBookWorkspace), starts `atlas serve` on it with
// the built web/dist, and reads it on an Android-sized phone and a desktop, light and dark:
// Cover → Story (plates, justified rows, captions, lazy images) → Viewer (swipe/keys, details) →
// Play → Settings (title style) → the old board at /board/, then offline from the service worker.
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
const DIST = path.join(ROOT, 'web', 'dist');
const argv = process.argv.slice(2);
const shotsDir = argv.includes('--shots') ? path.resolve(argv[argv.indexOf('--shots') + 1] || 'shots') : null;

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

async function startServer(ws) {
  const port = await freePort();
  const env = { ...process.env, ATLAS_WEB_DIST: DIST, ATLAS_PUBLIC_HOST: '' };
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
          centered: row.classList.contains('centered'),
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
        if (!r.centered) assert.ok(Math.abs(r.used - pg.width) <= 2, `row ${r.used} ≠ ${pg.width}`);
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

async function offline(srv) {
  const { context, page, problems } = await newPage(srv.base, 'phone', 'light');
  try {
    await page.goto('/c/folder');
    await page.evaluate(() => navigator.serviceWorker.ready);
    // The first visit installs the worker; the next load goes through it and fills the caches.
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.locator('section.page').first().waitFor();
    await scrollThrough(page);
    await page.waitForTimeout(500);

    // The laptop is off and the phone has no network. (Chromium's offline emulation does not
    // cover the service worker's own fetches, so the server really goes away.)
    await srv.stop();
    await context.setOffline(true);
    await page.reload();
    await page.locator('section.page').nth(3).waitFor();
    assert.match(await page.locator('.offline-note').textContent(), /^Offline · showing the last saved copy$/);
    await imagesInViewLoaded(page);
    await shot(page, 'phone-light-offline');
    await scrollThrough(page);
    await page.goto('/').catch(() => {}); // a fresh navigation is answered by the worker too
    await page.locator('a.chapter').waitFor();
    assert.match(await page.locator('.offline-note').textContent(), /Offline/);
    await context.setOffline(false);
    await page.reload();
    await page.locator('a.chapter').waitFor();
    assert.match(await page.locator('.offline-note').textContent(), /Offline/);
    // Only the expected failures happened (network attempts of the API and the worker update).
    const unexpected = problems.filter((p) => !/\/api\/|\/sw\.js|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|Failed to load resource/.test(p));
    assert.deepEqual(unexpected, []);
  } finally {
    await context.close();
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
  await test('offline: the app shell, last chapter and thumbnails from the service worker', () => offline(srv));
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
