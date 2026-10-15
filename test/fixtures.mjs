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
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', 'creation_time=2025-08-13T10:20:30Z', path.join(ws, '0002_waves.mp4')]);
  }
  fs.writeFileSync(path.join(ws, 'day two', '0003_sunset_é.png'), makePng(40, 30, [200, 80, 40]));
  fs.writeFileSync(path.join(ws, '.hidden', '0009_skip.jpg'), TINY_JPEG);
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'not media');
  fs.writeFileSync(path.join(root, 'secret.jpg'), Buffer.from('TOP SECRET'));
  return { ws, tools };
}
