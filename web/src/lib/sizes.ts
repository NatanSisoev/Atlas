// `sizes` for images that fill a box with object-fit: cover. The browser picks a srcset candidate
// by the slot width, but a cover crop needs the photo wider than the box when the box is taller
// than the photo's shape (a landscape photo in a tall phone hero).
import type { Item } from './types';

/** "1200w, 2400w" candidates of an item's large thumbnails. */
export function largeSrcset(it: Item): string {
  return [it.urls.t1200 && `${it.urls.t1200} 1200w`, it.urls.t2400 && `${it.urls.t2400} 2400w`].filter(Boolean).join(', ');
}

/** The css width the photo is drawn at when it covers a boxW × boxH box. */
export function coverSizes(boxW: number, boxH: number, it: Item | null): string {
  const aspect = it && it.w && it.h ? it.w / it.h : 1.5;
  return `${Math.max(1, Math.ceil(Math.max(boxW, boxH * aspect)))}px`;
}
