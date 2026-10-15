// Autosave with optimistic concurrency, an offline-safe local copy, and conflict handling.
import { api } from './api.js';
import { state } from './board.js';
import { toast } from './ui.js';

const DEBOUNCE = 700;
const statusEl = document.getElementById('status');
let timer = 0;
let safetyTimer = 0;
let inFlight = null;
let dirty = false;
let conflict = null; // server's current doc when we hit a 409
let retryMs = 0;
let onConflictReload = () => {};

const key = (id) => `atlas:unsaved:${id}`;

function store(k, v) {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); return true; } catch { return false; }
}
function load(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

export function setStatus(kind, text) {
  statusEl.dataset.state = kind;
  statusEl.textContent = text;
}

function writeSafetyNow() {
  clearTimeout(safetyTimer);
  safetyTimer = 0;
  if (!state.board) return;
  store(key(state.board.id), JSON.stringify({ rev: state.rev, savedAt: Date.now(), doc: state.board }));
}

export const isDirty = () => dirty || Boolean(inFlight);

/** Something changed: keep a local copy right away and save soon. */
export function markDirty() {
  if (!state.board) return;
  dirty = true;
  if (!safetyTimer) safetyTimer = setTimeout(writeSafetyNow, 250);
  if (!conflict) setStatus('saving', 'Saving…');
  schedule(DEBOUNCE);
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => { flush(); }, ms);
}

export function onReloadRequested(fn) { onConflictReload = fn; }

/** Save now (if needed). Resolves when the board is saved or the attempt failed. */
export async function flush() {
  clearTimeout(timer);
  if (inFlight) { await inFlight; if (dirty && !conflict) return flush(); return; }
  if (!dirty || conflict || !state.board) return;
  dirty = false;
  const doc = JSON.parse(JSON.stringify(state.board));
  const rev = state.rev;
  inFlight = (async () => {
    try {
      const r = await api.saveBoard(doc, rev);
      if (state.board && state.board.id === doc.id) {
        state.rev = r.rev;
        state.board.rev = r.rev;
        state.board.updatedAt = r.updatedAt;
      }
      retryMs = 0;
      if (!dirty) {
        store(key(doc.id), null);
        setStatus('saved', 'Saved');
      }
    } catch (err) {
      dirty = true;
      writeSafetyNow();
      if (err.status === 409 && err.body?.current) {
        conflict = err.body.current;
        setStatus('conflict', 'Conflict');
        toast('This board was changed somewhere else (another tab or device). Your version is kept safely on this device.', {
          error: true,
          timeout: 0,
          actions: [
            { label: 'Reload latest', run: () => resolveConflict('theirs') },
            { label: 'Keep mine', run: () => resolveConflict('mine') },
          ],
        });
      } else if (err.status === 0 || err.status >= 500) {
        retryMs = Math.min(30000, retryMs ? retryMs * 2 : 2000);
        setStatus('offline', err.status === 0 ? 'Offline — kept on this device' : 'Server error — retrying');
        schedule(retryMs);
      } else if (err.status === 404) {
        setStatus('error', 'Board deleted');
        toast('This board no longer exists on the server. Your copy is kept on this device.', { error: true, timeout: 0 });
        conflict = { deleted: true };
      } else {
        setStatus('error', 'Not saved');
        toast(`Could not save: ${err.message}`, { error: true });
        retryMs = Math.min(30000, retryMs ? retryMs * 2 : 5000);
        schedule(retryMs);
      }
    } finally {
      inFlight = null;
    }
  })();
  await inFlight;
  if (dirty && !conflict && !timer) schedule(DEBOUNCE);
}

async function resolveConflict(choice) {
  const current = conflict;
  if (!current || current.deleted || !state.board) return;
  conflict = null;
  if (choice === 'mine') {
    state.rev = current.rev;
    dirty = true;
    flush();
    return;
  }
  // "Reload latest" never throws our version away: it becomes its own board first.
  const mine = JSON.parse(JSON.stringify(state.board));
  try {
    const copy = await api.createBoard(`${mine.title} (my copy)`);
    await api.saveBoard({ ...copy, cards: mine.cards, strings: mine.strings, viewport: mine.viewport }, copy.rev);
    toast(`Your version was kept as the board “${copy.title}”.`, { timeout: 8000 });
  } catch (err) {
    store(`atlas:conflict:${mine.id}:${Date.now()}`, JSON.stringify({ doc: mine }));
    toast(`Could not save your version as a separate board (${err.message}); it is kept on this device.`, { error: true, timeout: 0 });
  }
  store(key(mine.id), null);
  dirty = false;
  setStatus('saved', 'Saved');
  onConflictReload(current);
}

/** Called after a board is loaded from the server: offer or apply an unsaved local copy. */
export function checkLocalCopy(serverDoc, apply) {
  const raw = load(key(serverDoc.id));
  if (!raw) return;
  let saved;
  try { saved = JSON.parse(raw); } catch { store(key(serverDoc.id), null); return; }
  const same = JSON.stringify({ c: saved.doc?.cards, s: saved.doc?.strings, t: saved.doc?.title }) ===
    JSON.stringify({ c: serverDoc.cards, s: serverDoc.strings, t: serverDoc.title });
  if (!saved.doc || same) { store(key(serverDoc.id), null); return; }
  if (saved.rev === serverDoc.rev) {
    apply(saved.doc);
    markDirty();
    toast('Restored changes that had not reached the server yet.');
  } else {
    toast('This device has unsaved changes from an older version of this board.', {
      timeout: 0,
      actions: [
        { label: 'Restore them', run: () => { apply(saved.doc); markDirty(); } },
        { label: 'Discard', run: () => store(key(serverDoc.id), null) },
      ],
    });
  }
}

export function resetForBoard() {
  clearTimeout(timer);
  dirty = false;
  conflict = null;
  retryMs = 0;
  setStatus('saved', 'Saved');
}

// Last chance on tab close / app switch (phones): local copy always, keepalive PUT when small enough.
function lastChance() {
  if (!state.board || !(dirty || inFlight)) return;
  writeSafetyNow();
  if (conflict || inFlight) return;
  const body = JSON.stringify(state.board);
  if (body.length < 60000) {
    dirty = false;
    clearTimeout(timer);
    const id = state.board.id;
    // Tracked as inFlight so a save started when the page comes back waits for the new rev.
    inFlight = api.saveBoard(state.board, state.rev, { keepalive: true })
      .then((r) => {
        if (state.board?.id === id) { state.rev = r.rev; state.board.rev = r.rev; }
        if (!dirty) { store(key(id), null); setStatus('saved', 'Saved'); }
      })
      .catch(() => { dirty = true; schedule(DEBOUNCE); })
      .finally(() => { inFlight = null; });
  }
}
addEventListener('pagehide', lastChance);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { if (dirty) lastChance(); } });
addEventListener('beforeunload', (e) => { if (dirty || inFlight) { writeSafetyNow(); e.preventDefault(); e.returnValue = ''; } });
addEventListener('online', () => { if (dirty && !conflict) flush(); });
