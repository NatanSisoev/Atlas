// Library drawer: media from this computer and from GoPro share links, ready to pin.
import { el, icon, toast, confirm, fmtDuration } from './ui.js';
import { api, thumbUrl } from './api.js';
import { state } from './board.js';

const drawer = document.getElementById('library');
const paneLocal = document.getElementById('libLocal');
const paneGopro = document.getElementById('libGopro');
const countEl = document.getElementById('libCount');
const addBtn = document.getElementById('libAdd');
const clearBtn = document.getElementById('libClear');

const lib = {
  tab: 'local',
  local: null,
  localError: null,
  filter: 'all',
  query: '',
  selected: new Map(), // key -> {type, src}
  links: null,
  activeLink: null,
  goproItems: null,
  goproFilter: 'all',
  busy: false,
};
let ctx = null;

export const libraryOpen = () => !drawer.hidden;

const localKey = (path) => `l:${path}`;
const goproKey = (id) => `g:${id}`;

function onBoardKeys() {
  const keys = new Set();
  for (const c of state.board?.cards || []) {
    if (c.src?.kind === 'local') keys.add(localKey(c.src.path));
    if (c.src?.kind === 'gopro') keys.add(goproKey(c.src.mediumId));
  }
  return keys;
}

function dayLabel(ymd) {
  if (!ymd || ymd === 'unknown') return 'Unknown date';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function offsetMinutes(tz) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz || '');
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/** GoPro times are UTC plus a camera timezone; turn them into local wall-clock ISO with offset. */
export function goproLocalIso(utc, tz) {
  const t = Date.parse(utc);
  if (!Number.isFinite(t)) return null;
  const local = new Date(t + offsetMinutes(tz) * 60000).toISOString().slice(0, 19);
  return tz ? `${local}${tz}` : `${local}Z`;
}

function localSrc(it) {
  return {
    kind: 'local', path: it.path, v: String(Date.parse(it.mtime) || ''), name: it.name, label: it.label,
    capturedAt: it.capturedAt, width: it.width, height: it.height, durationSec: it.durationSec, hasDisplay: it.hasDisplay,
  };
}

function goproSrc(link, it) {
  return {
    kind: 'gopro', linkId: link.id, mediumId: it.mediumId, token: it.token, mediaType: it.mediaType, filename: it.filename,
    capturedAt: goproLocalIso(it.capturedAt, it.tz), tz: it.tz, width: it.width, height: it.height, durationSec: it.durationSec,
  };
}

// ---------------------------------------------------------------- shared tile grid
function tile(key, type, src, { name, dur, onBoard }) {
  const url = thumbUrl(src, 200);
  const t = el(`button.tile.${type}${lib.selected.has(key) ? '.selected' : ''}`, {
    type: 'button', title: name, draggable: !matchMedia('(pointer: coarse)').matches, dataset: { key },
    'aria-pressed': String(lib.selected.has(key)),
  });
  if (url) t.append(el('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', draggable: false }));
  if (onBoard) t.append(el('span.badge', { text: 'on board' }));
  if (type === 'video') t.append(el('span.dur', { text: dur || '▶' }));
  t.append(el('span.name', { text: name }));
  t.addEventListener('click', () => {
    if (lib.selected.has(key)) lib.selected.delete(key);
    else lib.selected.set(key, { type, src });
    t.classList.toggle('selected', lib.selected.has(key));
    t.setAttribute('aria-pressed', String(lib.selected.has(key)));
    updateFoot();
  });
  t.addEventListener('dragstart', (e) => {
    const items = lib.selected.has(key) ? [...lib.selected.values()] : [{ type, src }];
    e.dataTransfer.setData('application/x-atlas-items', JSON.stringify(items));
    e.dataTransfer.effectAllowed = 'copy';
  });
  return t;
}

function grouped(entries, pane) {
  const days = new Map();
  for (const e of entries) {
    if (!days.has(e.day)) days.set(e.day, []);
    days.get(e.day).push(e);
  }
  const keys = [...days.keys()].sort((a, b) => (a === 'unknown') - (b === 'unknown') || a.localeCompare(b));
  for (const day of keys) {
    const list = days.get(day);
    const grid = el('div.grid');
    for (const e of list) grid.append(tile(e.key, e.type, e.src, e));
    const allSel = () => list.every((e) => lib.selected.has(e.key));
    const selBtn = el('button', { type: 'button', text: allSel() ? 'Clear day' : 'Select day' });
    selBtn.addEventListener('click', () => {
      const on = !allSel();
      for (const e of list) on ? lib.selected.set(e.key, { type: e.type, src: e.src }) : lib.selected.delete(e.key);
      render();
    });
    pane.append(el('section.day', {}, el('div.day-head', {}, el('span', { text: `${dayLabel(day)} · ${list.length}` }), selBtn), grid));
  }
}

function seg(options, value, onPick) {
  const s = el('div.seg', { role: 'group' });
  for (const [v, label] of options) {
    s.append(el('button', { type: 'button', text: label, 'aria-pressed': String(v === value), on: { click: () => onPick(v) } }));
  }
  return s;
}

// ---------------------------------------------------------------- local
async function loadLocal(force = false) {
  if (lib.local && !force) return;
  lib.localError = null;
  try {
    lib.local = (await api.local()).items;
  } catch (err) {
    lib.localError = err.message;
  }
  render();
}

function renderLocal() {
  const scroll = paneLocal.scrollTop;
  paneLocal.textContent = '';
  const search = el('input', { type: 'search', placeholder: 'Search names…', value: lib.query, 'aria-label': 'Search' });
  search.addEventListener('input', () => { lib.query = search.value; renderLocalList(); });
  paneLocal.append(el('div.lib-tools', {}, search, seg([['all', 'All'], ['photo', 'Photos'], ['video', 'Videos']], lib.filter, (v) => { lib.filter = v; render(); })));
  const list = el('div.lib-list');
  paneLocal.append(list);
  function renderLocalList() {
    list.textContent = '';
    if (lib.localError) { list.append(el('div.lib-empty', { text: `Could not read the folder: ${lib.localError}` })); return; }
    if (!lib.local) { list.append(el('div.spinner')); return; }
    const q = lib.query.trim().toLowerCase();
    const on = onBoardKeys();
    const entries = lib.local
      .filter((it) => lib.filter === 'all' || it.type === lib.filter)
      .filter((it) => !q || `${it.label} ${it.name} ${it.path}`.toLowerCase().includes(q))
      .map((it) => ({
        key: localKey(it.path), type: it.type, src: localSrc(it), name: it.index != null ? `${it.index} · ${it.label}` : it.label || it.name,
        dur: fmtDuration(it.durationSec), onBoard: on.has(localKey(it.path)),
        day: (it.capturedAt || it.mtime || '').slice(0, 10) || 'unknown',
      }));
    if (!entries.length) {
      list.append(el('div.lib-empty', { text: lib.local.length ? 'Nothing matches.' : 'No photos or videos found in this folder (jpg, png, webp, gif, heic, mp4, mov, m4v, webm).' }));
      return;
    }
    grouped(entries, list);
  }
  renderLocalList();
  paneLocal.scrollTop = scroll;
}

// ---------------------------------------------------------------- GoPro
async function loadLinks(force = false) {
  if (lib.links && !force) return;
  try {
    lib.links = await api.goproLinks();
    if (!lib.activeLink && lib.links.length) await openLink(lib.links[0].id);
  } catch (err) {
    toast(`GoPro links: ${err.message}`, { error: true });
    lib.links = lib.links || [];
  }
  render();
}

async function openLink(id) {
  lib.activeLink = id;
  lib.goproItems = null;
  render();
  try {
    const r = await api.goproItems(id);
    if (lib.activeLink === id) lib.goproItems = r;
  } catch (err) {
    toast(err.message, { error: true });
  }
  render();
}

async function addLink(input, button) {
  const url = input.value.trim();
  if (!url) { input.focus(); return; }
  button.disabled = true;
  input.disabled = true;
  button.textContent = 'Adding…';
  try {
    const link = await api.addGoproLink(url);
    toast(`Added “${link.title}” — ${link.mediaCount} items`);
    lib.links = null;
    lib.activeLink = null;
    await loadLinks(true);
    await openLink(link.id);
  } catch (err) {
    toast(err.message, { error: true });
    button.disabled = false;
    input.disabled = false;
    button.textContent = 'Add';
  }
}

function renderGopro() {
  const scroll = paneGopro.scrollTop;
  paneGopro.textContent = '';
  const input = el('input', { type: 'url', placeholder: 'Paste a GoPro share link', 'aria-label': 'GoPro share link', inputMode: 'url', autocomplete: 'off' });
  const add = el('button.primary', { type: 'button', text: 'Add' });
  add.addEventListener('click', () => addLink(input, add));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addLink(input, add); });
  paneGopro.append(el('div.lib-tools', {}, input, add));

  if (!lib.links) { paneGopro.append(el('div.spinner')); return; }
  if (!lib.links.length) {
    paneGopro.append(el('div.lib-empty', { text: 'In GoPro Quik, share an album or media to get a link like https://gopro.com/v/…, then paste it above. Nothing is downloaded: photos and videos stream from GoPro when you look at them.' }));
    return;
  }
  const links = el('div.links');
  for (const l of lib.links) {
    const row = el(`div.link-row${l.id === lib.activeLink ? '.active' : ''}`);
    const open = el('button.open', { type: 'button' }, el('b', { text: l.title }), el('small', { text: `${l.mediaCount} items · updated ${new Date(l.fetchedAt).toLocaleDateString()}` }));
    open.addEventListener('click', () => openLink(l.id));
    const refresh = el('button.round.small', { type: 'button', title: 'Refresh from GoPro', 'aria-label': 'Refresh' }, icon('refresh'));
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try { await api.refreshGoproLink(l.id); toast('Refreshed'); lib.links = null; await loadLinks(true); if (lib.activeLink === l.id) await openLink(l.id); }
      catch (err) { toast(err.message, { error: true }); refresh.disabled = false; }
    });
    const remove = el('button.round.small', { type: 'button', title: 'Remove link', 'aria-label': 'Remove link' }, icon('x'));
    remove.addEventListener('click', async () => {
      if (!(await confirm('Remove GoPro link?', `“${l.title}” will be removed from the library (moved to .atlas/trash). Cards already on boards stay.`, { ok: 'Remove', danger: true }))) return;
      try { await api.deleteGoproLink(l.id); if (lib.activeLink === l.id) { lib.activeLink = null; lib.goproItems = null; } lib.links = null; await loadLinks(true); }
      catch (err) { toast(err.message, { error: true }); }
    });
    row.append(open, refresh, remove);
    links.append(row);
  }
  paneGopro.append(links);

  if (!lib.activeLink) { paneGopro.scrollTop = scroll; return; }
  if (!lib.goproItems) { paneGopro.append(el('div.spinner')); return; }
  paneGopro.append(el('div.lib-tools', {}, seg([['all', 'All'], ['photo', 'Photos'], ['video', 'Videos']], lib.goproFilter, (v) => { lib.goproFilter = v; render(); })));
  const link = lib.goproItems.link;
  const on = onBoardKeys();
  const entries = lib.goproItems.items
    .map((it) => ({ it, type: /video/i.test(it.mediaType) ? 'video' : 'photo' }))
    .filter(({ type }) => lib.goproFilter === 'all' || type === lib.goproFilter)
    .map(({ it, type }) => {
      const src = goproSrc(link, it);
      return {
        key: goproKey(it.mediumId), type, src, name: it.filename, dur: fmtDuration(it.durationSec), onBoard: on.has(goproKey(it.mediumId)),
        day: (src.capturedAt || '').slice(0, 10) || 'unknown',
      };
    });
  if (!entries.length) paneGopro.append(el('div.lib-empty', { text: 'Nothing here.' }));
  else grouped(entries, paneGopro);
  paneGopro.scrollTop = scroll;
}

// ---------------------------------------------------------------- drawer
function updateFoot() {
  const n = lib.selected.size;
  countEl.textContent = n ? `${n} selected` : 'Tap to select · drag onto the board';
  clearBtn.hidden = !n;
  addBtn.disabled = !n;
  addBtn.textContent = n ? `Add ${n} to board` : 'Add to board';
}

function render() {
  for (const b of drawer.querySelectorAll('[role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.tab === lib.tab));
  paneLocal.hidden = lib.tab !== 'local';
  paneGopro.hidden = lib.tab !== 'gopro';
  if (lib.tab === 'local') renderLocal();
  else renderGopro();
  updateFoot();
}

export function openLibrary(tab) {
  if (tab) lib.tab = tab;
  drawer.hidden = false;
  document.getElementById('libraryBtn').setAttribute('aria-pressed', 'true');
  render();
  if (lib.tab === 'local') loadLocal(true);
  else loadLinks();
}

export function closeLibrary() {
  drawer.hidden = true;
  document.getElementById('libraryBtn').setAttribute('aria-pressed', 'false');
}

export function toggleLibrary() {
  libraryOpen() ? closeLibrary() : openLibrary();
}

/** Re-render badges after board changes, if open. */
export function refreshLibrary() {
  if (libraryOpen()) render();
}

export function initLibrary(context) {
  ctx = context;
  for (const b of drawer.querySelectorAll('[role="tab"]')) {
    b.addEventListener('click', () => {
      lib.tab = b.dataset.tab;
      render();
      if (lib.tab === 'local') loadLocal();
      else loadLinks();
    });
  }
  document.getElementById('libClose').addEventListener('click', closeLibrary);
  clearBtn.addEventListener('click', () => { lib.selected.clear(); render(); });
  addBtn.addEventListener('click', () => {
    const items = [...lib.selected.values()];
    if (!items.length) return;
    ctx.addMedia(items);
    lib.selected.clear();
    render();
    if (matchMedia('(max-width: 640px)').matches) closeLibrary();
  });
  // Swipe the phone sheet down to close.
  let start = null;
  drawer.querySelector('.sheet-grip').addEventListener('pointerdown', (e) => { start = e.clientY; });
  drawer.addEventListener('pointerup', (e) => { if (start != null && e.clientY - start > 60) closeLibrary(); start = null; });
  drawer.querySelector('.lib-head').addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) start = e.clientY; });
}
