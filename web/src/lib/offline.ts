// The first visit is answered by the network before the service worker controls the page, so
// none of it is in the worker's caches yet. When the worker takes over, ask again (through it
// this time) for what this page already shows: the book's JSON and the thumbnails on screen.
// From then on the last-read chapter opens offline even if the page is never reloaded online.
import { requestedChapters } from './store.svelte';

const isThumb = (u: URL) => u.origin === location.origin && u.pathname.startsWith('/media/local/thumb/') && u.searchParams.has('v');

export function warmWhenControlled(): void {
  const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
  if (!sw || sw.controller) return;
  sw.addEventListener(
    'controllerchange',
    () => {
      const urls = new Set<string>(['/api/atlas']);
      for (const id of requestedChapters) urls.add(`/api/chapters/${encodeURIComponent(id)}`);
      for (const img of document.querySelectorAll('img')) {
        // currentSrc is set only for images the browser actually asked for (lazy ones stay lazy).
        if (!img.currentSrc) continue;
        const u = new URL(img.currentSrc, location.href);
        if (isThumb(u)) urls.add(u.pathname + u.search);
      }
      for (const url of urls) fetch(url, { credentials: 'same-origin' }).catch(() => {});
    },
    { once: true },
  );
}
