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
  /** Rows that do not fill the measure (a lone last row) sit centred. */
  centered: boolean;
}

export interface RowOptions {
  width: number;
  target: number;
  spacing: number;
  /** Largest height for a page that fits in a single row (one or two photos). */
  maxSingle: number;
}

const clampAspect = (a: number) => (Number.isFinite(a) && a > 0 ? Math.min(6, Math.max(0.2, a)) : 4 / 3);

export function layoutRows(ids: string[], aspects: number[], opts: RowOptions): Row[] {
  const { width, target, spacing } = opts;
  if (!(width > 0) || ids.length === 0) return [];
  const ratios = aspects.map(clampAspect);
  const geo = justifiedLayout(ratios, {
    containerWidth: width,
    containerPadding: 0,
    boxSpacing: { horizontal: spacing, vertical: spacing },
    targetRowHeight: target,
    targetRowHeightTolerance: 0.25,
    showWidows: true,
  });

  const rows: Row[] = [];
  let lastTop = Number.NaN;
  geo.boxes.forEach((box, i) => {
    if (Math.abs(box.top - lastTop) > 0.5 || rows.length === 0) {
      rows.push({ tiles: [], height: box.height, centered: false });
      lastTop = box.top;
    }
    rows[rows.length - 1].tiles.push({ id: ids[i], width: box.width, height: box.height, aspect: ratios[i] });
  });

  // The library leaves widows at the target height, left-aligned. In a book a last row that can
  // fill the measure at a modest size simply does (an almost-full row looks misaligned); one that
  // would get too tall reads better slightly larger and centred. A page of one or two photos may
  // be large.
  if (geo.widowCount > 0 && rows.length > 0) {
    const row = rows[rows.length - 1];
    const sum = row.tiles.reduce((acc, t) => acc + t.aspect, 0);
    const full = (width - spacing * (row.tiles.length - 1)) / sum;
    const cap = rows.length === 1 ? opts.maxSingle : full <= target * 1.6 ? full : target * 1.3;
    const h = Math.max(1, Math.min(full, cap));
    let used = 0;
    row.tiles = row.tiles.map((t) => {
      const w = Math.round(t.aspect * h);
      used += w;
      return { ...t, width: w, height: Math.round(h) };
    });
    used += spacing * (row.tiles.length - 1);
    if (used > width || (h >= full && used !== width)) {
      // Rounding: a row that fills the measure ends exactly at its edge.
      const last = row.tiles[row.tiles.length - 1];
      last.width -= used - width;
      used = width;
    }
    row.height = Math.round(h);
    row.centered = used < width - 1;
  }
  return rows;
}
