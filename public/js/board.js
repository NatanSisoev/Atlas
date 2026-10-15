// Board state and rendering: cards, strings (yarn), viewport and lazy thumbnails.
import { el, icon, fmtDuration, fmtSize, safeHttpUrl } from './ui.js';
import { thumbUrl } from './api.js';

export const state = {
  board: null,
  rev: 0,
  settings: { title: '', people: [] },
  selection: new Set(),
  selectedString: null,
  edit: false,
  tool: 'select',
  connectFrom: null,
  editingId: null,
};

export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

const stage = document.getElementById('stage');
const world = document.getElementById('world');
const cardsLayer = document.getElementById('cards');
const stringsLayer = document.getElementById('strings');
const SVGNS = 'http://www.w3.org/2000/svg';
const cardEls = new Map();

export const NOTE_COLORS = [
  { name: 'Sand', value: '#f3eee4' },
  { name: 'Butter', value: '#fdf3c4' },
  { name: 'Rose', value: '#fbe1df' },
  { name: 'Sky', value: '#dde9fb' },
  { name: 'Mint', value: '#dcf2e4' },
  { name: 'Lilac', value: '#ebe3fb' },
  { name: 'White', value: '#ffffff' },
];
// 'default' follows the theme (grey in light and dark).
export const YARN_COLORS = [
  { name: 'Grey', value: 'default' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Amber', value: '#f59e0b' },
];

export const cardById = (id) => state.board?.cards.find((c) => c.id === id);
export const elFor = (id) => cardEls.get(id);
export const isMedia = (c) => c.type === 'photo' || c.type === 'video';

export function newId(prefix = 'c') {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return prefix + Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export const maxZ = () => state.board.cards.reduce((m, c) => Math.max(m, c.z || 0), 0);

// Media cards: full-bleed image with a slim caption row underneath.
const CAPTION_H = 34;

/** Media card height for a given width and image aspect (h/w). */
export function polaroidHeight(w, aspect) {
  return Math.round(w * aspect + CAPTION_H);
}

export function mediaAspect(card) {
  return (card.h - CAPTION_H) / card.w;
}

// ---------------------------------------------------------------- viewport
export const view = { x: 0, y: 0, zoom: 1 };
let visRaf = 0;

export function applyViewport() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
  // Dot grid moves and scales with the canvas, doubling its spacing when zoomed far out.
  let grid = 24 * view.zoom;
  while (grid < 12) grid *= 2;
  stage.style.backgroundSize = `${grid}px ${grid}px`;
  stage.style.backgroundPosition = `${Math.round(view.x)}px ${Math.round(view.y)}px`;
  const pct = document.getElementById('zoomPct');
  if (pct) pct.textContent = `${Math.round(view.zoom * 100)}%`;
  if (state.board) state.board.viewport = { x: Math.round(view.x), y: Math.round(view.y), zoom: +view.zoom.toFixed(3) };
  if (!visRaf) visRaf = requestAnimationFrame(() => { visRaf = 0; updateVisibility(); });
}

export const screenToWorld = (sx, sy) => ({ x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom });

export function zoomAt(sx, sy, zoom) {
  const z = Math.min(4, Math.max(0.1, zoom));
  const p = screenToWorld(sx, sy);
  view.zoom = z;
  view.x = sx - p.x * z;
  view.y = sy - p.y * z;
  applyViewport();
}

export function viewCenter() {
  return screenToWorld(innerWidth / 2, innerHeight / 2);
}

export function bounds(cards = state.board.cards) {
  if (!cards.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cards) {
    x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function fitAll(animate = true) {
  const b = bounds();
  if (!b) { view.x = innerWidth / 2; view.y = innerHeight / 2; view.zoom = 1; applyViewport(); return; }
  const topPad = 80;
  const botPad = innerWidth <= 640 ? 90 : 70;
  const availW = innerWidth - 80;
  const availH = innerHeight - topPad - botPad;
  const zoom = Math.min(1.5, Math.max(0.1, Math.min(availW / b.w, availH / b.h)));
  const target = { zoom, x: innerWidth / 2 - (b.x + b.w / 2) * zoom, y: topPad + availH / 2 - (b.y + b.h / 2) * zoom };
  animateTo(target, animate ? 260 : 0);
}

export function animateTo(target, ms = 260) {
  if (!ms || matchMedia('(prefers-reduced-motion: reduce)').matches) { Object.assign(view, target); applyViewport(); return; }
  const from = { ...view };
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    view.x = from.x + (target.x - from.x) * e;
    view.y = from.y + (target.y - from.y) * e;
    view.zoom = from.zoom + (target.zoom - from.zoom) * e;
    applyViewport();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Load thumbnails only for cards near the screen, at a width that matches their on-screen size. */
export function updateVisibility() {
  if (!state.board) return;
  const margin = 0.6;
  const vw = innerWidth / view.zoom;
  const vh = innerHeight / view.zoom;
  const vx = -view.x / view.zoom - vw * margin;
  const vy = -view.y / view.zoom - vh * margin;
  const vx1 = vx + vw * (1 + 2 * margin);
  const vy1 = vy + vh * (1 + 2 * margin);
  const dpr = Math.min(2, devicePixelRatio || 1);
  for (const c of state.board.cards) {
    const node = cardEls.get(c.id);
    if (!node || !node._img) continue;
    if (c.x + c.w < vx || c.x > vx1 || c.y + c.h < vy || c.y > vy1) continue;
    const want = c.w * (c.type === 'file' ? 0.32 : 0.91) * view.zoom * dpr;
    const url = thumbUrl(c.src, want);
    if (!url) continue;
    const img = node._img;
    const step = Number(new URL(url, location.href).searchParams.get('w')) || 0;
    if (img._step >= step && img._srcRef === c.src) continue;
    img._step = step;
    img._srcRef = c.src;
    img.src = url;
  }
}

// ---------------------------------------------------------------- cards

function mediaImg(card, onMissing) {
  const img = el('img', { alt: '', decoding: 'async', draggable: false });
  img.addEventListener('load', () => {
    img.classList.add('loaded');
    if (card.needsAspect && img.naturalWidth && state.board && cardById(card.id) === card) {
      delete card.needsAspect;
      if (card.type === 'file') return;
      card.h = polaroidHeight(card.w, img.naturalHeight / img.naturalWidth);
      positionCard(card);
      renderStrings();
      emit('change', { silent: true });
    }
  });
  img.addEventListener('error', () => {
    if (img.getAttribute('src')) onMissing?.();
  });
  return img;
}

function missingLabel(card) {
  const s = card.src || {};
  if (s.kind === 'gopro') return 'GoPro item unavailable (link removed or revoked?)';
  if (s.kind === 'local') return `Missing file:\n${s.path}`;
  return 'File missing';
}

function buildMedia(card) {
  const shot = el('div.shot');
  const img = mediaImg(card, () => {
    shot.classList.add('missing');
    img.remove();
    shot.prepend(el('div.missing-label', { text: missingLabel(card), style: { whiteSpace: 'pre-line' } }));
  });
  shot.append(img);
  if (card.type === 'video') {
    shot.append(el('div.play-badge'));
    const d = fmtDuration(card.src?.durationSec);
    if (d) shot.append(el('div.duration', { text: d }));
  }
  if (card.src?.kind === 'gopro') shot.append(el('div.source-tag', { text: 'GoPro' }));
  const caption = el('div.caption', { text: card.caption || '', dataset: { ph: '' } });
  const node = el(`div.card.polaroid.${card.type}`, {}, el('div.body', {}, shot, caption));
  node._img = img;
  return node;
}

function buildNote(card) {
  const text = el('div.text', { text: card.text || '' });
  const fs = card.fontSize ? `${card.fontSize}px` : null;
  return el('div.card.note', { style: { '--note': card.color || NOTE_COLORS[0].value, ...(fs ? { '--fs': fs } : {}) } },
    el('div.body', {}, text));
}

function personColor(name) {
  const p = state.settings.people.find((x) => x.name === name);
  if (p) return p.color;
  const palette = ['#4a7bd0', '#d0614a', '#3f9b6b', '#a557c9', '#c98a1d'];
  return palette[hash(String(name || '')) % palette.length];
}

function buildMessage(card) {
  const bubble = el('div.bubble', { text: card.text || '' });
  if (card.at) bubble.append(el('span.at', { text: card.at }));
  const body = el('div.body', {});
  if (card.from) body.append(el('div.from', { text: card.from }));
  body.append(bubble);
  return el(`div.card.message${card.mine ? '.mine' : ''}`, { style: { '--person': personColor(card.from) } }, body);
}

function buildFile(card) {
  const s = card.src || {};
  const name = s.name || card.title || 'File';
  const ext = (name.match(/\.([a-z0-9]{1,6})$/i)?.[1] || 'file').toUpperCase();
  const previewable = /^(image|video)\//.test(s.mime || '') || s.mime === 'application/pdf';
  const stub = el('div.stub');
  let img = null;
  if (previewable && s.kind === 'upload') {
    img = mediaImg(card, () => { img.remove(); stub.append(el('div.ext', { text: ext })); });
    stub.append(img);
  } else stub.append(el('div.ext', { text: ext }));
  const main = el('div.main', {},
    el('div.kind', { text: s.mime === 'application/pdf' ? 'Document' : /^image\//.test(s.mime || '') ? 'Image' : 'File' }),
    el('div.name', { text: card.title || name }),
  );
  if (card.caption) main.append(el('div.note-line', { text: card.caption }));
  main.append(el('div.meta', { text: [ext, fmtSize(s.size)].filter(Boolean).join(' · ') }));
  const node = el('div.card.file', {}, el('div.body', {}, el('div.ticket', {}, stub, main)));
  node._img = img;
  return node;
}

function buildLink(card) {
  const url = safeHttpUrl(card.url);
  let host = '';
  try { host = url ? new URL(url).host.replace(/^www\./, '') : 'invalid link'; } catch {}
  return el('div.card.link', {},
    el('div.body', {},
      el('div.title', { text: card.title || host || 'Link' }),
      el('div.host', {}, icon('globe'), el('span', { text: host })),
    ));
}

function buildFrame(card) {
  return el('div.card.frame', {}, el('div.body'), el('div.frame-label', { text: card.title || '' }));
}

const BUILDERS = { photo: buildMedia, video: buildMedia, note: buildNote, message: buildMessage, file: buildFile, link: buildLink, frame: buildFrame };

export function positionCard(card, node = cardEls.get(card.id)) {
  if (!node) return;
  node.style.transform = `translate(${card.x}px, ${card.y}px) rotate(${card.rot || 0}deg)`;
  node.style.width = `${card.w}px`;
  node.style.height = `${card.h}px`;
  node.style.zIndex = String((card.type === 'frame' ? 0 : 500000) + Math.round(card.z || 0));
}

export function renderCard(card) {
  const old = cardEls.get(card.id);
  const node = (BUILDERS[card.type] || buildNote)(card);
  node.dataset.id = card.id;
  if (state.selection.has(card.id)) node.classList.add('selected');
  if (state.connectFrom === card.id) node.classList.add('connect-from');
  positionCard(card, node);
  if (old) {
    // Keep an already-loaded image to avoid flicker.
    if (old._img && node._img && old._img.src && old._img._srcRef === card.src) {
      node._img.replaceWith(old._img);
      node._img = old._img;
    }
    old.replaceWith(node);
  } else cardsLayer.append(node);
  cardEls.set(card.id, node);
  if (state.selection.size === 1 && state.selection.has(card.id)) addHandles(node, card);
  return node;
}

function addHandles(node, card) {
  if (!state.edit) return;
  node.append(el('div.handle.resize', { dataset: { handle: 'resize' }, title: 'Resize' }));
  if (card.type !== 'frame') node.append(el('div.handle.rotate', { dataset: { handle: 'rotate' }, title: 'Rotate' }));
}

export function renderAll() {
  cardsLayer.textContent = '';
  cardEls.clear();
  for (const c of state.board.cards) renderCard(c);
  renderStrings();
  updateEmpty();
  updateVisibility();
}

export function updateEmpty() {
  document.getElementById('empty').hidden = Boolean(state.board?.cards.length);
}

/** Re-render selection outlines and handles. */
export function refreshSelection() {
  for (const [id, node] of cardEls) {
    const sel = state.selection.has(id);
    node.classList.toggle('selected', sel);
    node.classList.toggle('connect-from', state.connectFrom === id);
    node.querySelectorAll(':scope > .handle').forEach((h) => h.remove());
    if (sel && state.selection.size === 1) addHandles(node, cardById(id));
  }
  renderStrings();
  emit('selection');
}

export function removeCardEl(id) {
  cardEls.get(id)?.remove();
  cardEls.delete(id);
}

// ---------------------------------------------------------------- connections
const center = (c) => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 });

/** Where the line from c's centre towards p leaves c's box (plus a small gap). */
function edgePoint(c, p) {
  const o = center(c);
  const dx = p.x - o.x;
  const dy = p.y - o.y;
  if (!dx && !dy) return o;
  const t = Math.min(dx ? (c.w / 2 + 6) / Math.abs(dx) : Infinity, dy ? (c.h / 2 + 6) / Math.abs(dy) : Infinity);
  return { x: o.x + dx * Math.min(1, t), y: o.y + dy * Math.min(1, t) };
}

/** A gentle curve between two points. */
export function yarnPath(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const bend = Math.min(40, Math.hypot(dx, dy) * 0.08);
  const len = Math.hypot(dx, dy) || 1;
  const mx = (a.x + b.x) / 2 - (dy / len) * bend;
  const my = (a.y + b.y) / 2 + (dx / len) * bend;
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

const lineColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') && !['#b3261e'].includes(c) ? c : 'var(--muted)');

export function renderStrings(live = null) {
  stringsLayer.textContent = '';
  if (!state.board) return;
  const get = (id) => live?.get(id) || cardById(id);
  const mk = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  for (const s of state.board.strings) {
    const A = get(s.from);
    const B = get(s.to);
    if (!A || !B) continue;
    const a = edgePoint(A, center(B));
    const b = edgePoint(B, center(A));
    const d = yarnPath(a, b);
    const color = lineColor(s.color);
    const g = document.createElementNS(SVGNS, 'g');
    g.dataset.string = s.id;
    if (state.selectedString === s.id) g.classList.add('selected');
    const line = mk('path', { d, class: 'yarn', 'stroke-width': '2' });
    line.style.stroke = color;
    const ends = [a, b].map((p) => { const e = mk('circle', { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: '4', class: 'end' }); e.style.fill = color; return e; });
    const hit = mk('path', { d, class: 'hit' });
    hit.dataset.string = s.id;
    g.append(line, ...ends, hit);
    stringsLayer.append(g);
  }
}

export function setEditMode(on) {
  state.edit = on;
  document.body.classList.toggle('edit-mode', on);
  const btn = document.getElementById('lockBtn');
  btn.setAttribute('aria-pressed', String(!on));
  btn.querySelector('.lock-label').textContent = on ? 'Edit' : 'Locked';
  btn.title = on ? 'Editing — tap to lock (E)' : 'Locked: pan and view only — tap to edit (E)';
  if (!on) { state.tool = 'select'; state.connectFrom = null; document.getElementById('connectBtn').setAttribute('aria-pressed', 'false'); stage.classList.remove('connecting'); }
  refreshSelection();
}

/** Normalise z to 1..n (frames first) so it never grows unbounded. */
export function normaliseZ(board) {
  const sorted = [...board.cards].sort((a, b) => (b.type === 'frame') - (a.type === 'frame') || (a.z || 0) - (b.z || 0));
  sorted.forEach((c, i) => (c.z = i + 1));
}
