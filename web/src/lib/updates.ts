// Service worker registration and updates (bundled, so no inline script: CSP script-src 'self').
// A new deploy takes over as soon as its worker activates: the page reloads into it at once on the
// Cover or a Story, and later (when the viewer or Play closes, or the app comes back to the front)
// anywhere else. An app resumed from the background asks for an update, as a fresh launch would.
import { registerSW } from 'virtual:pwa-register';

let reloadPending = false;
let calm = () => true;

/** Reload into a waiting new version now, if one is waiting and the screen is calm. */
export function reloadIfPending(): void {
  if (reloadPending && calm()) location.reload();
}

/** `isCalm`: may the page reload right now without interrupting someone (Cover, Story)? */
export function startUpdates(isCalm: () => boolean): void {
  if (!('serviceWorker' in navigator)) return;
  calm = isCalm;
  registerSW({
    immediate: true,
    // autoUpdate mode calls this (instead of reloading itself) when an updated worker activates.
    onNeedReload() {
      reloadPending = true;
      reloadIfPending();
    },
    onRegisteredSW(_url, reg) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (reloadPending) location.reload();
        else void reg?.update().catch(() => {});
      });
    },
  });
}
