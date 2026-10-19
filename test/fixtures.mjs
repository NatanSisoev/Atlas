// Generates a throwaway workspace with tiny media files. Never touches real data.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

// 1×1 baseline JPEG, used when ImageMagick is not installed.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALACyL//2Q==',
  'base64',
);

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal valid RGB PNG of the given size and colour, built by hand. */
export function makePng(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = (g + x) & 255; raw[o + 2] = (b + y) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A tiny one-page PDF (no tools needed). */
export function makePdf(text = 'Boarding pass') {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 24 Tf 30 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** ffmpeg arguments that make a clip look like a GoPro's (the handler name real GoPro files carry). */
export const GOPRO_TAGS = ['-metadata:s:v:0', 'handler_name=GoPro AVC'];

/**
 * A phone-style clip (only with ffmpeg): QuickTime dates in UTC, as Android writes them, or with
 * an iPhone-style creation date that carries its offset.
 */
export function makePhoneClip(file, { utc, creationDate } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', `creation_time=${utc}`, '-metadata', 'com.android.version=14'];
  if (creationDate) args.push('-metadata', `com.apple.quicktime.creationdate=${creationDate}`);
  execFileSync('ffmpeg', [...args, '-movflags', 'use_metadata_tags', file]);
}

function has(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 10_000 }); return true; } catch { return false; }
}

/**
 * Layout:
 *   <root>/secret.jpg                      (outside the workspace: traversal target)
 *   <root>/ws/0001_beach_day.jpg           photo (640×480 when ImageMagick exists)
 *   <root>/ws/0002_waves.mp4               2 s video (only with ffmpeg)
 *   <root>/ws/day two/0003_sunset_é.png    hand-made PNG in a subfolder with a space + accent
 *   <root>/ws/compressed/0001_beach_day.jpg display copy
 *   <root>/ws/.hidden/0009_skip.jpg        must be skipped
 *   <root>/ws/notes.txt                    not media
 */
export function makeWorkspace(root) {
  const ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, 'compressed'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'day two'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.hidden'), { recursive: true });
  const tools = {
    magick: has('magick', ['-version']) ? 'magick' : process.platform !== 'win32' && has('convert', ['-version']) ? 'convert' : null,
    ffmpeg: has('ffmpeg', ['-version']),
    exiftool: has('exiftool', ['-ver']),
  };
  const photo = path.join(ws, '0001_beach_day.jpg');
  if (tools.magick) {
    execFileSync(tools.magick, ['-size', '640x480', 'gradient:#f4a261-#2a9d8f', '-quality', '90', photo]);
    execFileSync(tools.magick, ['-size', '320x240', 'gradient:#f4a261-#2a9d8f', '-quality', '70', path.join(ws, 'compressed', '0001_beach_day.jpg')]);
  } else {
    fs.writeFileSync(photo, TINY_JPEG);
    fs.writeFileSync(path.join(ws, 'compressed', '0001_beach_day.jpg'), TINY_JPEG.subarray(0));
  }
  if (tools.exiftool) {
    execFileSync('exiftool', ['-overwrite_original', '-q', '-DateTimeOriginal=2025:08:12 15:00:19', '-OffsetTimeOriginal=+03:00', photo]);
  }
  if (tools.ffmpeg) {
    // A GoPro clip (its handler name says so): its QuickTime date is the camera's local wall clock.
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...GOPRO_TAGS, '-metadata', 'creation_time=2025-08-13T10:20:30Z', path.join(ws, '0002_waves.mp4')]);
  }
  fs.writeFileSync(path.join(ws, 'day two', '0003_sunset_é.png'), makePng(40, 30, [200, 80, 40]));
  fs.writeFileSync(path.join(ws, '.hidden', '0009_skip.jpg'), TINY_JPEG);
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'not media');
  fs.writeFileSync(path.join(root, 'secret.jpg'), Buffer.from('TOP SECRET'));
  return { ws, tools };
}

/**
 * Insert an EXIF APP1 segment with DateTimeOriginal (and OffsetTimeOriginal) right after SOI.
 * Used when exiftool is not installed, so dated fixtures exist either way.
 */
export function withExifDate(jpeg, dateTime, offset) {
  const entries = [[0x9003, `${dateTime}\0`]];
  if (offset) entries.push([0x9011, `${offset}\0`]);
  const exifIfd = 8 + 2 + 12 + 4; // after the header and a one-entry IFD0
  let data = exifIfd + 2 + 12 * entries.length + 4;
  const size = data + entries.reduce((n, [, v]) => n + v.length + (v.length & 1), 0);
  const t = Buffer.alloc(size);
  t.write('MM', 0, 'latin1');
  t.writeUInt16BE(42, 2);
  t.writeUInt32BE(8, 4);
  t.writeUInt16BE(1, 8); // IFD0: ExifIFDPointer
  t.writeUInt16BE(0x8769, 10); t.writeUInt16BE(4, 12); t.writeUInt32BE(1, 14); t.writeUInt32BE(exifIfd, 18);
  t.writeUInt32BE(0, 22);
  t.writeUInt16BE(entries.length, exifIfd);
  entries.forEach(([tag, v], k) => {
    const e = exifIfd + 2 + k * 12;
    t.writeUInt16BE(tag, e); t.writeUInt16BE(2, e + 2); t.writeUInt32BE(v.length, e + 4);
    if (v.length <= 4) t.write(v, e + 8, 'latin1');
    else { t.writeUInt32BE(data, e + 8); t.write(v, data, 'latin1'); data += v.length + (v.length & 1); }
  });
  t.writeUInt32BE(0, exifIfd + 2 + 12 * entries.length);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), head, body, jpeg.subarray(2)]);
}

/**
 * A curated trip folder for the book (every name is NNNN_label, so it reads in filename order):
 *   <root>/story/0001…0011 photos over 10–12 Aug 2025 (EXIF DateTimeOriginal, local wall clock)
 *   0003 is shot at 01:30 on the 11th and still belongs to the evening of the 10th (04:00 day start);
 *   0006 is a 1.5 s video (only with ffmpeg);
 *   0007 goes back to the 10th, so it gets a page of its own;
 *   0010 has no date and stays on the page it follows.
 * `expected` describes the pages the story must draft from it.
 */
export function makeStoryWorkspace(root) {
  const ws = path.join(root, 'story');
  fs.mkdirSync(ws, { recursive: true });
  const tools = {
    magick: has('magick', ['-version']) ? 'magick' : process.platform !== 'win32' && has('convert', ['-version']) ? 'convert' : null,
    ffmpeg: has('ffmpeg', ['-version']),
    exiftool: has('exiftool', ['-ver']),
  };
  const shots = [
    ['0001_arrival.jpg', '2025:08:10 18:30:00', '+03:00', [480, 320]],
    ['0002_dinner_by_the_sea.jpg', '2025:08:10 21:15:00', '+03:00', [480, 320]],
    ['0003_night_swim.jpg', '2025:08:11 01:30:00', '+03:00', [480, 320]],
    ['0004_morning_market.jpg', '2025:08:11 09:05:00', null, [480, 320]],
    ['0005_orașul_vechi.jpg', '2025:08:11 12:40:00', null, [240, 320]],
    ['0007_one_more_from_day_one.jpg', '2025:08:10 20:00:00', '+03:00', [480, 320]],
    ['0008_boat.jpg', '2025:08:12 10:00:00', '+03:00', [480, 270]],
    ['0009_lighthouse.jpg', '2025:08:12 17:45:00', '+03:00', [270, 480]],
    ['0010_ticket.jpg', null, null, [320, 320]],
    ['0011_last_light.jpg', '2025:08:12 20:30:00', '+03:00', [480, 320]],
  ];
  const colours = ['#e9c46a-#264653', '#f4a261-#2a9d8f', '#8ecae6-#023047', '#ffb703-#fb8500'];
  const exifArgs = [];
  shots.forEach(([name, date, offset, [w, h]], i) => {
    const file = path.join(ws, name);
    if (tools.magick) execFileSync(tools.magick, ['-size', `${w}x${h}`, `gradient:${colours[i % colours.length]}`, '-quality', '80', file]);
    else fs.writeFileSync(file, TINY_JPEG);
    if (!date) return;
    if (tools.exiftool) exifArgs.push(`-DateTimeOriginal=${date}`, ...(offset ? [`-OffsetTimeOriginal=${offset}`] : []), file, '-execute');
    else fs.writeFileSync(file, withExifDate(fs.readFileSync(file), date, offset));
  });
  if (exifArgs.length) execFileSync('exiftool', [...exifArgs, '-common_args', '-overwrite_original', '-q']);
  if (tools.ffmpeg) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=1.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...GOPRO_TAGS, '-metadata', 'creation_time=2025-08-11T16:00:00Z', path.join(ws, '0006_waves.mp4')]);
  }
  const video = tools.ffmpeg ? ['0006_waves.mp4'] : [];
  const expected = {
    from: '2025-08-10',
    to: '2025-08-12',
    range: '10–12 Aug 2025',
    photoCount: shots.length,
    videoCount: video.length,
    pages: [
      { id: 'p1', date: '2025-08-10', names: ['0001_arrival.jpg', '0002_dinner_by_the_sea.jpg', '0003_night_swim.jpg'] },
      { id: 'p2', date: '2025-08-11', names: ['0004_morning_market.jpg', '0005_orașul_vechi.jpg', ...video] },
      { id: 'p3', date: '2025-08-10', names: ['0007_one_more_from_day_one.jpg'] },
      { id: 'p4', date: '2025-08-12', names: ['0008_boat.jpg', '0009_lighthouse.jpg', '0010_ticket.jpg', '0011_last_light.jpg'] },
    ],
  };
  return { ws, tools, expected };
}

/** A stand-in for web/dist (the real one is built by Vite) so routing tests never depend on a build. */
export function makeFakeWebDist(root) {
  const dist = path.join(root, 'fake-dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dist, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><title>Atlas</title><script type="module" src="/assets/index-abc123.js"></script></head><body>FAKE-SPA-SHELL</body></html>\n');
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log("app");\n');
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.css'), 'body{margin:0}\n');
  fs.writeFileSync(path.join(dist, 'sw.js'), 'self.addEventListener("fetch", () => {});\n');
  fs.writeFileSync(path.join(dist, 'registerSW.js'), 'navigator.serviceWorker.register("/sw.js");\n');
  fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), JSON.stringify({ name: 'Atlas', start_url: '/', display: 'standalone' }));
  fs.writeFileSync(path.join(dist, 'icons', 'icon-192.png'), makePng(8, 8, [20, 20, 20]));
  return dist;
}

/**
 * A richer curated trip for the end-to-end run (test/e2e.mjs) and demos: 24 photos over four days
 * (12–15 Aug 2025) in landscape, portrait, square, 16:9, 9:16 and panoramic shapes, two short
 * videos (with ffmpeg), display copies in compressed/ for some of them, and settings with a title
 * and two people. Images are synthetic landscapes drawn by ImageMagick (1×1 JPEGs without it).
 *   0006 is shot at 01:40 on the 13th and still belongs to the evening of the 12th;
 *   0013 is named by number only (no caption, still in its place);
 *   0020 has no date and stays on the page it follows.
 */
export function makeBookWorkspace(root, { name = 'Black Sea, August' } = {}) {
  const ws = path.join(root, 'book');
  fs.mkdirSync(path.join(ws, 'compressed'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.atlas'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.atlas', 'settings.json'), JSON.stringify({
    title: name,
    people: [{ name: 'Ana', color: '#C8613F' }, { name: 'Nico', color: '#3E6BD6' }],
  }, null, 2));
  const tools = {
    magick: has('magick', ['-version']) ? 'magick' : process.platform !== 'win32' && has('convert', ['-version']) ? 'convert' : null,
    ffmpeg: has('ffmpeg', ['-version']),
    exiftool: has('exiftool', ['-ver']),
  };
  // [name, date, offset, [w, h], palette, display copy?]
  const L = [1800, 1200], P = [1200, 1800], L43 = [1600, 1200], P34 = [1200, 1600], W = [1920, 1080], T = [1080, 1920], SQ = [1400, 1400], PANO = [3000, 1000];
  const dusk = ['#f3c9a5', '#7d8fb3', '#3d4a63', '#1f2838', '#ffe1b8'];
  const morning = ['#cfe3ef', '#f6efe2', '#2f6f86', '#174454', '#fff6dc'];
  const hills = ['#dde7ea', '#f2efe6', '#5f7d4e', '#2f4a2c', '#fffbe9'];
  const sunset = ['#f6b38a', '#f9e0c0', '#6b3f4f', '#2d1e2b', '#ffd59e'];
  const shots = [
    ['0001_arrival_in_constanța.jpg', '2025:08:12 17:05:00', '+03:00', L, dusk, true],
    ['0002_the_old_casino.jpg', '2025:08:12 17:40:00', '+03:00', P, dusk, true],
    ['0003_promenade.jpg', '2025:08:12 18:10:00', '+03:00', PANO, dusk, false],
    ['0004_dinner_by_the_sea.jpg', '2025:08:12 20:30:00', '+03:00', L43, dusk, false],
    ['0005_lanterns.jpg', '2025:08:12 22:15:00', '+03:00', P34, dusk, false],
    ['0006_night_swim.jpg', '2025:08:13 01:40:00', '+03:00', L, dusk, false],
    ['0007_coffee_on_the_balcony.jpg', '2025:08:13 08:20:00', '+03:00', SQ, morning, true],
    ['0008_harbour.jpg', '2025:08:13 09:45:00', '+03:00', W, morning, false],
    ['0009_fishermen.jpg', '2025:08:13 10:30:00', '+03:00', P, morning, false],
    ['0011_the_long_beach.jpg', '2025:08:13 13:00:00', '+03:00', PANO, morning, true],
    ['0012_ice_cream.jpg', '2025:08:13 15:10:00', '+03:00', T, morning, false],
    ['0013.jpg', '2025:08:13 17:30:00', '+03:00', L, morning, false],
    ['0014_road_to_the_hills.jpg', '2025:08:14 09:00:00', '+03:00', W, hills, true],
    ['0015_vineyards.jpg', '2025:08:14 10:40:00', '+03:00', L, hills, false],
    ['0016_a_monastery_in_the_woods.jpg', '2025:08:14 12:20:00', '+03:00', P34, hills, false],
    ['0017_picnic.jpg', '2025:08:14 14:00:00', '+03:00', L43, hills, false],
    ['0019_view_over_the_delta.jpg', '2025:08:14 18:30:00', '+03:00', PANO, hills, true],
    ['0020_ticket_stub.jpg', null, null, SQ, hills, false],
    ['0021_last_morning.jpg', '2025:08:15 07:30:00', '+03:00', L, sunset, false],
    ['0022_packing_up.jpg', '2025:08:15 09:10:00', '+03:00', P, sunset, false],
    ['0023_one_more_swim.jpg', '2025:08:15 11:00:00', '+03:00', W, sunset, true],
    ['0024_goodbye_sea.jpg', '2025:08:15 19:50:00', '+03:00', L43, sunset, false],
    ['0025_sunset_from_the_train.jpg', '2025:08:15 20:15:00', '+03:00', T, sunset, false],
    ['0026_home.jpg', '2025:08:15 23:30:00', '+03:00', L, sunset, false],
  ];
  const band = (w, h, seed, colours) => [
    '(', '-size', `${Math.ceil(w / 8)}x${Math.ceil(h / 8)}`, '-seed', String(seed), 'plasma:fractal',
    '-colorspace', 'gray', '-auto-level', '+level-colors', colours, '-resize', `${w}x${h}!`, ')',
    '-gravity', 'south', '-composite',
  ];
  const exifArgs = [];
  shots.forEach(([file, date, offset, [w, h], [sky1, sky2, land1, land2, sun], display], i) => {
    const abs = path.join(ws, file);
    if (tools.magick) {
      const landH = Math.round(h * (0.3 + ((i * 7) % 5) * 0.05));
      const r = Math.round(Math.min(w, h) * 0.07);
      const cx = Math.round(w * (0.2 + ((i * 3) % 7) * 0.1));
      const cy = h - landH - Math.round(r * 0.6);
      execFileSync(tools.magick, [
        '-size', `${w}x${h}`, `gradient:${sky1}-${sky2}`,
        '-fill', sun, '-draw', `circle ${cx},${cy} ${cx + r},${cy}`,
        // A far band and a near band of smooth noise, tinted (drawn small and scaled up: fast).
        ...band(w, Math.round(landH * 1.35), 200 + i, `${land1},${sky2}`),
        ...band(w, landH, 100 + i, `${land2},${land1}`),
        '-quality', '82', abs,
      ]);
      if (display) execFileSync(tools.magick, [abs, '-resize', '1200x1200>', '-quality', '75', path.join(ws, 'compressed', file)]);
    } else {
      fs.writeFileSync(abs, TINY_JPEG);
      if (display) fs.writeFileSync(path.join(ws, 'compressed', file), TINY_JPEG);
    }
    if (!date) return;
    if (tools.exiftool) exifArgs.push(`-DateTimeOriginal=${date}`, ...(offset ? [`-OffsetTimeOriginal=${offset}`] : []), abs, '-execute');
    else fs.writeFileSync(abs, withExifDate(fs.readFileSync(abs), date, offset));
  });
  if (exifArgs.length) execFileSync('exiftool', [...exifArgs, '-common_args', '-overwrite_original', '-q']);
  const videos = [];
  if (tools.ffmpeg) {
    // GoPro clips: their QuickTime dates are the camera's local wall clock (phones write UTC).
    for (const [file, when, src] of [
      ['0010_waves.mp4', '2025-08-13T11:20:00Z', 'testsrc2=size=640x360:rate=25:duration=3'],
      ['0018_cicadas.mp4', '2025-08-14T16:00:00Z', 'testsrc2=size=360x640:rate=25:duration=2'],
    ]) {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...GOPRO_TAGS, '-metadata', `creation_time=${when}`, path.join(ws, file)]);
      videos.push(file);
    }
    fs.copyFileSync(path.join(ws, '0010_waves.mp4'), path.join(ws, 'compressed', '0010_waves.mp4'));
  }
  const names = [...shots.map((s) => s[0]), ...videos].sort();
  const pageOf = (n) => (n < '0007' ? 0 : n < '0014' ? 1 : n < '0021' ? 2 : 3);
  const expected = {
    title: name,
    from: '2025-08-12',
    to: '2025-08-15',
    range: '12–15 Aug 2025',
    photoCount: shots.length,
    videoCount: videos.length,
    pages: ['2025-08-12', '2025-08-13', '2025-08-14', '2025-08-15'].map((date, k) => ({
      id: `p${k + 1}`,
      date,
      names: names.filter((n) => pageOf(n) === k),
    })),
  };
  return { ws, tools, expected };
}
