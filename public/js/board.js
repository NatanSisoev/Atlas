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
  { name: 'Yellow', value: '#fff27a' },
  { name: 'Pink', value: '#ffc2d4' },
  { name: 'Blue', value: '#b9e3ff' },
  { name: 'Green', value: '#c8f2b4' },
  { name: 'Orange', value: '#ffd29a' },
  { name: 'Lilac', value: '#ddd0ff' },
  { name: 'White', value: '#fbf9f4' },
];
export const YARN_COLORS = [
  { name: 'Red yarn', value: '#b3261e' },
  { name: 'Blue yarn', value: '#2a5db0' },
  { name: 'Green yarn', value: '#2e7d32' },
  { name: 'Gold yarn', value: '#c99a1d' },
  { name: 'Black yarn', value: '#2b2522' },
];
const PIN_COLORS = ['#d0352a', '#d0352a', '#2a6fd0', '#e0a81c', '#2e9b4f', '#d0352a', '#7a3fc0'];

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

/** Polaroid height for a given width and image aspect (h/w). */
export function polaroidHeight(w, aspect) {
  const pad = w * 0.045;
  return Math.round(pad + (w - 2 * pad) * aspect + 46);
}

export function mediaAspect(card) {
  const pad = card.w * 0.045;
  return (card.h - 46 - pad) / (card.w - 2 * pad);
}

// ---------------------------------------------------------------- viewport
export const view = { x: 0, y: 0, zoom: 1 };
let visRaf = 0;

export function applyViewport() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
  const bx = Math.round(view.x);
  const by = Math.round(view.y);
  stage.style.backgroundPosition = `${bx}px ${by}px, ${bx}px ${by}px, ${bx}px ${by}px`;
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
function pin(card) {
  return el('div.pin', { style: { '--pin': PIN_COLORS[hash(card.id) % PIN_COLORS.length] } });
}

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
  const node = el(`div.card.polaroid.${card.type}`, {}, el('div.body', {}, shot, caption), pin(card));
  node._img = img;
  return node;
}

function buildNote(card) {
  const text = el('div.text', { text: card.text || '' });
  const fs = card.fontSize ? `${card.fontSize}px` : null;
  return el('div.card.note', { style: { '--note': card.color || NOTE_COLORS[0].value, ...(fs ? { '--fs': fs } : {}) } },
    el('div.body', {}, text), pin(card));
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
    ),
    pin(card));
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

// ---------------------------------------------------------------- strings
export function pinPoint(c) {
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  const top = c.type === 'message' || c.type === 'file' ? 4 : 1;
  const dx = 0;
  const dy = -c.h / 2 + top;
  const a = ((c.rot || 0) * Math.PI) / 180;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

export function yarnPath(a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const sag = Math.min(160, 14 + d * 0.16);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 + sag;
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

export function renderStrings(live = null) {
  stringsLayer.textContent = '';
  if (!state.board) return;
  const pos = (id) => {
    const c = live?.get(id) || cardById(id);
    return c ? pinPoint(c) : null;
  };
  for (const s of state.board.strings) {
    const a = pos(s.from);
    const b = pos(s.to);
    if (!a || !b) continue;
    const d = yarnPath(a, b);
    const g = document.createElementNS(SVGNS, 'g');
    g.dataset.string = s.id;
    if (state.selectedString === s.id) g.classList.add('selected');
    const shadow = document.createElementNS(SVGNS, 'path');
    shadow.setAttribute('d', d);
    shadow.setAttribute('class', 'yarn-shadow');
    shadow.setAttribute('transform', 'translate(2 5)');
    shadow.setAttribute('stroke-width', '3');
    const yarn = document.createElementNS(SVGNS, 'path');
    yarn.setAttribute('d', d);
    yarn.setAttribute('class', 'yarn');
    yarn.setAttribute('stroke', /^#[0-9a-f]{3,8}$/i.test(s.color) ? s.color : '#b3261e');
    yarn.setAttribute('stroke-width', '3');
    const hit = document.createElementNS(SVGNS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'hit');
    hit.dataset.string = s.id;
    g.append(shadow, yarn, hit);
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
