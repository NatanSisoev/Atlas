// Justified rows that never crop: every tile keeps its photo's aspect ratio.
import justifiedLayout from 'justified-layout';

export interface Tile {
  id: string;
  width: number;
  height: number;
  aspect: number;
}

export interface Row {
  tiles: Tile[];
  height: number;
  /** The row does not fill the measure (a last row kept small); it starts at the left edge. */
  short: boolean;
}

export interface RowOptions {
  width: number;
  target: number;
  spacing: number;
  /** Largest height for a page that fits in a single row (one or two photos). */
  maxSingle: number;
}

/** The library's own tolerance: rows between 0.75× and 1.25× the target height. */
const TOLERANCE = 0.25;

const clampAspect = (a: number) => (Number.isFinite(a) && a > 0 ? Math.min(6, Math.max(0.2, a)) : 4 / 3);
const sumOf = (tiles: { aspect: number }[]) => tiles.reduce((acc, t) => acc + t.aspect, 0);
/** The height at which these tiles exactly fill `width`. */
const fullHeight = (tiles: { aspect: number }[], width: number, spacing: number) =>
  (width - spacing * (tiles.length - 1)) / sumOf(tiles);

/** Lay `tiles` out at height `h`; a row that fills the measure ends exactly at its edge. */
function place(tiles: Tile[], h: number, width: number, spacing: number): Row {
  const height = Math.max(1, Math.round(h));
  let used = 0;
  const out = tiles.map((t) => {
    const w = Math.max(1, Math.round(t.aspect * h));
    used += w;
    return { ...t, width: w, height };
  });
  used += spacing * (out.length - 1);
  const full = fullHeight(tiles, width, spacing);
  if (used > width || (h >= full - 0.01 && used !== width)) {
    // Rounding: the last tile absorbs the difference.
    out[out.length - 1].width -= used - width;
    used = width;
  }
  return { tiles: out, height, short: used < width - 1 };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function layoutRows(ids: string[], aspects: number[], opts: RowOptions): Row[] {
  const { width, target, spacing } = opts;
  if (!(width > 0) || ids.length === 0) return [];
  const ratios = aspects.map(clampAspect);
  const geo = justifiedLayout(ratios, {
    containerWidth: width,
    containerPadding: 0,
    boxSpacing: { horizontal: spacing, vertical: spacing },
    targetRowHeight: target,
    targetRowHeightTolerance: TOLERANCE,
    showWidows: true,
  });

  const rows: Row[] = [];
  let lastTop = Number.NaN;
  geo.boxes.forEach((box, i) => {
    if (Math.abs(box.top - lastTop) > 0.5 || rows.length === 0) {
      rows.push({ tiles: [], height: box.height, short: false });
      lastTop = box.top;
    }
    rows[rows.length - 1].tiles.push({ id: ids[i], width: box.width, height: box.height, aspect: ratios[i] });
  });
  if (geo.widowCount === 0 || rows.length === 0) return rows;

  // The library leaves the last row (the widow) at the target height, left-aligned. In a book:
  // 1. a widow that is mostly empty borrows from the row above, when both can then fill the
  //    measure within the usual tolerance;
  // 2. otherwise a widow that can fill the measure at about the target height simply does;
  // 3. otherwise it stays small (no taller than the rows above) and starts at the left edge, under
  //    the plate and the captions. A page of one or two photos may be large.
  const n = rows.length;
  const widow = rows[n - 1];
  const widowFill = (sumOf(widow.tiles) * target + spacing * (widow.tiles.length - 1)) / width;
  if (n >= 2 && widowFill < 0.6) {
    const both = [...rows[n - 2].tiles, ...widow.tiles];
    let best: { k: number; err: number; h1: number; h2: number } | null = null;
    for (let k = 1; k < both.length; k++) {
      const h1 = fullHeight(both.slice(0, k), width, spacing);
      const h2 = fullHeight(both.slice(k), width, spacing);
      const err = Math.max(Math.abs(h1 - target), Math.abs(h2 - target));
      if (!best || err < best.err) best = { k, err, h1, h2 };
    }
    const ok = (h: number) => h >= target * (1 - TOLERANCE) && h <= target * (1 + TOLERANCE);
    if (best && ok(best.h1) && ok(best.h2)) {
      rows[n - 2] = place(both.slice(0, best.k), best.h1, width, spacing);
      rows[n - 1] = place(both.slice(best.k), best.h2, width, spacing);
      return rows;
    }
  }
  const full = fullHeight(widow.tiles, width, spacing);
  const cap =
    n === 1
      ? opts.maxSingle
      : full <= target * (1 + TOLERANCE)
        ? full
        : Math.min(target, median(rows.slice(0, -1).map((r) => r.height)));
  rows[n - 1] = place(widow.tiles, Math.min(full, cap), width, spacing);
  return rows;
}
