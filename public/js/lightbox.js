// Full-screen viewer for photos, videos, documents and notes, with prev/next and swipe.
import { el, icon, fmtDuration } from './ui.js';
import { viewUrl, originalUrl, thumbUrl } from './api.js';
import { state, isMedia } from './board.js';

const box = document.getElementById('lightbox');
const media = box.querySelector('.lb-media');
const caption = box.querySelector('.lb-caption');
const actions = box.querySelector('.lb-actions');
let list = [];
let index = 0;
let lastFocus = null;
let openedAt = 0;

export const lightboxOpen = () => !box.hidden;

/** Cards worth browsing, in reading order (top-to-bottom, left-to-right rows). */
function viewable() {
  const cards = state.board.cards.filter((c) => isMedia(c) || (c.type === 'file' && c.src?.kind === 'upload'));
  return cards.sort((a, b) => (Math.abs(a.y - b.y) < 120 ? a.x - b.x : a.y - b.y));
}

export function openLightbox(card) {
  list = viewable();
  index = list.findIndex((c) => c.id === card.id);
  if (index < 0) { list = [card]; index = 0; }
  lastFocus = document.activeElement;
  openedAt = performance.now();
  box.hidden = false;
  show();
  box.querySelector('.lb-close').focus({ preventScroll: true });
}

export function closeLightbox() {
  if (box.hidden) return;
  stopMedia();
  box.hidden = true;
  media.textContent = '';
  lastFocus?.focus?.({ preventScroll: true });
}

function stopMedia() {
  media.querySelectorAll('video').forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
}

function action(label, iconName, href, { download = false, newTab = true } = {}) {
  const a = el('a', { href, ...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {}), ...(download ? { download: '' } : {}) }, icon(iconName), el('span', { text: label }));
  actions.append(a);
}

function show() {
  stopMedia();
  media.textContent = '';
  actions.textContent = '';
  caption.textContent = '';
  const card = list[index];
  if (!card) return closeLightbox();
  const s = card.src || {};
  box.querySelector('.lb-prev').hidden = list.length < 2;
  box.querySelector('.lb-next').hidden = list.length < 2;

  const title = card.caption || card.title || s.label || s.name || s.filename || '';
  caption.append(el('span', { text: title }));
  const when = s.capturedAt ? String(s.capturedAt).replace('T', ' ').slice(0, 16) : '';
  const meta = [when, list.length > 1 ? `${index + 1} / ${list.length}` : ''].filter(Boolean).join(' · ');
  if (meta) caption.append(el('small', { text: meta }));

  if (card.type === 'video') {
    const v = el('video', { controls: true, playsInline: true, preload: 'metadata', autoplay: true });
    v.setAttribute('playsinline', '');
    const poster = thumbUrl(s, 1200);
    if (poster) v.poster = poster;
    let triedProxy = false;
    v.addEventListener('error', () => {
      // GoPro's CDN labels videos as octet-stream; some players (iOS) need them via our server.
      if (s.kind === 'gopro' && !triedProxy) {
        triedProxy = true;
        v.src = `${viewUrl(s)}?via=server`;
        v.play().catch(() => {});
        return;
      }
      media.textContent = '';
      media.append(el('div.lb-msg', { text: s.kind === 'local' && /\.(mov|mp4)$/i.test(s.path || '') && !s.hasDisplay
        ? 'This browser cannot play this video (probably HEVC/4K). Use "Open original" or add a 1080p H.264 copy to the display folder.'
        : 'This video could not be played.' }));
    });
    v.src = viewUrl(s);
    media.append(v);
    if (s.durationSec) caption.lastChild?.append?.(` · ${fmtDuration(s.durationSec)}`);
  } else if (card.type === 'photo') {
    const img = el('img', { alt: title, decoding: 'async' });
    const low = thumbUrl(s, 800);
    if (low) img.src = low;
    const full = viewUrl(s);
    if (full && full !== low) {
      const pre = new Image();
      pre.onload = () => { if (list[index] === card) img.src = full; };
      pre.src = full;
    }
    img.addEventListener('error', () => { media.textContent = ''; media.append(el('div.lb-msg', { text: 'This photo is not available.' })); });
    media.append(img);
  } else if (card.type === 'file') {
    const url = viewUrl(s);
    if (s.mime === 'application/pdf') media.append(el('iframe', { src: url, title: s.name || 'Document' }));
    else if (/^image\//.test(s.mime || '') && s.mime !== 'image/svg+xml') media.append(el('img', { src: url, alt: s.name || '' }));
    else if (/^video\//.test(s.mime || '')) media.append(el('video', { src: url, controls: true, playsInline: true }));
    else media.append(el('div.lb-msg', { text: `${s.name || 'This file'} can't be previewed here. Use Download.` }));
  } else if (card.type === 'note' || card.type === 'message') {
    media.append(el('div.lb-note', { text: card.text || '', style: { background: card.type === 'note' ? (card.color || '#fff27a') : '#fff' } }));
  }

  if (s.kind === 'local') {
    action(card.type === 'video' ? 'Open original (4K)' : 'Open original', 'open', originalUrl(s));
    action('Download', 'download', originalUrl(s, true), { download: true, newTab: false });
  } else if (s.kind === 'gopro') {
    action('Open original', 'open', originalUrl(s));
  } else if (s.kind === 'upload') {
    action('Open', 'open', originalUrl(s));
    action('Download', 'download', originalUrl(s, true), { download: true, newTab: false });
  }
}

function step(d) {
  if (list.length < 2) return;
  index = (index + d + list.length) % list.length;
  show();
}

box.querySelector('.lb-prev').addEventListener('click', () => step(-1));
box.querySelector('.lb-next').addEventListener('click', () => step(1));
box.querySelector('.lb-close').addEventListener('click', closeLightbox);
// Ignore the click that a touch tap synthesises right after opening (it would land on the backdrop).
media.addEventListener('click', (e) => { if (e.target === media && performance.now() - openedAt > 500) closeLightbox(); });
document.addEventListener('keydown', (e) => {
  if (box.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
});

// Swipe left/right (ignores swipes that start on video controls area at the bottom).
let swipe = null;
box.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || e.target.closest('video, iframe, .lb-bar, button')) return;
  swipe = { x: e.clientX, y: e.clientY, t: performance.now() };
});
box.addEventListener('pointerup', (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  const fast = performance.now() - swipe.t < 600;
  swipe = null;
  if (fast && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  else if (fast && dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) closeLightbox();
});
