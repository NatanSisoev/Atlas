// @ts-check
// Local-time helpers shared by the server and the web client. Pure functions, no dependencies.
// Times are wall-clock ISO strings as the camera wrote them ("2025-08-12T15:00:19" with an
// optional "+03:00"/"Z" suffix). The suffix is ignored: the book is read in local time.

/** A "day" runs from 04:00 to 03:59 the next morning, so late nights stay on their evening. */
export const DAY_START_HOUR = 4;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * @typedef {{ y: number, m: number, d: number, hasTime: boolean, h: number, min: number, s: number }} Wall
 */

/**
 * Wall-clock components as written; null when malformed or out of range.
 * @param {unknown} iso
 * @returns {Wall | null}
 */
export function parseWall(iso) {
  if (typeof iso !== 'string') return null;
  const m = WALL_RE.exec(iso.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = Number(m[4] || 0), min = Number(m[5] || 0), s = Number(m[6] || 0);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || min > 59 || s > 59) return null;
  return { y, m: mo, d, hasTime: m[4] !== undefined, h, min, s };
}

/** @param {number} y @param {number} m 1-based */
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const pad = (/** @type {number} */ n, w = 2) => String(n).padStart(w, '0');

/** @param {Date} dt a UTC-midnight date */
const ymdOf = (dt) => `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;

/**
 * Sortable wall-clock key "YYYY-MM-DDTHH:MM:SS"; null when invalid.
 * @param {unknown} iso
 * @returns {string | null}
 */
export function wallKey(iso) {
  const w = parseWall(iso);
  return w && `${pad(w.y, 4)}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.min)}:${pad(w.s)}`;
}

/**
 * The local day an instant belongs to (04:00 boundary): 'YYYY-MM-DD' or null.
 * A date-only string is already a day and is returned as is.
 * @param {unknown} iso
 * @returns {string | null}
 */
export function localDay(iso) {
  const w = parseWall(iso);
  if (!w) return null;
  const back = w.hasTime && w.h < DAY_START_HOUR ? 1 : 0;
  return ymdOf(new Date(Date.UTC(w.y, w.m - 1, w.d - back)));
}

/**
 * Today's local day on this machine's clock (04:00 boundary).
 * @param {Date} [now]
 * @returns {string}
 */
export function todayYmd(now = new Date()) {
  return ymdOf(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - (now.getHours() < DAY_START_HOUR ? 1 : 0))));
}

/**
 * @param {unknown} ymd
 * @returns {{ y: number, m: number, d: number, wd: number } | null}
 */
function parseYmd(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const w = parseWall(ymd);
  return w && { y: w.y, m: w.m, d: w.d, wd: new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay() };
}

/**
 * Parts for a page plate, e.g. { weekday: 'TUE', day: '12', month: 'AUG', long: 'Tue 12 Aug', full: 'Tuesday 12 August 2025' }.
 * @param {unknown} ymd
 * @returns {{ weekday: string, day: string, month: string, long: string, full: string } | null}
 */
export function formatPlate(ymd) {
  const p = parseYmd(ymd);
  if (!p) return null;
  const wd = WEEKDAYS[p.wd], mo = MONTHS[p.m - 1];
  return {
    weekday: wd.slice(0, 3).toUpperCase(),
    day: String(p.d),
    month: mo.slice(0, 3).toUpperCase(),
    long: `${wd.slice(0, 3)} ${p.d} ${mo.slice(0, 3)}`,
    full: `${wd} ${p.d} ${mo} ${p.y}`,
  };
}

/**
 * '10–14 Aug 2025', '30 Aug – 2 Sep 2025', '28 Dec 2025 – 3 Jan 2026', '12 Aug 2025'; null without dates.
 * A missing end is treated as a single day.
 * @param {string | null | undefined} fromYmd
 * @param {string | null | undefined} toYmd
 * @returns {string | null}
 */
export function formatRange(fromYmd, toYmd) {
  let a = parseYmd(fromYmd) || parseYmd(toYmd);
  let b = parseYmd(toYmd) || a;
  if (!a || !b) return null;
  if (a.y * 10000 + a.m * 100 + a.d > b.y * 10000 + b.m * 100 + b.d) [a, b] = [b, a];
  const mon = (/** @type {{ m: number }} */ p) => MONTHS[p.m - 1].slice(0, 3);
  if (a.y !== b.y) return `${a.d} ${mon(a)} ${a.y} – ${b.d} ${mon(b)} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${mon(a)} – ${b.d} ${mon(b)} ${b.y}`;
  if (a.d !== b.d) return `${a.d}–${b.d} ${mon(b)} ${b.y}`;
  return `${a.d} ${mon(a)} ${a.y}`;
}

/**
 * Where a chapter stands relative to today. No dates at all means 'someday'.
 * @param {string | null | undefined} from
 * @param {string | null | undefined} to
 * @param {string} todayYmdStr
 * @returns {'upcoming' | 'ongoing' | 'past' | 'someday'}
 */
export function chapterStatus(from, to, todayYmdStr) {
  const start = parseYmd(from) ? from : parseYmd(to) ? to : null;
  const end = parseYmd(to) ? to : start;
  if (!start || !end) return 'someday';
  if (todayYmdStr < start) return 'upcoming';
  if (todayYmdStr > end) return 'past';
  return 'ongoing';
}

/**
 * '15:00' from the wall clock as written; null without a time.
 * @param {unknown} iso
 * @returns {string | null}
 */
export function formatTime(iso) {
  const w = parseWall(iso);
  return w && w.hasTime ? `${pad(w.h)}:${pad(w.min)}` : null;
}
