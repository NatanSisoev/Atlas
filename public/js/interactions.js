// Pointer, touch and wheel handling for the board: pan, pinch-zoom, select, drag, resize, rotate, connect.
import {
  state, view, applyViewport, zoomAt, screenToWorld, cardById, elFor, positionCard, renderStrings,
  refreshSelection, maxZ, mediaAspect, polaroidHeight, isMedia,
} from './board.js';

const stage = document.getElementById('stage');
const pointers = new Map();
let gesture = null;
let lastTap = null;
let raf = 0;
let pendingCards = new Set();
let longPressTimer = 0;

const DRAG_SLOP = 5;
const DOUBLE_MS = 380;

function schedulePaint(cards) {
  for (const c of cards) pendingCards.add(c);
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    for (const c of pendingCards) positionCard(c);
    pendingCards = new Set();
    renderStrings();
  });
}

function isEditable(t) {
  return t.closest('textarea, input, select, [contenteditable="true"]');
}

export function initInteractions(ctx) {
  stage.addEventListener('pointerdown', (e) => onDown(e, ctx));
  stage.addEventListener('pointermove', (e) => onMove(e, ctx));
  stage.addEventListener('pointerup', (e) => onUp(e, ctx));
  stage.addEventListener('pointercancel', (e) => onUp(e, ctx, true));
  stage.addEventListener('lostpointercapture', (e) => { if (pointers.has(e.pointerId)) onUp(e, ctx, true); });
  stage.addEventListener('wheel', (e) => onWheel(e), { passive: false });
  stage.addEventListener('contextmenu', (e) => {
    if (isEditable(e.target)) return;
    e.preventDefault();
    const node = e.target.closest('.card');
    if (node && state.edit) {
      const card = cardById(node.dataset.id);
      if (!state.selection.has(card.id)) { state.selection = new Set([card.id]); refreshSelection(); }
      ctx.cardMenu(card, { x: e.clientX, y: e.clientY });
    }
  });
  // Safari trackpad pinch
  let gScale = 1;
  stage.addEventListener('gesturestart', (e) => { e.preventDefault(); gScale = view.zoom; });
  stage.addEventListener('gesturechange', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, gScale * e.scale); });
  stage.addEventListener('gestureend', (e) => e.preventDefault());
}

function startPinch() {
  const [a, b] = [...pointers.values()];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: view.zoom, anchor: screenToWorld(mid.x, mid.y) };
}

function onDown(e, ctx) {
  if (ctx.isBlocked() || isEditable(e.target)) return;
  if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
  clearTimeout(longPressTimer);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { stage.setPointerCapture(e.pointerId); } catch {}

  if (pointers.size === 2) {
    if (gesture?.type === 'drag' && gesture.moved) ctx.changed();
    if (gesture?.type === 'resize' || gesture?.type === 'rotate') ctx.changed();
    startPinch();
    return;
  }
  if (pointers.size > 2) return;

  const t = e.target;
  const node = t.closest('.card');
  const card = node ? cardById(node.dataset.id) : null;
  const handle = t.closest('.handle');
  const stringId = t.closest('[data-string]')?.dataset.string;
  const base = { sx: e.clientX, sy: e.clientY, t0: performance.now(), moved: false, card, pointerType: e.pointerType };

  // Middle button always pans.
  if (e.button === 1 || !state.edit) {
    gesture = { ...base, type: 'pan', vx: view.x, vy: view.y, tapCard: card };
    return;
  }

  if (stringId) {
    state.selection.clear();
    state.selectedString = stringId;
    refreshSelection();
    gesture = { ...base, type: 'pan', vx: view.x, vy: view.y };
    return;
  }

  if (state.tool === 'connect') {
    gesture = { ...base, type: 'pan', vx: view.x, vy: view.y, connectCard: card };
    return;
  }

  if (handle && card) {
    ctx.pushUndo();
    const center = { x: card.x + card.w / 2, y: card.y + card.h / 2 };
    if (handle.dataset.handle === 'resize') {
      gesture = { ...base, type: 'resize', w0: card.w, h0: card.h, aspect: isMedia(card) ? mediaAspect(card) : null };
    } else {
      const p = screenToWorld(e.clientX, e.clientY);
      gesture = { ...base, type: 'rotate', center, rot0: card.rot || 0, a0: Math.atan2(p.y - center.y, p.x - center.x) };
    }
    return;
  }

  if (card) {
    state.selectedString = null;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    let toggledOff = false;
    if (additive) {
      if (state.selection.has(card.id)) { state.selection.delete(card.id); toggledOff = true; }
      else state.selection.add(card.id);
      refreshSelection();
    } else if (!state.selection.has(card.id)) {
      state.selection = new Set([card.id]);
      refreshSelection();
    }
    const ids = toggledOff ? [] : [...state.selection];
    gesture = {
      ...base, type: 'drag', ids, additive,
      starts: ids.map((id) => { const c = cardById(id); return c && { c, x: c.x, y: c.y }; }).filter(Boolean),
    };
    if (e.pointerType === 'touch') {
      longPressTimer = setTimeout(() => {
        if (gesture && gesture.type === 'drag' && !gesture.moved) {
          gesture = null;
          navigator.vibrate?.(10);
          ctx.cardMenu(card, { x: base.sx, y: base.sy });
        }
      }, 550);
    }
    return;
  }

  // Background.
  if (!(e.shiftKey || e.metaKey || e.ctrlKey) && (state.selection.size || state.selectedString)) {
    state.selection.clear();
    state.selectedString = null;
    refreshSelection();
  }
  gesture = { ...base, type: 'pan', vx: view.x, vy: view.y, background: true };
}

function onMove(e, ctx) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;

  if (gesture.type === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const z = Math.min(4, Math.max(0.1, gesture.z0 * (d / gesture.d0)));
    view.zoom = z;
    view.x = mid.x - gesture.anchor.x * z;
    view.y = mid.y - gesture.anchor.y * z;
    applyViewport();
    return;
  }

  const dx = e.clientX - gesture.sx;
  const dy = e.clientY - gesture.sy;
  if (!gesture.moved) {
    const slop = gesture.pointerType === 'touch' ? DRAG_SLOP * 2 : DRAG_SLOP;
    if (Math.hypot(dx, dy) < slop) return;
    gesture.moved = true;
    clearTimeout(longPressTimer);
    if (gesture.type === 'pan') stage.classList.add('panning');
    if (gesture.type === 'drag') {
      if (!gesture.starts.length) { gesture = { ...gesture, type: 'pan', vx: view.x, vy: view.y }; stage.classList.add('panning'); }
      else {
        ctx.pushUndo();
        let z = maxZ();
        for (const s of gesture.starts) {
          if (s.c.type !== 'frame') s.c.z = ++z;
          elFor(s.c.id)?.classList.add('dragging');
        }
        // Dragging a frame carries the cards sitting inside it.
        const frames = gesture.starts.filter((s) => s.c.type === 'frame').map((s) => s.c);
        if (frames.length) {
          const moving = new Set(gesture.starts.map((s) => s.c.id));
          for (const c of state.board.cards) {
            if (moving.has(c.id) || c.type === 'frame') continue;
            const cx = c.x + c.w / 2;
            const cy = c.y + c.h / 2;
            if (frames.some((f) => cx > f.x && cx < f.x + f.w && cy > f.y && cy < f.y + f.h)) {
              gesture.starts.push({ c, x: c.x, y: c.y });
              moving.add(c.id);
            }
          }
        }
        schedulePaint(gesture.starts.map((s) => s.c));
      }
    }
  }

  const z = view.zoom;
  switch (gesture.type) {
    case 'pan':
      view.x = gesture.vx + dx;
      view.y = gesture.vy + dy;
      applyViewport();
      break;
    case 'drag':
      for (const s of gesture.starts) { s.c.x = Math.round(s.x + dx / z); s.c.y = Math.round(s.y + dy / z); }
      schedulePaint(gesture.starts.map((s) => s.c));
      break;
    case 'resize': {
      const c = gesture.card;
      // Work in the card's rotated frame so resizing a tilted card follows the pointer.
      const a = (-(c.rot || 0) * Math.PI) / 180;
      const ldx = (dx * Math.cos(a) - dy * Math.sin(a)) / z;
      const ldy = (dx * Math.sin(a) + dy * Math.cos(a)) / z;
      const min = c.type === 'frame' ? 120 : 80;
      let w = Math.max(min, gesture.w0 + ldx);
      let h = Math.max(min * 0.6, gesture.h0 + ldy);
      if (gesture.aspect) h = polaroidHeight(w, gesture.aspect);
      c.w = Math.round(w);
      c.h = Math.round(h);
      schedulePaint([c]);
      break;
    }
    case 'rotate': {
      const c = gesture.card;
      const p = screenToWorld(e.clientX, e.clientY);
      let r = gesture.rot0 + ((Math.atan2(p.y - gesture.center.y, p.x - gesture.center.x) - gesture.a0) * 180) / Math.PI;
      r = ((r + 540) % 360) - 180;
      if (e.shiftKey) r = Math.round(r / 15) * 15;
      else if (Math.abs(r) < 2) r = 0;
      c.rot = Math.round(r * 10) / 10;
      schedulePaint([c]);
      break;
    }
  }
}

function onUp(e, ctx, cancelled = false) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  clearTimeout(longPressTimer);
  try { stage.releasePointerCapture(e.pointerId); } catch {}
  if (!gesture) return;

  if (gesture.type === 'pinch') {
    if (pointers.size === 1) {
      // Continue as a pan with the remaining finger.
      const [p] = [...pointers.values()];
      gesture = { type: 'pan', sx: p.x, sy: p.y, vx: view.x, vy: view.y, moved: true, t0: 0 };
    } else if (!pointers.size) { gesture = null; ctx.viewportChanged(); }
    return;
  }
  if (pointers.size) return;

  const g = gesture;
  gesture = null;
  stage.classList.remove('panning');
  document.querySelectorAll('.card.dragging').forEach((n) => n.classList.remove('dragging'));

  if (g.type === 'pan') {
    if (g.moved) { ctx.viewportChanged(); return; }
    if (cancelled) return;
    if (g.connectCard) { ctx.connectClick(g.connectCard); return; }
    if (g.tapCard) { // locked: tap a card to view it
      ctx.openCard(g.tapCard);
      return;
    }
    if (g.background && state.edit) {
      if (isDouble(null, e)) ctx.addNoteAt(screenToWorld(e.clientX, e.clientY));
    }
    return;
  }
  if (g.type === 'drag') {
    if (g.moved) { ctx.changed(); return; }
    if (cancelled) return;
    // A click on a card that is part of a multi-selection selects just that card.
    if (!g.additive && state.selection.size > 1) { state.selection = new Set([g.card.id]); refreshSelection(); }
    if (isDouble(g.card.id, e)) ctx.activateCard(g.card, e.target);
    return;
  }
  if (g.type === 'resize' || g.type === 'rotate') {
    if (g.moved) ctx.changed();
  }
}

function isDouble(id, e) {
  const now = performance.now();
  const hit = lastTap && lastTap.id === id && now - lastTap.t < DOUBLE_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30;
  lastTap = hit ? null : { id, t: now, x: e.clientX, y: e.clientY };
  return hit;
}

let wheelTimer = 0;
function onWheel(e) {
  if (isEditable(e.target) && e.target.scrollHeight > e.target.clientHeight) return;
  e.preventDefault();
  const pinch = e.ctrlKey || e.metaKey;
  const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);
  if (pinch || mouseWheel) {
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const factor = Math.exp(-dy * (pinch ? 0.01 : 0.0018));
    zoomAt(e.clientX, e.clientY, view.zoom * factor);
  } else {
    view.x -= e.deltaX;
    view.y -= e.deltaY;
    applyViewport();
  }
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => stage.dispatchEvent(new CustomEvent('viewport-settled')), 400);
}
