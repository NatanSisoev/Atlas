# Atlas web client

The book you read at `/`: a Svelte 5 + Vite + TypeScript PWA. Read-only in M1.
`atlas serve` serves the built copy in `web/dist` (committed). The old canvas lives at `/board/`.

```
npm install
npm run build   # web/ -> web/dist (run after every client change and commit dist)
npm run check   # svelte-check + type-check of the service worker
npm run dev     # Vite on :5173; proxies /api, /media and /board to ATLAS_URL (default http://127.0.0.1:5180)
```

## Layout

- `index.html`: no inline scripts (CSP `script-src 'self'`).
- `src/main.ts`, `src/App.svelte`: entry and routes: `/` Cover, `/c/:id` Story, `/c/:id/i/:itemId` Viewer, `/c/:id/play` Play.
- `src/components/`: `Cover`, `Story`, `PageSection` (plate + justified rows), `MediaTile`, `Viewer`, `Play`, `SettingsSheet`, `ProgressiveImg`, `Icon`.
- `src/lib/`: `api.ts` (GET-only client and normalisation; media URLs pass `model/urls.js` `safeMediaPath`), `cache-names.ts` (shared with the worker), `updates.ts`, `sizes.ts` (`srcset`/`sizes` for cover-cropped images), `router.svelte.ts` (History API + View Transitions), `store.svelte.ts`, `layout.ts` (justified-layout), `plates.ts`, `format.ts`, `prefs.svelte.ts` (`atlas:type`, `atlas:me`), `viewport.svelte.ts`, `fullscreen.ts`, `model.ts` (re-exports `../model/time.js`).
- `src/sw.ts`: service worker (Workbox via vite-plugin-pwa `injectManifest`), registered from the bundle by `src/lib/updates.ts` (`virtual:pwa-register`: no inline script). An app that comes back to the front checks for a new deploy and reloads into it on a calm screen (Cover, Story). The app shell is precached (its revision includes a hash of the server's CSP and security headers), but `/` and `/c/*` navigations go to the network first (3 s), so installed apps get the server's current headers; the precached shell is the offline copy. Thumbnails: versioned `/media/local/thumb/*?…&v=` cache-first in `atlas-thumbs-v2` (3000 entries), keeping only responses the server marks `immutable` (never the source file sent when no thumbnail could be made); offline, a width never fetched is answered by a cached width of the same version. `/api/atlas`, `/api/chapters/*`, `/api/health`: network-first (6 s) with a cached fallback marked `X-Atlas-Cache: fallback` (network failed) or `slow` (timed out; the fresh copy is posted to the page when it lands, see `listenForFreshCopies` in `src/lib/store.svelte.ts`). A proxy's 502/503/504 (Tailscale Serve with Atlas stopped) counts as offline. Video and full-size media are never cached. On the very first visit the page loads before the worker controls it, so `src/lib/offline.ts` asks again, through the worker, for the book's JSON and the thumbnails already on screen as soon as it takes over: one visit is enough for the last-read chapter to open offline.
- `src/styles/`: design tokens (`app.css`) and self-hosted fonts (`fonts.css`: Newsreader and Inter variable, latin + latin-ext).
- `public/icons/`: app icons (Newsreader "A" on paper), generated with ImageMagick.
- `licenses/`: font licences (SIL OFL 1.1).
