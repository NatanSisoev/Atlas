// Tool-free fallback metadata for JPEG/PNG: dimensions, EXIF orientation and capture date.
import fsp from 'node:fs/promises';

export async function readImageInfo(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(512 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return parseImageInfo(buf.subarray(0, bytesRead));
  } catch {
    return {};
  } finally {
    await fh?.close();
  }
}

export function parseImageInfo(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return {};
  const info = {};
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = b.readUInt16BE(i + 2);
    const seg = b.subarray(i + 4, Math.min(b.length, i + 2 + len));
    if (marker === 0xe1 && seg.length > 14 && seg.toString('latin1', 0, 6) === 'Exif\0\0') {
      Object.assign(info, parseExif(seg.subarray(6)));
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && seg.length >= 5) {
      info.height = seg.readUInt16BE(1);
      info.width = seg.readUInt16BE(3);
      break;
    }
    i += 2 + len;
  }
  if (info.orientation >= 5 && info.orientation <= 8 && info.width) [info.width, info.height] = [info.height, info.width];
  return info;
}

function parseExif(t) {
  const out = {};
  try {
    const le = t.toString('latin1', 0, 2) === 'II';
    const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
    const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    const ascii = (count, valOff) => {
      const off = count > 4 ? u32(valOff) : valOff;
      return t.toString('latin1', off, off + count).replace(/\0+$/, '');
    };
    const readIfd = (off, visit) => {
      const n = u16(off);
      for (let k = 0; k < n; k++) {
        const e = off + 2 + k * 12;
        visit(u16(e), u16(e + 2), u32(e + 4), e + 8);
      }
    };
    let exifPtr = 0;
    readIfd(u32(4), (tag, type, count, valOff) => {
      if (tag === 0x0112) out.orientation = u16(valOff);
      if (tag === 0x8769) exifPtr = u32(valOff);
      if (tag === 0x0132 && type === 2) out.dateTime = ascii(count, valOff);
    });
    if (exifPtr) {
      readIfd(exifPtr, (tag, type, count, valOff) => {
        if (tag === 0x9003 && type === 2) out.dateTimeOriginal = ascii(count, valOff);
        if (tag === 0x9011 && type === 2) out.offsetTimeOriginal = ascii(count, valOff);
      });
    }
  } catch {}
  return out;
}

/** "2025:08:12 15:00:19" (+ optional "+03:00") → "2025-08-12T15:00:19+03:00"; null when invalid. */
export function exifDateToIso(value, offset) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!m || m[1] === '0000' || m[2] === '00') return null;
  let iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  const tz = /([+-]\d{2}:\d{2}|Z)$/.exec(String(value)) || /^([+-]\d{2}:\d{2})$/.exec(String(offset || ''));
  if (tz) iso += tz[1];
  return iso;
}
