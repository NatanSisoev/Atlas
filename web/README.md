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
- `src/lib/`: `api.ts` (GET-only client and normalisation), `router.svelte.ts` (History API + View Transitions), `store.svelte.ts`, `layout.ts` (justified-layout), `plates.ts`, `format.ts`, `prefs.svelte.ts` (`atlas:type`, `atlas:me`), `viewport.svelte.ts`, `fullscreen.ts`, `model.ts` (re-exports `../model/time.js`).
- `src/sw.ts`: service worker (Workbox via vite-plugin-pwa `injectManifest`). App shell (including `registerSW.js`) precached; versioned `/media/local/thumb/*?…&v=` cache-first (3000 entries; the old board's unversioned thumbnails are left to the network); `/api/atlas`, `/api/chapters/*`, `/api/health` network-first with a cached fallback marked `X-Atlas-Cache: fallback`; video and full-size media never cached.
- `src/styles/`: design tokens (`app.css`) and self-hosted fonts (`fonts.css`: Newsreader and Inter variable, latin + latin-ext).
- `public/icons/`: app icons (Newsreader "A" on paper), generated with ImageMagick.
- `licenses/`: font licences (SIL OFL 1.1).
