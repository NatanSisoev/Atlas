// DOM helpers, menus, dialogs and toasts. Never uses innerHTML: all text goes through textContent.

/** el('div.card.note', {attrs, on:{click}, style:{}, dataset:{}}, ...children) */
export function el(spec, props = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? node.style.setProperty(sk, sv) : (node.style[sk] = sv);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

const ICONS = {
  note: 'M5 4h14v11l-5 5H5z M14 20v-5h5',
  message: 'M4 5h16v11H9l-5 4z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  frame: 'M4 7V4h3 M17 4h3v3 M20 17v3h-3 M7 20H4v-3',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
  photo: 'M3 5h18v14H3z M21 15l-5-5L5 19',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  copy: 'M8 8h12v12H8z M16 8V4H4v12h4',
  front: 'M5 9h10v10H5z M9 5h10v10',
  edit: 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  plus: 'M12 5v14 M5 12h14',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  x: 'M6 6l12 12 M18 6L6 18',
  open: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  download: 'M12 4v12 M7 11l5 5 5-5 M4 20h16',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18',
  board: 'M4 4h16v16H4z M4 9h16',
  palette: 'M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.5S13 18 13 17s.7-1.5 1.5-1.5H17a4 4 0 0 0 4-4C21 6.8 17 3 12 3z',
  video: 'M4 6h12v12H4z M16 10l5-3v10l-5-3',
};

export function icon(name, cls = 'i') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of (ICONS[name] || '').split(' M').map((p, i) => (i ? 'M' + p : p))) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// ---- toasts ----
export function toast(message, { actions = [], error = false, timeout = 4500 } = {}) {
  const box = document.getElementById('toasts');
  const t = el(`div.toast${error ? '.error' : ''}`, { role: error ? 'alert' : 'status' }, el('span.msg', { text: message }));
  const close = () => t.remove();
  for (const a of actions) t.append(el('button', { text: a.label, on: { click: () => { close(); a.run(); } } }));
  if (actions.length || timeout === 0) t.append(el('button', { 'aria-label': 'Dismiss', text: '✕', on: { click: close } }));
  box.append(t);
  while (box.children.length > 4) box.firstChild.remove();
  if (timeout) setTimeout(close, timeout);
  return close;
}

// ---- popup menus ----
let openMenu = null;
export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}

/** items: [{label, sub, icon, run, danger, active, swatch} | 'hr' | {heading}] */
export function showMenu(anchor, items, { align = 'left' } = {}) {
  closeMenu();
  const m = el('div.menu', { role: 'menu' });
  for (const it of items) {
    if (it === 'hr') { m.append(el('hr')); continue; }
    if (it.heading) { m.append(el('div.label', { text: it.heading })); continue; }
    const b = el(`button.item${it.danger ? '.danger' : ''}${it.active ? '.active' : ''}`, { role: 'menuitem', on: { click: (e) => { e.stopPropagation(); closeMenu(); it.run(); } } });
    if (it.swatch) b.append(el('span.swatch', { style: { background: it.swatch } }));
    if (it.icon) b.append(icon(it.icon));
    b.append(el('span.title', { text: it.label }));
    if (it.sub) b.append(el('span.sub', { text: it.sub }));
    m.append(b);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  let top = r.bottom + 6;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  left = Math.max(8, Math.min(innerWidth - mw - 8, left));
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
  openMenu = m;
  m.querySelector('button')?.focus({ preventScroll: true });
  return m;
}
document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu) { closeMenu(); e.stopPropagation(); } }, true);
export const menuOpen = () => Boolean(openMenu);

// ---- dialogs ----
let dialogOpen = 0;
export const isDialogOpen = () => dialogOpen > 0;

/**
 * dialog(title, buildFn(body) → getValue, {ok, cancel, danger}) → Promise<value|null>
 */
export function dialog(title, build, { ok = 'Save', cancel = 'Cancel', danger = false, extra } = {}) {
  return new Promise((resolve) => {
    dialogOpen++;
    const body = el('div.dialog-body');
    const getValue = build(body) || (() => true);
    const finish = (v) => {
      dialogOpen--;
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const okBtn = el(`button.${danger ? 'ghost.danger' : 'primary'}`, { type: 'submit', text: ok });
    const actions = el('div.actions');
    if (extra) actions.append(el('button.ghost', { type: 'button', text: extra.label, style: { marginRight: 'auto' }, on: { click: () => finish(extra.value) } }));
    if (cancel) actions.append(el('button.ghost', { type: 'button', text: cancel, on: { click: () => finish(null) } }));
    actions.append(okBtn);
    const form = el('form.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, on: {
      submit: (e) => { e.preventDefault(); const v = getValue(); if (v !== undefined) finish(v); },
    } }, el('h2', { text: title }), body, actions);
    const back = el('div.dialog-backdrop', { on: { pointerdown: (e) => { if (e.target === back) finish(null); } } }, form);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); finish(null); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(back);
    (form.querySelector('input,textarea,select') || okBtn).focus();
  });
}

export function prompt(title, value = '', { label, ok = 'Save', placeholder = '' } = {}) {
  return dialog(title, (body) => {
    const input = el('input', { type: 'text', value, placeholder, maxLength: 200, 'aria-label': label || title });
    if (label) body.append(el('label', { text: label }));
    body.append(input);
    setTimeout(() => input.select(), 0);
    return () => input.value.trim() || undefined;
  }, { ok });
}

export function confirm(title, message, { ok = 'OK', danger = false } = {}) {
  return dialog(title, (body) => { body.append(el('p', { text: message })); }, { ok, danger });
}

export function fmtDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

/** Only http(s) URLs are ever used as link targets. */
export function safeHttpUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export const isTouch = () => matchMedia('(pointer: coarse)').matches;
