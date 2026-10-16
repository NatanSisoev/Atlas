// A tiny History API router: "/", "/c/:id", "/c/:id/i/:itemId", "/c/:id/play".
import { flushSync } from 'svelte';

export type Route =
  | { name: 'cover' }
  | { name: 'chapter'; id: string }
  | { name: 'viewer'; id: string; itemId: string }
  | { name: 'play'; id: string }
  | { name: 'notfound' };

interface HistoryState {
  idx?: number;
  scrollY?: number;
  /** This entry was opened from its parent screen, so "back" can simply go back. */
  child?: boolean;
}

function dec(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

/** Percent-encode one path segment ("l:0007_pier.jpg" -> "l%3A0007_pier.jpg"). The server answers
 *  every /c/... path with the app shell, so item ids may keep their file extension. */
export function enc(seg: string): string {
  return encodeURIComponent(seg);
}

export function parse(pathname: string): Route {
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length === 0) return { name: 'cover' };
  if (segs[0] === 'c' && segs.length >= 2) {
    const id = dec(segs[1]);
    if (!id) return { name: 'notfound' };
    if (segs.length === 2) return { name: 'chapter', id };
    if (segs.length === 3 && segs[2] === 'play') return { name: 'play', id };
    if (segs.length === 4 && segs[2] === 'i') {
      const itemId = dec(segs[3]);
      if (itemId) return { name: 'viewer', id, itemId };
    }
  }
  return { name: 'notfound' };
}

export const coverPath = () => '/';
export const chapterPath = (id: string) => `/c/${enc(id)}`;
export const itemPath = (id: string, itemId: string) => `/c/${enc(id)}/i/${enc(itemId)}`;
export const playPath = (id: string) => `/c/${enc(id)}/play`;

/** Is `next` a screen opened from `prev` (cover -> chapter -> viewer/play)? */
export function isDescendant(prev: Route, next: Route): boolean {
  if (prev.name === 'cover') return next.name === 'chapter' || next.name === 'viewer' || next.name === 'play';
  if (prev.name === 'chapter') return (next.name === 'viewer' || next.name === 'play') && next.id === prev.id;
  return false;
}

export const router = $state<{ route: Route }>({ route: parse(location.pathname) });

/** Set by the app: name the elements that should morph (willChange), clear the names after (didChange). */
export const hooks: { willChange?: (prev: Route, next: Route) => void; didChange?: () => void } = {};

const state = (): HistoryState => (history.state && typeof history.state === 'object' ? history.state : {});

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
if (typeof state().idx !== 'number') history.replaceState({ ...state(), idx: 0 }, '');

type ViewTransitionDoc = Document & {
  startViewTransition?: (cb: () => void) => { finished: Promise<void>; ready: Promise<void> };
};

/**
 * Run a DOM-changing update inside a View Transition when the browser has them: named elements
 * (hero, media) morph and the rest crossfades. Under reduced motion no names are set, so it is a
 * plain crossfade.
 */
export function withTransition(update: () => void): void {
  const doc = document as ViewTransitionDoc;
  const done = () => hooks.didChange?.();
  if (typeof doc.startViewTransition !== 'function' || document.visibilityState !== 'visible') {
    update();
    done();
    return;
  }
  try {
    const t = doc.startViewTransition(() => {
      update();
      flushSync();
    });
    t.ready.catch(() => {
      /* skipped (e.g. hidden tab): the update still ran */
    });
    t.finished.then(done, done);
  } catch {
    update();
    done();
  }
}

function announce(next: Route): void {
  hooks.willChange?.(router.route, next);
  flushSync();
}

function commit(scroll: 'top' | 'keep' | number): void {
  router.route = parse(location.pathname);
  flushSync();
  if (scroll === 'top') window.scrollTo(0, 0);
  else if (typeof scroll === 'number') window.scrollTo(0, scroll);
}

export interface NavigateOptions {
  replace?: boolean;
  child?: boolean;
  scroll?: 'top' | 'keep';
  transition?: boolean;
}

export function navigate(to: string, opts: NavigateOptions = {}): void {
  const cur = state();
  const next = parse(new URL(to, location.href).pathname);
  history.replaceState({ ...cur, scrollY: window.scrollY }, '');
  const child = opts.child ?? (!opts.replace && isDescendant(router.route, next));
  const apply = () => {
    const idx = cur.idx ?? 0;
    if (opts.replace) history.replaceState({ idx, child: opts.child ?? cur.child }, '', to);
    else history.pushState({ idx: idx + 1, child }, '', to);
    commit(opts.scroll ?? 'top');
  };
  if (opts.transition === false) {
    apply();
    return;
  }
  announce(next);
  withTransition(apply);
}

/** Leave this screen for its parent: go back when it was opened from there, else replace. */
export function leaveTo(parent: string): void {
  const s = state();
  if (s.child && (s.idx ?? 0) > 0) history.back();
  else navigate(parent, { replace: true, child: false, scroll: router.route.name === 'viewer' ? 'keep' : 'top' });
}

window.addEventListener('popstate', () => {
  const prev = router.route;
  const next = parse(location.pathname);
  const y = state().scrollY;
  // Closing an overlay keeps the story exactly where it is (the viewer may have scrolled it).
  const keep = (prev.name === 'viewer' || prev.name === 'play') && next.name === 'chapter';
  const apply = () => commit(keep ? 'keep' : typeof y === 'number' ? y : 'top');
  if (prev.name === 'play' || (prev.name === 'viewer' && next.name === 'viewer')) {
    apply();
    hooks.didChange?.();
    return;
  }
  announce(next);
  withTransition(apply);
});
