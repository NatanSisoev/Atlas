// Atlas app: boards, toolbar, editing, keyboard, and wiring between modules.
import { api } from './api.js';
import { el, icon, toast, showMenu, closeMenu, menuOpen, dialog, prompt, confirm, isDialogOpen, safeHttpUrl, isTouch } from './ui.js';
import {
  state, bus, view, applyViewport, zoomAt, fitAll, viewCenter, renderAll, renderCard, renderStrings, refreshSelection,
  removeCardEl, updateEmpty, updateVisibility, cardById, elFor, newId, maxZ, polaroidHeight, isMedia, setEditMode,
  normaliseZ, NOTE_COLORS, YARN_COLORS, positionCard, animateTo,
} from './board.js';
import { createUndo } from './undo.js';
import { initInteractions } from './interactions.js';
import { openLightbox, closeLightbox, lightboxOpen } from './lightbox.js';
import { initLibrary, openLibrary, closeLibrary, toggleLibrary, libraryOpen, refreshLibrary } from './library.js';
import { initUploads, pickFiles } from './uploads.js';
import { markDirty, flush, setStatus, checkLocalCopy, resetForBoard, onReloadRequested } from './save.js';
import { downloadCanvas } from './export.js';
import { exportPdf } from './print.js';

const undo = createUndo();
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
let boardsCache = [];

// ---------------------------------------------------------------- mutations
function pushUndo() {
  if (state.board) undo.push(state.board);
  updateUndoButtons();
}

/** Mark the board changed (after pushUndo + edits). */
function changed({ silent = false } = {}) {
  if (!state.board) return;
  markDirty();
  if (!silent) {
    updateEmpty();
    refreshLibrary();
  }
  updateUndoButtons();
  updateSelbar();
}
bus.addEventListener('change', (e) => changed(e.detail || {}));

function mutate(fn) {
  pushUndo();
  fn(state.board);
  changed();
}

function updateUndoButtons() {
  document.getElementById('undoBtn').disabled = !undo.canUndo;
  document.getElementById('redoBtn').disabled = !undo.canRedo;
}

function doUndo(redo = false) {
  finishEditing();
  if (!(redo ? undo.redo(state.board) : undo.undo(state.board))) return;
  state.selection = new Set([...state.selection].filter((id) => cardById(id)));
  renderAll();
  changed();
}

// ---------------------------------------------------------------- creating cards
const tilt = () => 0; // cards sit straight; rotate by hand if wanted

function addCards(cards, { select = true } = {}) {
  if (!state.edit) setEditMode(true);
  mutate((b) => {
    let z = maxZ();
    for (const c of cards) {
      if (c.type === 'frame') c.z = Math.min(0, ...b.cards.filter((x) => x.type === 'frame').map((x) => x.z || 0)) - 1;
      else c.z = ++z;
      b.cards.push(c);
    }
  });
  for (const c of cards) renderCard(c);
  if (select) { state.selection = new Set(cards.map((c) => c.id)); state.selectedString = null; refreshSelection(); }
  updateVisibility();
  return cards;
}

function cardAt(type, at, extra = {}) {
  const sizes = { note: [220, 200], message: [270, 150], link: [260, 150], frame: [640, 440], file: [330, 130] };
  const [w, h] = sizes[type] || [240, 240];
  let x = Math.round(at.x - w / 2);
  let y = Math.round(at.y - h / 2);
  // Don't drop a new card exactly on top of another one.
  for (let i = 0; i < 20 && state.board.cards.some((c) => Math.abs(c.x - x) < 24 && Math.abs(c.y - y) < 24); i++) { x += 34; y += 34; }
  return { id: newId(), type, x, y, w, h, rot: type === 'frame' ? 0 : tilt(), z: 0, ...extra };
}

function mediaCard(type, src, at, w = 250) {
  const aspect = src.width && src.height ? Math.min(2.2, Math.max(0.45, src.height / src.width)) : 0.75;
  const h = polaroidHeight(w, aspect);
  const card = { id: newId(), type, x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h, rot: tilt(), z: 0, src };
  if (src.kind === 'local' && src.label) card.caption = src.label;
  if (!src.width || !src.height) card.needsAspect = true;
  return card;
}

/** Lay items out in a loose grid centred on `at`. items: [{type, src}] */
function addMedia(items, at = viewCenter()) {
  if (!items.length) return;
  const w = 250;
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(items.length * 1.3))));
  const cellW = w + 44;
  const cards = items.map((it) => mediaCard(it.type === 'video' ? 'video' : 'photo', it.src, { x: 0, y: 0 }, w));
  // Rows as tall as their tallest card, so portrait photos never overlap.
  const rowHeights = [];
  cards.forEach((c, i) => { const r = Math.floor(i / cols); rowHeights[r] = Math.max(rowHeights[r] || 0, c.h); });
  const totalH = rowHeights.reduce((a, b) => a + b + 44, -44);
  const rowTop = [];
  rowHeights.reduce((y, h, r) => { rowTop[r] = y; return y + h + 44; }, at.y - totalH / 2);
  const usedCols = Math.min(cols, cards.length);
  cards.forEach((c, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    c.x = Math.round(at.x + (col - (usedCols - 1) / 2) * cellW - c.w / 2 + (Math.random() * 14 - 7));
    c.y = Math.round(rowTop[row] + (rowHeights[row] - c.h) / 2 + (Math.random() * 14 - 7));
  });
  addCards(cards);
  toast(`Pinned ${cards.length} ${cards.length === 1 ? 'item' : 'items'}`);
}

function addUploads(results, at) {
  const items = results.map((r) => {
    const src = { kind: 'upload', id: r.id, name: r.name, mime: r.mime, size: r.size };
    if (r.kind === 'photo' && r.mime !== 'image/heic') return { type: 'photo', src };
    if (r.kind === 'video') return { type: 'video', src };
    return { type: 'file', src };
  });
  const media = items.filter((i) => i.type !== 'file');
  const files = items.filter((i) => i.type === 'file');
  if (media.length) addMedia(media, at);
  if (files.length) {
    addCards(files.map((f, i) => cardAt('file', { x: at.x + i * 30, y: at.y + (media.length ? 330 : 0) + i * 30 }, { src: f.src, title: f.src.name })));
  }
}

function addNoteAt(at, text = '') {
  const [c] = addCards([cardAt('note', at, { text, color: LS.get('atlas:noteColor') || NOTE_COLORS[1].value })]);
  if (!text) setTimeout(() => editCard(c), 30);
}

function pasteText(text) {
  const url = /^https?:\/\/\S+$/i.test(text) ? safeHttpUrl(text) : null;
  if (url) {
    if (/^https?:\/\/(www\.)?gopro\.com\/v\//i.test(url)) {
      toast('That is a GoPro share link — add it in Library → GoPro.', { actions: [{ label: 'Open GoPro', run: () => openLibrary('gopro') }] });
      return;
    }
    addCards([cardAt('link', viewCenter(), { url, title: '' })]);
    return;
  }
  addNoteAt(viewCenter(), text.slice(0, 20000));
}

async function addMessage(at = viewCenter()) {
  const v = await messageDialog({});
  if (v) addCards([cardAt('message', at, v)]);
}

async function addLink(at = viewCenter()) {
  const v = await linkDialog({});
  if (v) addCards([cardAt('link', at, v)]);
}

function addFrame(at = viewCenter()) {
  const [c] = addCards([cardAt('frame', at, { title: '' })]);
  setTimeout(() => editCard(c), 30);
}

// ---------------------------------------------------------------- dialogs for cards
function messageDialog(card) {
  return dialog(card.id ? 'Edit message' : 'New message', (body) => {
    const people = state.settings.people;
    const from = el('input', { type: 'text', value: card.from || people[0]?.name || '', placeholder: 'Who said it', list: 'peopleList', maxLength: 60 });
    const dl = el('datalist', { id: 'peopleList' }, ...people.map((p) => el('option', { value: p.name })));
    const at = el('input', { type: 'text', value: card.at || '', placeholder: 'e.g. 14 Aug, 21:04', maxLength: 60 });
    const text = el('textarea', { placeholder: 'Message text' });
    text.value = card.text || '';
    const mine = el('input', { type: 'checkbox', checked: Boolean(card.mine) });
    body.append(el('label', { text: 'From' }), from, dl, el('label', { text: 'When' }), at, el('label', { text: 'Message' }), text,
      el('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontWeight: '500' } }, mine, 'Show on the right (sent by me)'));
    if (!people.length) body.append(el('div.hint', { text: 'Tip: add people and their colours in Settings.' }));
    return () => ({ from: from.value.trim(), at: at.value.trim(), text: text.value, mine: mine.checked });
  });
}

function linkDialog(card) {
  return dialog(card.id ? 'Edit link' : 'New link', (body) => {
    const url = el('input', { type: 'url', value: card.url || '', placeholder: 'https://…', inputMode: 'url' });
    const title = el('input', { type: 'text', value: card.title || '', placeholder: 'Title (optional)', maxLength: 200 });
    const err = el('div.hint');
    body.append(el('label', { text: 'Address' }), url, el('label', { text: 'Title' }), title, err);
    return () => {
      const u = safeHttpUrl(url.value);
      if (!u) { err.textContent = 'Please enter a web address (http or https).'; url.focus(); return undefined; }
      return { url: u, title: title.value.trim() };
    };
  });
}

function fileDialog(card) {
  return dialog('Edit ticket', (body) => {
    const title = el('input', { type: 'text', value: card.title || card.src?.name || '', maxLength: 200 });
    const caption = el('input', { type: 'text', value: card.caption || '', placeholder: 'Optional note', maxLength: 200 });
    body.append(el('label', { text: 'Title' }), title, el('label', { text: 'Note' }), caption);
    return () => ({ title: title.value.trim(), caption: caption.value.trim() });
  });
}

// ---------------------------------------------------------------- inline editing
let editing = null; // {card, finish}

function finishEditing() {
  if (editing) editing.finish();
}

function editCard(card) {
  if (!state.edit || !card) return;
  finishEditing();
  const node = elFor(card.id);
  if (!node) return;
  if (card.type === 'note') inlineEdit(card, node.querySelector('.text'), 'text', 'textarea');
  else if (isMedia(card)) inlineEdit(card, node.querySelector('.caption'), 'caption', 'input');
  else if (card.type === 'frame') inlineEdit(card, node.querySelector('.frame-label'), 'title', 'input');
  else if (card.type === 'message') dialogEdit(card, messageDialog);
  else if (card.type === 'link') dialogEdit(card, linkDialog);
  else if (card.type === 'file') dialogEdit(card, fileDialog);
}

async function dialogEdit(card, fn) {
  const v = await fn(card);
  if (!v || !cardById(card.id)) return;
  mutate(() => Object.assign(card, v));
  renderCard(card);
  renderStrings();
}

/** On phones, bring the card being edited to the top of the screen, above the keyboard. */
function focusCardForTyping(card) {
  if (!isTouch()) return;
  const zoom = Math.min(2, Math.max(view.zoom, (innerWidth * 0.8) / card.w));
  animateTo({ zoom, x: innerWidth / 2 - (card.x + card.w / 2) * zoom, y: 76 - card.y * zoom }, 200);
}

function inlineEdit(card, host, field, tag) {
  if (!host) return;
  focusCardForTyping(card);
  pushUndo();
  const input = el(tag, { 'aria-label': field, maxLength: tag === 'input' ? 200 : 100000, spellcheck: true });
  input.value = card[field] || '';
  if (tag === 'input') input.type = 'text';
  host.textContent = '';
  host.append(input);
  state.editingId = card.id;
  input.addEventListener('input', () => {
    card[field] = input.value;
    markDirty(); // every keystroke is kept (locally right away, on the server within a second)
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (tag === 'input' || e.ctrlKey || e.metaKey))) { e.preventDefault(); finish(); }
  });
  const finish = () => {
    if (editing?.card !== card) return;
    editing = null;
    state.editingId = null;
    card[field] = input.value;
    if (cardById(card.id)) { renderCard(card); changed(); }
  };
  input.addEventListener('blur', () => setTimeout(finish, 0));
  editing = { card, finish };
  input.focus({ preventScroll: true });
  if (tag === 'textarea') input.setSelectionRange(input.value.length, input.value.length);
  else input.select();
}

// ---------------------------------------------------------------- card actions
function activateCard(card, target) {
  if (!state.edit) return openCard(card);
  if (isMedia(card)) {
    // Double-click the caption to write on it; anywhere else opens the viewer.
    if (target?.closest?.('.caption')) return editCard(card);
    return openLightbox(card);
  }
  if (card.type === 'file' && !target?.closest?.('.main')) return openLightbox(card);
  editCard(card);
}

function openCard(card) {
  if (isMedia(card) || card.type === 'file') return openLightbox(card);
  if (card.type === 'link') {
    const u = safeHttpUrl(card.url);
    if (u) window.open(u, '_blank', 'noopener,noreferrer');
    return;
  }
  if (card.type === 'note' || card.type === 'message') openLightbox(card);
}

function selectedCards() {
  return [...state.selection].map(cardById).filter(Boolean);
}

function deleteSelection() {
  if (state.selectedString) {
    mutate((b) => { b.strings = b.strings.filter((s) => s.id !== state.selectedString); });
    state.selectedString = null;
    renderStrings();
    updateSelbar();
    return;
  }
  const ids = new Set(state.selection);
  if (!ids.size) return;
  finishEditing();
  mutate((b) => {
    b.cards = b.cards.filter((c) => !ids.has(c.id));
    b.strings = b.strings.filter((s) => !ids.has(s.from) && !ids.has(s.to));
  });
  for (const id of ids) removeCardEl(id);
  state.selection.clear();
  refreshSelection();
  toast(`Removed ${ids.size} ${ids.size === 1 ? 'card' : 'cards'}`, { actions: [{ label: 'Undo', run: () => doUndo() }] });
}

function duplicateSelection() {
  const cards = selectedCards();
  if (!cards.length) return;
  const copies = cards.map((c) => ({ ...JSON.parse(JSON.stringify(c)), id: newId(), x: c.x + 30, y: c.y + 30 }));
  addCards(copies);
}

function bringToFront(back = false) {
  const cards = selectedCards();
  if (!cards.length) return;
  mutate((b) => {
    if (back) {
      let z = Math.min(...b.cards.map((c) => c.z || 0));
      for (const c of cards) c.z = --z;
    } else {
      let z = maxZ();
      for (const c of cards) c.z = ++z;
    }
  });
  for (const c of cards) positionCard(c);
}

function setColor(color) {
  LS.set('atlas:noteColor', color);
  const cards = selectedCards().filter((c) => c.type === 'note');
  if (!cards.length) return;
  mutate(() => { for (const c of cards) c.color = color; });
  for (const c of cards) renderCard(c);
}

function setStringColor(color) {
  const s = state.board.strings.find((x) => x.id === state.selectedString);
  if (!s) return;
  mutate(() => { s.color = color; });
  renderStrings();
}

function cardMenu(card, point) {
  const items = [];
  if (isMedia(card) || card.type === 'file') items.push({ label: 'View', icon: 'open', run: () => openLightbox(card) });
  items.push({ label: card.type === 'note' ? 'Write' : isMedia(card) ? 'Edit caption' : 'Edit', icon: 'edit', run: () => editCard(card) });
  if (card.type === 'note') {
    items.push({ heading: 'Colour' });
    for (const c of NOTE_COLORS) items.push({ label: c.name, swatch: c.value, active: card.color === c.value, run: () => setColor(c.value) });
  }
  items.push('hr',
    { label: 'Bring to front', icon: 'front', run: () => bringToFront() },
    { label: 'Send to back', icon: 'front', run: () => bringToFront(true) },
    { label: 'Duplicate', icon: 'copy', sub: 'Ctrl+D', run: duplicateSelection },
    { label: 'Connect to…', icon: 'link', run: () => { setTool('connect'); state.connectFrom = card.id; refreshSelection(); } },
    'hr',
    { label: 'Remove from board', icon: 'trash', sub: 'Del', danger: true, run: deleteSelection });
  showMenu(point, items);
}

// ---------------------------------------------------------------- strings / connect tool
function setTool(tool) {
  state.tool = tool;
  state.connectFrom = null;
  const on = tool === 'connect';
  document.getElementById('connectBtn').setAttribute('aria-pressed', String(on));
  document.getElementById('stage').classList.toggle('connecting', on);
  if (on) toast('Tap two cards to connect them. Press Connect again to stop.', { timeout: 3000 });
  refreshSelection();
}

function connectClick(card) {
  if (!card) { state.connectFrom = null; refreshSelection(); return; }
  if (!state.connectFrom || !cardById(state.connectFrom)) { state.connectFrom = card.id; refreshSelection(); return; }
  if (state.connectFrom === card.id) { state.connectFrom = null; refreshSelection(); return; }
  const from = state.connectFrom;
  const exists = state.board.strings.some((s) => (s.from === from && s.to === card.id) || (s.to === from && s.from === card.id));
  if (!exists) {
    mutate((b) => b.strings.push({ id: newId('s'), from, to: card.id, color: LS.get('atlas:yarn') || YARN_COLORS[0].value }));
  }
  state.connectFrom = card.id; // keep chaining from the last card
  refreshSelection();
}

// ---------------------------------------------------------------- selection bar
const selbar = el('div', { id: 'selbar', class: 'selbar', hidden: true });
document.body.append(selbar);

function selButton(label, iconName, run, extra = {}) {
  return el(`button.tool${extra.danger ? '.danger' : ''}`, { type: 'button', title: label, 'aria-label': label, on: { click: run } }, icon(iconName), el('span', { text: label }));
}

function updateSelbar() {
  selbar.textContent = '';
  const cards = state.edit ? selectedCards() : [];
  if (state.edit && state.selectedString) {
    selbar.append(el('span.sel-count', { text: 'Connection' }));
    const colorBtn = selButton('Colour', 'palette', () => showMenu(colorBtn, YARN_COLORS.map((c) => ({ label: c.name, swatch: c.value === 'default' ? 'var(--muted)' : c.value, run: () => { LS.set('atlas:yarn', c.value); setStringColor(c.value); } }))));
    selbar.append(colorBtn, selButton('Remove', 'trash', deleteSelection, { danger: true }));
    selbar.hidden = false;
    return;
  }
  if (!cards.length || editing) { selbar.hidden = true; return; }
  selbar.append(el('span.sel-count', { text: cards.length === 1 ? cards[0].type : `${cards.length} cards` }));
  if (cards.length === 1) {
    const c = cards[0];
    if (isMedia(c) || c.type === 'file') selbar.append(selButton('View', 'open', () => openLightbox(c)));
    selbar.append(selButton(c.type === 'note' ? 'Write' : isMedia(c) ? 'Caption' : 'Edit', 'edit', () => editCard(c)));
  }
  if (cards.some((c) => c.type === 'note')) {
    const colorBtn = selButton('Colour', 'palette', () => showMenu(colorBtn, NOTE_COLORS.map((c) => ({ label: c.name, swatch: c.value, run: () => setColor(c.value) }))));
    selbar.append(colorBtn);
  }
  selbar.append(selButton('Front', 'front', () => bringToFront()), selButton('Duplicate', 'copy', duplicateSelection), selButton('Remove', 'trash', deleteSelection, { danger: true }));
  selbar.hidden = false;
}
bus.addEventListener('selection', updateSelbar);

// ---------------------------------------------------------------- boards
async function loadBoard(id) {
  await flush();
  closeLightbox();
  finishEditing();
  let doc;
  try {
    doc = await api.board(id);
  } catch (err) {
    if (err.status === 404) { LS.set('atlas:lastBoard', ''); return init(); }
    toast(`Could not open board: ${err.message}`, { error: true, timeout: 0, actions: [{ label: 'Retry', run: () => loadBoard(id) }] });
    return;
  }
  applyDoc(doc);
  LS.set('atlas:lastBoard', doc.id);
  checkLocalCopy(doc, (local) => {
    state.board.cards = local.cards || [];
    state.board.strings = local.strings || [];
    state.board.title = local.title || state.board.title;
    renderAll();
    updateTitle();
  });
}

function applyDoc(doc) {
  doc.cards ||= [];
  doc.strings ||= [];
  normaliseZ(doc);
  state.board = doc;
  state.rev = doc.rev;
  state.selection = new Set();
  state.selectedString = null;
  state.connectFrom = null;
  undo.reset();
  resetForBoard();
  updateUndoButtons();
  updateTitle();
  let vp = null;
  try { vp = JSON.parse(LS.get(`atlas:view:${doc.id}`) || 'null'); } catch {}
  renderAll();
  if (vp && Number.isFinite(vp.zoom)) { Object.assign(view, vp); applyViewport(); }
  else if (doc.cards.length) fitAll(false);
  else { view.zoom = 1; view.x = innerWidth / 2; view.y = innerHeight / 2; applyViewport(); }
  refreshSelection();
  refreshLibrary();
}

onReloadRequested((current) => applyDoc(current));

function updateTitle() {
  const t = state.board?.title || 'Atlas';
  document.getElementById('boardTitle').textContent = t;
  document.title = `${t} · Atlas`;
}

function saveViewport() {
  if (state.board) LS.set(`atlas:view:${state.board.id}`, JSON.stringify({ x: view.x, y: view.y, zoom: view.zoom }));
}

async function boardsMenu() {
  try { boardsCache = await api.boards(); } catch (err) { toast(err.message, { error: true }); }
  const items = [{ heading: 'Boards' }];
  for (const b of boardsCache) {
    items.push({ label: b.title, icon: 'board', sub: `${b.cardCount}`, active: b.id === state.board?.id, run: () => b.id !== state.board?.id && loadBoard(b.id) });
  }
  items.push('hr',
    { label: 'New board…', icon: 'plus', run: newBoard },
    { label: 'Rename this board…', icon: 'edit', run: renameBoard },
    { label: 'Export as PDF…', icon: 'download', run: () => { finishEditing(); state.selection.clear(); refreshSelection(); exportPdf(); } },
    { label: 'Export for Obsidian (.canvas)', icon: 'download', run: () => downloadCanvas(state.board) },
    { label: 'Delete this board…', icon: 'trash', danger: true, run: deleteBoard });
  showMenu(document.getElementById('boardBtn'), items);
}

async function newBoard() {
  const title = await prompt('New board', '', { placeholder: 'e.g. Summer 2026', ok: 'Create' });
  if (!title) return;
  try {
    await flush();
    const b = await api.createBoard(title);
    await loadBoard(b.id);
  } catch (err) { toast(err.message, { error: true }); }
}

async function renameBoard() {
  const title = await prompt('Rename board', state.board.title);
  if (!title || title === state.board.title) return;
  state.board.title = title;
  updateTitle();
  changed();
}

async function deleteBoard() {
  const ok = await confirm('Delete board?', `“${state.board.title}” will be moved to .atlas/trash on the computer. Your photos and videos are not touched.`, { ok: 'Delete', danger: true });
  if (!ok) return;
  try {
    await flush();
    await api.deleteBoard(state.board.id);
    LS.set('atlas:lastBoard', '');
    state.board = null;
    await init();
  } catch (err) { toast(err.message, { error: true }); }
}

// ---------------------------------------------------------------- settings & help
async function settingsDialog() {
  let s;
  try { s = await api.settings(); } catch (err) { toast(err.message, { error: true }); return; }
  const v = await dialog('Settings', (body) => {
    const title = el('input', { type: 'text', value: s.title || '', maxLength: 120 });
    const list = el('div.people');
    const addRow = (p = { name: '', color: '#4a7bd0' }) => {
      const name = el('input', { type: 'text', value: p.name, placeholder: 'Name', maxLength: 60 });
      const color = el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#4a7bd0', 'aria-label': 'Colour' });
      const rm = el('button.round.small', { type: 'button', 'aria-label': 'Remove person', on: { click: () => row.remove() } }, icon('x'));
      const row = el('div.row', {}, name, color, rm);
      row._get = () => ({ name: name.value.trim(), color: color.value });
      list.append(row);
    };
    (s.people || []).forEach(addRow);
    body.append(
      el('label', { text: 'Workspace title' }), title,
      el('label', { text: 'People (for message cards)' }), list,
      el('button.ghost', { type: 'button', text: '+ Add person', on: { click: () => addRow() } }),
      el('div.hint', { text: s.displayDirFound ? `Display copies: ${s.displayDir || 'compressed'} folder.` : 'No display-copies folder found (optional: a “compressed” subfolder with smaller copies using the same filenames).' }),
    );
    return () => ({ title: title.value.trim() || s.title, people: [...list.children].map((r) => r._get()).filter((p) => p.name) });
  });
  if (!v) return;
  try {
    const r = await api.saveSettings(v);
    state.settings = r;
    renderAll();
    toast('Settings saved');
  } catch (err) { toast(err.message, { error: true }); }
}

function helpDialog() {
  const keys = [
    ['Double-click', 'Edit a note / view a photo or video'], ['Double-click board', 'New note'],
    ['Drag', 'Move (shift-click to select several)'], ['Del / Backspace', 'Remove selected'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
    ['Ctrl+D', 'Duplicate'], ['N', 'New note'], ['L', 'Library'], ['C', 'Connect tool'], ['E', 'Lock / edit'],
    ['F', 'Fit everything'], ['+ / −  · wheel', 'Zoom'], ['Arrows', 'Nudge (shift: 10×)'], ['Ctrl+V', 'Paste a screenshot, link or text'], ['Esc', 'Deselect / close'],
  ];
  dialog('Shortcuts', (body) => {
    body.append(el('div.keys', {}, ...keys.flatMap(([k, d]) => [el('span', {}, el('kbd', { text: k })), el('span', { text: d })])));
    body.append(el('p.hint', { text: 'On a phone: Lock (default) lets you pan, pinch and tap to view. Switch to Edit to move things; long-press a card for its menu.' }));
  }, { ok: 'Close', cancel: null });
}

// ---------------------------------------------------------------- keyboard
function onKey(e) {
  if (isDialogOpen() || lightboxOpen() || menuOpen()) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); if (state.edit) doUndo(e.shiftKey); return; }
  if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); if (state.edit) doUndo(true); return; }
  if (mod && (k === 'd' || k === 'D')) { e.preventDefault(); if (state.edit) duplicateSelection(); return; }
  if (mod && (k === 'a' || k === 'A')) { e.preventDefault(); if (state.edit) { state.selection = new Set(state.board.cards.map((c) => c.id)); refreshSelection(); } return; }
  if (mod && k === 's') { e.preventDefault(); flush(); return; }
  if (mod) return;
  if (k === 'Escape') {
    if (state.tool === 'connect') setTool('select');
    else if (libraryOpen()) closeLibrary();
    else { state.selection.clear(); state.selectedString = null; refreshSelection(); }
    return;
  }
  if ((k === 'Delete' || k === 'Backspace') && state.edit) { e.preventDefault(); deleteSelection(); return; }
  if (k === 'Enter' && state.selection.size === 1) { e.preventDefault(); activateCard(selectedCards()[0]); return; }
  if (k.startsWith('Arrow') && state.edit && state.selection.size) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    const cards = selectedCards();
    if (!e.repeat) pushUndo();
    for (const c of cards) {
      if (k === 'ArrowLeft') c.x -= d; if (k === 'ArrowRight') c.x += d;
      if (k === 'ArrowUp') c.y -= d; if (k === 'ArrowDown') c.y += d;
      positionCard(c);
    }
    renderStrings();
    changed({ silent: true });
    return;
  }
  const lower = k.toLowerCase();
  if (k === '+' || k === '=') zoomAt(innerWidth / 2, innerHeight / 2, view.zoom * 1.25);
  else if (k === '-' || k === '_') zoomAt(innerWidth / 2, innerHeight / 2, view.zoom / 1.25);
  else if (k === '0') zoomAt(innerWidth / 2, innerHeight / 2, 1);
  else if (lower === 'f') fitAll();
  else if (lower === 'l') toggleLibrary();
  else if (lower === 'e') toggleEdit();
  else if (lower === 'n' && state.edit) addNoteAt(viewCenter());
  else if (lower === 'c' && state.edit) setTool(state.tool === 'connect' ? 'select' : 'connect');
  else if (k === '?') helpDialog();
  else return;
  saveViewport();
}

function toggleEdit() {
  finishEditing();
  setEditMode(!state.edit);
  LS.set('atlas:edit', state.edit ? '1' : '0');
  updateSelbar();
  if (!state.edit) toast('Locked: pan, pinch and tap to view.', { timeout: 2000 });
}

// ---------------------------------------------------------------- toolbar wiring
function addMenu() {
  const btn = document.getElementById('addBtn');
  showMenu(btn, [
    { label: 'Sticky note', icon: 'note', sub: 'N', run: () => addNoteAt(viewCenter()) },
    { label: 'Chat message', icon: 'message', run: () => addMessage() },
    { label: 'Link', icon: 'link', run: () => addLink() },
    { label: 'Frame', icon: 'frame', run: () => addFrame() },
    'hr',
    { label: 'Photos & videos…', icon: 'photo', sub: 'L', run: () => openLibrary() },
    { label: 'Upload a file…', icon: 'upload', sub: 'tickets, PDFs, screenshots', run: () => { if (!state.edit) setEditMode(true); pickFiles(); } },
  ]);
}

function wire() {
  document.getElementById('boardBtn').addEventListener('click', boardsMenu);
  document.getElementById('addBtn').addEventListener('click', addMenu);
  document.getElementById('libraryBtn').addEventListener('click', toggleLibrary);
  document.getElementById('connectBtn').addEventListener('click', () => setTool(state.tool === 'connect' ? 'select' : 'connect'));
  document.getElementById('undoBtn').addEventListener('click', () => doUndo());
  document.getElementById('redoBtn').addEventListener('click', () => doUndo(true));
  document.getElementById('lockBtn').addEventListener('click', toggleEdit);
  document.getElementById('zoomIn').addEventListener('click', () => { zoomAt(innerWidth / 2, innerHeight / 2, view.zoom * 1.25); saveViewport(); });
  document.getElementById('zoomOut').addEventListener('click', () => { zoomAt(innerWidth / 2, innerHeight / 2, view.zoom / 1.25); saveViewport(); });
  document.getElementById('zoomPct').addEventListener('click', () => { zoomAt(innerWidth / 2, innerHeight / 2, 1); saveViewport(); });
  document.getElementById('zoomFit').addEventListener('click', () => { fitAll(); setTimeout(saveViewport, 300); });
  document.getElementById('helpBtn').addEventListener('click', helpDialog);
  document.getElementById('settingsBtn').addEventListener('click', settingsDialog);
  document.addEventListener('keydown', onKey);
  document.getElementById('stage').addEventListener('viewport-settled', () => { saveViewport(); updateVisibility(); });
  addEventListener('resize', () => updateVisibility());

  initInteractions({
    isBlocked: () => isDialogOpen() || lightboxOpen(),
    pushUndo,
    changed: () => changed(),
    viewportChanged: () => { saveViewport(); updateVisibility(); },
    openCard,
    activateCard,
    cardMenu,
    addNoteAt: (p) => addNoteAt(p),
    connectClick,
  });
  initLibrary({ addMedia });
  initUploads({ addMedia, addUploads, pasteText });
}

// ---------------------------------------------------------------- start
async function init() {
  setStatus('saving', 'Loading…');
  try {
    const [health, settings] = await Promise.all([api.health(), api.settings()]);
    state.settings = settings;
    if (!health.tools.ffmpeg || !health.tools.magick) console.info('atlas: optional tools missing', health.tools);
    boardsCache = await api.boards();
  } catch (err) {
    setStatus('offline', 'Offline');
    toast(`Cannot reach the atlas server (${err.message}). Is it running?`, { error: true, timeout: 0, actions: [{ label: 'Retry', run: init }] });
    return;
  }
  const last = LS.get('atlas:lastBoard');
  const target = boardsCache.find((b) => b.id === last) || boardsCache[0];
  await loadBoard(target.id);
}

const savedEdit = LS.get('atlas:edit');
setEditMode(savedEdit ? savedEdit === '1' : !isTouch());
wire();
updateSelbar();
init();
