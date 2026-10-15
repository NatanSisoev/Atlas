// Export a board as PDF through the browser's print dialog ("Save as PDF").
// The whole board is laid out on one page sized to fit it, in light colours, with sharp images.
import { state, view, bounds, elFor, applyViewport, updateVisibility } from './board.js';
import { thumbUrl } from './api.js';
import { toast } from './ui.js';

const MARGIN = 48;
const HEAD = 56;
const MAX_PAGE = 14000; // px; keeps the page within PDF size limits

const world = document.getElementById('world');
const stage = document.getElementById('stage');
let pageStyle = null;
let saved = null;

function layout() {
  const b = bounds();
  if (!b) return null;
  const scale = Math.min(1, MAX_PAGE / Math.max(b.w, b.h));
  const w = Math.ceil(b.w * scale + MARGIN * 2);
  const h = Math.ceil(b.h * scale + MARGIN * 2 + HEAD);
  return { b, scale, w, h };
}

function apply(l) {
  saved = saved || { ...view };
  pageStyle?.remove();
  pageStyle = document.createElement('style');
  pageStyle.textContent = `@page { size: ${l.w}px ${l.h}px; margin: 0; }`;
  document.head.append(pageStyle);
  document.body.classList.add('printing');
  stage.style.setProperty('--print-w', `${l.w}px`);
  stage.style.setProperty('--print-h', `${l.h}px`);
  world.style.transform = `translate(${MARGIN - l.b.x * l.scale}px, ${MARGIN + HEAD - l.b.y * l.scale}px) scale(${l.scale})`;

  let head = document.getElementById('print-head');
  if (!head) {
    head = document.createElement('div');
    head.id = 'print-head';
    stage.append(head);
  }
  head.textContent = '';
  const t = document.createElement('div');
  t.className = 'ph-title';
  t.textContent = state.board.title || 'Board';
  const m = document.createElement('div');
  m.className = 'ph-meta';
  const n = state.board.cards.length;
  m.textContent = `${n} ${n === 1 ? 'item' : 'items'} · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;
  head.append(t, m);
}

function restore() {
  document.body.classList.remove('printing');
  pageStyle?.remove();
  pageStyle = null;
  document.getElementById('print-head')?.remove();
  if (saved) { Object.assign(view, saved); saved = null; }
  applyViewport();
  updateVisibility();
}

/** Load every card's image at print resolution; resolves when done or after a timeout. */
async function loadImages(scale) {
  const waits = [];
  for (const c of state.board.cards) {
    const node = elFor(c.id);
    const img = node?._img;
    if (!img || !c.src) continue;
    const share = c.type === 'file' ? 0.3 : 1;
    const url = thumbUrl(c.src, c.w * share * scale * 2);
    if (!url) continue;
    const step = Number(new URL(url, location.href).searchParams.get('w')) || 0;
    if (!(img._step >= step && img.complete && img.naturalWidth)) {
      img._step = step;
      img._srcRef = c.src;
      img.src = url;
    }
    waits.push(img.decode().catch(() => {}));
  }
  await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 20000))]);
}

export async function exportPdf() {
  const l = layout();
  if (!l) { toast('The board is empty.'); return; }
  const done = toast('Preparing the PDF…', { timeout: 0 });
  document.activeElement?.blur?.();
  apply(l);
  await loadImages(l.scale);
  done();
  // Let layout settle, then open the print dialog; the user picks "Save as PDF".
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.print();
}

// Ctrl+P works too (images already on screen are used as they are).
addEventListener('beforeprint', () => {
  if (!document.body.classList.contains('printing') && state.board) {
    const l = layout();
    if (l) apply(l);
  }
});
addEventListener('afterprint', restore);
