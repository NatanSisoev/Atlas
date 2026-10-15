// Optional external tools (ffmpeg, ffprobe, ImageMagick, ExifTool), detected once at startup.
import { execFile } from 'node:child_process';
import { limiter } from './util.js';

export function run(cmd, args, { timeout = 60_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: stdout || Buffer.alloc(0), stderr: String(stderr || ''), error: err });
    });
  });
}

async function probe(cmd, args) {
  const r = await run(cmd, args, { timeout: 8000 });
  return r.ok ? cmd : null;
}

/**
 * Returns {ffmpeg, ffprobe, magick, exiftool}: the command to call, or null when missing.
 * ImageMagick 7 is `magick`; ImageMagick 6 is `convert` (never on Windows, where `convert` is a disk tool).
 */
export async function detectTools(env = process.env) {
  if ((env.ATLAS_NO_TOOLS || env.CORKBOARD_NO_TOOLS) === '1') return { ffmpeg: null, ffprobe: null, magick: null, exiftool: null };
  const [ffmpeg, ffprobe, magick7, exiftool] = await Promise.all([
    probe('ffmpeg', ['-hide_banner', '-version']),
    probe('ffprobe', ['-hide_banner', '-version']),
    probe('magick', ['-version']),
    probe('exiftool', ['-ver']),
  ]);
  let magick = magick7 ? { cmd: 'magick', prefix: [] } : null;
  if (!magick && process.platform !== 'win32' && (await probe('convert', ['-version']))) magick = { cmd: 'convert', prefix: [] };
  return { ffmpeg, ffprobe, magick, exiftool };
}

// Shared pool for heavy child processes (thumbnails, probes): at most 3 at once.
export const heavy = limiter(3);

export function toolSummary(tools) {
  return { ffmpeg: Boolean(tools.ffmpeg), magick: Boolean(tools.magick), exiftool: Boolean(tools.exiftool) };
}
