// Response shapes of the read-only M1 API (GET /api/atlas, GET /api/chapters/:id).

export type Kind = 'photo' | 'video';
export type ChapterStatus = 'upcoming' | 'ongoing' | 'past' | 'someday';

export interface ItemUrls {
  t400: string;
  t1200: string;
  /** For the largest images (a chapter's cover, full-width rows) on 2x/3x screens. */
  t2400: string;
  display: string;
  original: string;
  download: string;
}

export interface Item {
  id: string;
  kind: Kind;
  name: string;
  label: string;
  index: number | null;
  takenLocal: string | null;
  w: number | null;
  h: number | null;
  durationSec: number | null;
  hasDisplay: boolean;
  urls: ItemUrls;
  /** Client-side: the label when it reads as words; '' for bare numbers and camera file names. */
  caption: string;
}

export interface Person {
  name: string;
  color: string;
}

export interface ChapterSummary {
  id: string;
  title: string;
  from: string | null;
  to: string | null;
  status: ChapterStatus;
  range: string | null;
  itemCount: number;
  pageCount: number;
  photoCount: number;
  videoCount: number;
  cover: Item | null;
}

export interface AtlasIndex {
  schemaVersion: number;
  title: string;
  people: Person[];
  chapters: ChapterSummary[];
}

export interface Plate {
  weekday: string;
  day: string;
  month: string;
  long: string;
  full: string;
}

export interface Page {
  id: string;
  date: string | null;
  plate: Plate | null;
  items: string[];
}

export interface ChapterData {
  chapter: ChapterSummary;
  pages: Page[];
  items: Record<string, Item>;
}
