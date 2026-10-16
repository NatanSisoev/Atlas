// Small text helpers for counts, durations and dates shown in the UI.
import { formatPlate, formatTime, parseWall } from './model';

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** "110 photos & videos", "84 photos", "1 video". */
export function itemsPhrase(photos: number, videos: number): string {
  if (photos > 0 && videos > 0) return `${(photos + videos).toLocaleString('en')} photos & videos`;
  if (videos > 0) return plural(videos, 'video', 'videos');
  return plural(photos, 'photo', 'photos');
}

const dayIndex = (ymd: string | null | undefined): number | null => {
  const w = parseWall(ymd);
  return w ? Math.round(Date.UTC(w.y, w.m - 1, w.d) / 86_400_000) : null;
};

/** Inclusive number of days between two 'YYYY-MM-DD' strings; null without dates. */
export function spanDays(from: string | null, to: string | null): number | null {
  const a = dayIndex(from ?? to);
  const b = dayIndex(to ?? from);
  return a == null || b == null ? null : Math.abs(b - a) + 1;
}

/** 1-based day number of `date` within a chapter starting on `from`. */
export function dayNumber(from: string | null, date: string | null): number | null {
  const a = dayIndex(from);
  const b = dayIndex(date);
  return a == null || b == null || b < a ? null : b - a + 1;
}

/** "110 photos & videos · 6 days". */
export function chapterStats(c: { photoCount: number; videoCount: number; itemCount: number; from: string | null; to: string | null }): string {
  const parts: string[] = [];
  const photos = c.photoCount + c.videoCount > 0 ? c.photoCount : c.itemCount;
  if (photos + c.videoCount > 0) parts.push(itemsPhrase(photos, c.videoCount));
  const days = spanDays(c.from, c.to);
  if (days) parts.push(plural(days, 'day', 'days'));
  return parts.join(' · ');
}

/** "0:42", "12:05", "1:02:09". */
export function fmtDuration(sec: number | null | undefined): string {
  if (!sec || !Number.isFinite(sec)) return '';
  const s = Math.max(1, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "Tuesday 12 August 2025 · 15:00" from a wall-clock time (the calendar date, not the 04:00 book day). */
export function fmtTaken(iso: string | null | undefined): string {
  const w = parseWall(iso);
  if (!w) return '';
  const ymd = `${String(w.y).padStart(4, '0')}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
  const plate = formatPlate(ymd);
  const time = formatTime(iso);
  return [plate?.full, time].filter(Boolean).join(' · ');
}

/** Year of a chapter for grouping on the Cover. */
export function chapterYear(c: { from: string | null; to: string | null }): string | null {
  const w = parseWall(c.from ?? c.to);
  return w ? String(w.y) : null;
}

/** Two-letter initials for an avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 1).join('').toUpperCase();
  return (Array.from(parts[0])[0] + Array.from(parts[parts.length - 1])[0]).toUpperCase();
}
