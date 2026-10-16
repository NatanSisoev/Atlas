// Words for a page plate: a small date line (kicker) and a title.
import { dayNumber, spanDays } from './format';
import type { ChapterSummary, Page } from './types';

export interface PlateText {
  kicker: string;
  title: string;
}

/**
 * Short chapters (a trip) number their days: "TUE 12 AUG" / "Day 3". Longer ones name the date:
 * "2025" / "Tuesday 12 August". Pages without a date are "Undated".
 */
export function plateText(chapter: Pick<ChapterSummary, 'from' | 'to'>, page: Page): PlateText {
  if (!page.date || !page.plate) return { kicker: '', title: 'Undated' };
  const p = page.plate;
  const span = spanDays(chapter.from, chapter.to);
  const year = page.date.slice(0, 4);
  const multiYear = (chapter.from ?? '').slice(0, 4) !== (chapter.to ?? '').slice(0, 4);
  const n = span && span > 1 && span <= 31 ? dayNumber(chapter.from, page.date) : null;
  if (n) return { kicker: `${p.weekday} ${p.day} ${p.month}${multiYear ? ` ${year}` : ''}`, title: `Day ${n}` };
  const fullNoYear = p.full.replace(/\s\d{4}$/, '');
  return { kicker: year, title: fullNoYear || p.long };
}
