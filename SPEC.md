# Atlas — product spec

A self-hosted, local-first **canvas for memories**: place photos, videos, notes,
chat messages, flight tickets, screenshots and links onto an infinite board, with
media read **in place** from a folder on disk and from **GoPro share links** —
nothing is copied or uploaded to a third party.

This file is the authoritative spec. Keep it up to date when behaviour changes.

## Principles

- **Your files stay where they are.** The app never modifies, moves or deletes
  media in the workspace folder. Everything it writes goes into
  `<workspace>/.atlas/`.
- **Zero runtime dependencies on the server.** Node ≥ 20 built-ins only (`http`, `fs`,
  `path`, `crypto`, `child_process`, `url`, global `fetch`). The book (`web/`, Svelte +
  Vite) is built into `web/dist`, which is committed, so running needs no build; the old
  canvas (`public/`) stays vanilla JS.
- **Optional external tools**, detected at runtime with graceful fallbacks:
  `ffmpeg`/`ffprobe` (video posters), ImageMagick `magick` (thumbnails, PDF
  first page via Ghostscript), `exiftool` (capture dates). Without them the app
  still works (placeholders, file mtimes).
- **No personal data in the repo.** Never commit share links, media, board data,
  or paths from the author's machine. Tests use generated fixtures; live GoPro
  tests read the link from the `GOPRO_TEST_LINK` environment variable.
- **Private by default.** Binds to `127.0.0.1`. Remote/phone access is done with
  Tailscale Serve (documented), never by opening a public port.

## Concepts

- **Workspace** — a folder of media (e.g. `C:\Users\me\Trip 2026`). Run
  `node bin/atlas.js serve "<folder>"`. The app keeps all its state in
  `<folder>/.atlas/`:
  - `settings.json` — workspace settings (title, people for message cards, display
    folder, port overrides)
  - `boards/<id>.json` — boards
  - `backups/<boardId>/<ISO>_r<rev>.json` — previous versions (newest 30, then one per
    10 minutes, at most 100 files)
  - `uploads/<sha16>.<ext>` — files added through the app (tickets, screenshots…)
  - `gopro/<linkId>.json` — cached GoPro share-link listings
  - `cache/` — thumbnails and the media index (regenerable)
  - `trash/` — deleted boards/links (never hard-delete)
  Backing up the workspace folder backs up everything.
- **Display copies** (optional) — a subfolder with smaller copies using the same
  filenames (default: `<workspace>/compressed` if it exists; configurable via
  `settings.json` → `displayDir`). Used for viewing and for phones (H.264 instead
  of HEVC). Originals are always available via "open original".
- **Board** — an infinite canvas of cards and strings.

## CLI — `bin/atlas.js`

- `serve <folder> [--port 5180] [--host 127.0.0.1] [--open]` — start the app.
- `info <folder>` — print what the app sees (media counts, display copies, tools found).
- `prepare <folder> [--dry-run]` — (optional, later) generate display copies into
  `<folder>/.atlas/display/` with ffmpeg/magick. **Dry-run is the default**
  and prints a readable report; `--apply` writes.
- Windows helper: `atlas.cmd` next to `bin/` that forwards to node.

## Server

Config precedence: CLI flags > env (`PORT`, `HOST`, `ATLAS_DATA_DIR`,
`ATLAS_PUBLIC_HOST`) > `<workspace>/.atlas/settings.json` > defaults (`port 5180`,
`host 127.0.0.1`). `ATLAS_WEB_DIST` points the server at another build of the web
client (default `<repo>/web/dist`; the tests use a stand-in).

Security:
- DNS-rebinding guard: reject requests whose `Host` hostname is not `localhost`,
  `127.0.0.1`, `[::1]`, the configured host, `settings.allowedHosts`, or:
  - when `publicHost` is set (`settings.json` → `"publicHost":
    "atlas.tailnet-name.ts.net"`, or env `ATLAS_PUBLIC_HOST`): exactly that name, and no
    other `*.ts.net` name. A value that is not a plain host name stops the server at startup.
  - otherwise (backwards compatible), when `allowTailscale` (default true): any name
    ending in `.ts.net`
  → 403.
- Fetch Metadata guard on reads: a `GET`/`HEAD` to `/api/*` or `/media/*` with
  `Sec-Fetch-Site: cross-site` or `same-site` → 403. `same-origin`, `none` (typed URL,
  bookmark) and no header (curl, older browsers) pass. Top-level navigations to the app's
  HTML pages are not affected.
- Every `/media/*` response carries `Cross-Origin-Resource-Policy: same-origin`.
- Every path from a request is resolved and must stay inside its root
  (workspace / display dir / uploads dir) → 404 otherwise. Local media limited to
  known extensions (`.jpg .jpeg .png .webp .gif .heic .mp4 .mov .m4v .webm`).
- CSRF: every non-GET request must send `X-Requested-With: Atlas` (forces a CORS
  preflight that is never answered) and, if it has an `Origin`, a same-host one → 403.
- JSON bodies ≤ 5 MB, `Content-Type: application/json` (415 otherwise). Uploads ≤ 300 MB,
  streamed to disk while hashing; over-limit requests get 413 and the connection is closed.
- External decoders never sniff: ImageMagick gets an explicit coder from the extension
  (`png:file[0]`), ffmpeg/ffprobe get `-f <demuxer>` and `-protocol_whitelist file`.
- `X-Content-Type-Options: nosniff`. Uploaded HTML/JS is never served as active
  content; SVG served with `Content-Security-Policy: sandbox`; unknown types forced
  to download.
- Range requests (206) on all media/file routes. Long immutable caching for
  thumbnails and content-addressed uploads; `no-store` for `/api`.
- HTML pages (the web client, the old board, the build hint) are served with the app CSP:
  `default-src 'self'; script-src 'self'` (no inline scripts), `style-src 'self'
  'unsafe-inline'`, `font-src 'self' data:`, media and images from self (+ GoPro), `object-src
  'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'self'`.

### Static routing

- `GET /board` → 301 `/board/`; `/board/` → `public/index.html`; `/board/<file>` →
  `public/<file>` (the old canvas, unchanged; it calls the absolute `/api/*` and
  `/media/*` routes). Missing files → 404 (no fallback).
- Everything else that is not `/api/*` or `/media/*` is the web client from `web/dist`:
  - a file that exists is served as is: `/assets/*` (content-hashed) with
    `Cache-Control: private, max-age=31536000, immutable`; everything else (`index.html`,
    `sw.js`, `registerSW.js`, `manifest.webmanifest`, icons) with `no-cache` (revalidate
    by ETag);
  - SPA fallback: `/`, every path under `/c/` (item ids contain file names with dots), and
    any other path whose last segment has no file extension → `web/dist/index.html`;
  - other missing files → 404.
  - When `web/dist/index.html` does not exist, the app paths answer 503 with a small static
    page that says to run `npm run build` (and links to `/board/`).
- Never crash on a bad request; JSON errors `{error}` with proper status; one log
  line per request.

### API

- `GET /api/health` → `{ok, version, schemaVersion: 1, workspace:{title}, counts:{local, boards, goproLinks}, tools:{ffmpeg, magick, exiftool}}`
  (`counts.local` is `null` while a first media scan is still running; health never blocks on it)

The book (read-only in M1; drafted at read time from the local media index, nothing stored;
`model/time.js` and `model/view.js` are shared with the client):
- `GET /api/atlas` → `{schemaVersion: 1, title, people:[{name,color}], chapters:[ChapterSummary]}`.
  In M1 there is exactly one chapter, the workspace folder (`id: "folder"`, title = settings
  title, else the folder name), drafted with `draftFolderChapter`; it is Curated when ≥ 80% of
  the file names start with `NNNN_`. A folder without media → `chapters: []`.
- `GET /api/chapters/:id` → `{chapter: ChapterSummary, pages:[{id, date, plate, items:[itemId]}], items:{[itemId]: Item}}`;
  unknown id → 404 `{error}`. `plate` = `formatPlate(date)` (`{weekday:'TUE', day:'12',
  month:'AUG', long:'Tue 12 Aug', full:'Tuesday 12 August 2025'}`) or `null` for an undated
  page. `items` is keyed in story order.
- ChapterSummary = `{id, title, from, to, status, range, itemCount, pageCount, photoCount, videoCount, cover: Item|null}`;
  `from`/`to` are local days `YYYY-MM-DD` (04:00 day start) or `null`; `status` is
  `upcoming|ongoing|past|someday`; `range` = `formatRange(from, to)` (`'10–14 Aug 2025'`) or `null`.
- Pages: walk the story order (Curated: filename index, then name; otherwise capture time,
  undated last) and start a page whenever the local day changes; undated items stay on the
  current page; going back to an earlier day starts its own page. Page ids `p1, p2, …`.
  The cover is the first photo (else the first item).
- Item = `{id: "l:" + path, kind: "photo"|"video", name, label, index, takenLocal, w, h, durationSec, hasDisplay, urls:{t400, t1200, display, original, download}}`.
  `takenLocal` is the capture time as the camera wrote it (local wall clock, optionally with an
  offset suffix) or `null`; `w`/`h` may be `null`. URLs use the routes below with each path
  segment `encodeURIComponent`-ed: `t400`/`t1200` = `/media/local/thumb/<path>?w=400|1200&v=<mtime ms>`
  (immutable), `display` = `/media/local/display/<path>`, `original` =
  `/media/local/original/<path>`, `download` = the original with `?download=1`.
- `GET /api/settings` / `PUT /api/settings` — `{title, people:[{name,color}], displayDir}`

Boards:
- `GET /api/boards` → `[{id,title,updatedAt,cardCount}]` newest first; creates a
  default board named after the workspace when none exist.
- `POST /api/boards {title}` → board (201)
- `GET /api/boards/:id`
- `PUT /api/boards/:id` with `If-Match: <rev>` → `{rev, updatedAt}`; stale rev →
  409 `{error:"conflict", current}`; missing `If-Match` → 428. Atomic write (temp + fsync +
  rename) and previous version kept in `backups/`. Saves to one board are serialised.
- `DELETE /api/boards/:id` → moved to `trash/`.

Board doc: `{id, title, rev, createdAt, updatedAt, viewport:{x,y,zoom}, cards:[Card], strings:[{id, from, to, color}]}`

Card: `{id, type:"photo"|"video"|"note"|"message"|"file"|"link"|"frame", x, y, w, h, rot, z, color?, caption?, text?, from?, at?, url?, title?, src?: MediaRef}`
(the server validates shape lightly; the frontend owns semantics)

MediaRef:
- `{kind:"local", path}` — relative to the workspace, forward slashes
- `{kind:"gopro", linkId, mediumId, token, mediaType, filename, capturedAt, tz, width, height}`
- `{kind:"upload", id, name, mime, size}`

Local media:
- `GET /api/local` → `{items:[{path, name, label, index, type:"photo"|"video", size, mtime, capturedAt, width, height, durationSec, hasDisplay}]}` sorted by filename. `index` = leading number if the name starts with digits + `_`; `label` = rest of name, underscores → spaces. Metadata from one batched `exiftool -json -n` run, cached in `cache/local-index.json` keyed by path+size+mtime, indexed incrementally. Recursive (skip dot-folders and the display folder).
- `GET /media/local/thumb/<path>?w=400` (w snapped up to 128/200/400/800/1200) → cached JPEG; photos via magick (`-auto-orient -thumbnail`), videos via ffmpeg frame at 1 s; prefer the display copy as source; de-duplicated jobs, ≤ 3 concurrent processes; placeholder on failure.
- `GET /media/local/display/<path>` → display copy if present else original.
- `GET /media/local/original/<path>[?download=1]`

GoPro share links (verified to work anonymously — no login, no token):
- A share link is `https://gopro.com/v/<collection-uuid>`.
- Upstream (server-side only; `api.gopro.com` sends no CORS headers for other origins):
  - `GET https://api.gopro.com/collections/{id}?fields=title,gopro_user_id,media_count,created_at,cloneable,livestream_collection` with `Accept: application/vnd.gopro.jk.collections+json; version=2.0.0`
  - `GET https://api.gopro.com/media/items/{id}?page=N&per_page=200` with `Accept: application/vnd.gopro.jk.media+json; version=2.0.0` → `{title, media_count, items:[{type:"medium", medium:{id, filename, type:"Photo"|"Video"|"Continuous"|…, captured_at (UTC ISO), captured_at_timezone ("+03:00"), width, height, file_size, token, …}}], _pages:{current_page, total_pages, total_items}}`
  - Images: `https://images-0{1..4}.gopro.com/resize/{W}w/{token}` (plain `<img>`, token never expires). Only W ∈ {450, 640, 1280, 1920, 2560} work; other widths 404.
  - `GET https://api.gopro.com/media/{mediumId}/download` (same Accept) → `_embedded.files[]` (videos: 1080p H.264) and `_embedded.variations[]` (`source`, `high_res_proxy_mp4`, `edit_proxy` 720p, `audio_proxy`). Signed CDN URLs **expire after ~1 hour**.
  - Use a browser-like User-Agent; fetch pages sequentially; cache.
- App routes:
  - `GET /api/gopro/links` → `[{id,title,url,mediaCount,createdAt,fetchedAt}]`
  - `POST /api/gopro/links {url}` → accepts full URL (with/without query or trailing slash) or bare UUID; fetches metadata + all pages; stores `gopro/<id>.json`; 400 bad URL, 404 not found, 502 upstream.
  - `POST /api/gopro/links/:id/refresh`, `DELETE /api/gopro/links/:id` (→ trash)
  - `GET /api/gopro/links/:id/items` → `{link, items:[{mediumId, filename, mediaType, capturedAt, tz, width, height, fileSize, token, durationSec}]}` sorted by capture time
  - `GET /media/gopro/thumb/:token?w=450` → 302 to `images-0N` (N = 1 + hash(token) % 4; w snapped up to 450/640/1280/1920/2560; token `^[A-Za-z0-9._-]+$`)
  - `GET /media/gopro/play/:mediumId` → 302 to a fresh 1080p H.264 URL (prefer 1920×1080 h264 file / `high_res_proxy_mp4`, then `edit_proxy`, then `source`); cache 40 min; id `^[a-f0-9]{16,40}$` and must belong to a saved link. The CDN labels
    videos `binary/octet-stream`, so `?via=server` streams through the server as `video/mp4`
    (Range passed through) for players that refuse it (iOS Safari).
  - `GET /media/gopro/original/:mediumId` → 302 to `source`

Uploads:
- `POST /api/uploads` raw body + `Content-Type` + `X-Filename` (URI-encoded) → `{id, name, mime, size, url, thumbUrl}`; dedup by hash.
- `GET /media/uploads/:id[?download=1]`, `GET /media/uploads/:id/thumb?w=400` (images, videos, PDFs first page; placeholder otherwise).

## Old canvas frontend (`public/`, served at `/board/`)

Vanilla ES modules (e.g. `api.js`, `board.js`, `interactions.js`, `library.js`,
`lightbox.js`, `uploads.js`, `undo.js`, `ui.js`). No external resources (system font
stack). Never use `innerHTML`
with untrusted strings (captions, filenames, notes, GoPro titles).

Look & feel — modern and minimal, light and dark (follows the system): a neutral
canvas with a subtle dot grid that pans and scales with the view; flat rounded cards
with soft shadows, no rotation by default; photos/videos full-bleed with a slim
caption row (videos: play badge + duration); notes as softly tinted cards; chat-bubble
message cards (sender dot, time; people from settings); file cards with a preview
strip; link cards (title + host); frames as quiet rounded areas with a small label;
connections as thin curved lines from edge to edge with small end dots.

Mechanics:
- Infinite canvas: world div with `translate() scale()`; pan (drag background /
  one finger), zoom (wheel around cursor, trackpad pinch, two-finger pinch,
  buttons, fit-all), range 0.1–4, viewport persisted.
- Select, shift-multi-select, drag (pointer capture, rAF transforms), resize
  (aspect-locked for media), rotate, z-to-front, delete, duplicate, undo/redo
  (≤100 snapshots), Escape, keyboard help popover.
- Double-click/tap: edit text inline; media opens a lightbox (prev/next, arrows,
  swipe, video playback, open original/download).
- Connect tool; click a connection to recolour or delete it.
- Add menu: note, message, link, frame, upload; drag-and-drop files; paste
  screenshots from the clipboard; upload progress.
- Library drawer (side on desktop, bottom sheet on phone):
  - **This computer** — grid of local media grouped by capture day, filter
    photos/videos, search, "on board" badges, multi-select + "Add N to board"
    (grid at view centre), drag to board.
  - **GoPro** — saved links (title, count, refresh, remove), "Paste a GoPro share
    link", items grouped by local capture day (`capturedAt` + `tz`), select items
    or whole days, "Add N to board".
- Autosave: debounce 700 ms, `If-Match` rev, status pill
  (Saved / Saving… / Offline / Conflict); every change is mirrored to a localStorage
  safety copy (restored automatically on load when it never reached the server).
  409 → toast "Reload latest" (the local version is first saved as a new board
  "<title> (my copy)") or "Keep mine" (overwrite; the server keeps a backup);
  `keepalive` save on pagehide. Never lose text.
- Viewport is remembered per board and per device (localStorage) and written into the
  board doc with the next content save, so panning alone never creates backups.
- Boards menu: list, switch, create, rename, delete (→ trash), **Export as PDF** (browser
  print → "Save as PDF": the whole board on one page sized to fit it, light colours,
  title + date header, every image loaded at print resolution first; Ctrl+P prints the
  same layout), **Export for Obsidian**
  (JSON Canvas `.canvas` download: local media → file nodes relative to the workspace,
  notes/messages → text nodes, links → link nodes, frames → groups, strings → edges,
  GoPro photos → text nodes with the remote image); remember last board.
- Phone: compact toolbar, bottom sheet, **Lock** (default on touch: pan + tap to
  view only) / **Edit** toggle, pinch zoom, safe-area insets, ≥40px targets.
- Performance: hundreds of cards smooth; lazy images, `decoding="async"`,
  thumbnail width chosen from on-screen size (200/400/800/1200 steps).
- Empty state hint; graceful placeholders for missing media / revoked links.

## Tests

`node test/run.mjs` — starts the server as a child process on a free port with a
temp workspace of generated fixtures (tiny JPG via magick or a hand-written
minimal JPEG/PNG if magick is missing; 2 s MP4 via ffmpeg lavfi if available) and
checks: health, settings, boards CRUD, 409 conflict, backups, trash, local listing,
thumb/display/original with Range (206), path traversal attempts (encoded `..`,
backslashes, absolute paths, drive letters) → 403/404, bad Host → 403, exact `publicHost`
(other `*.ts.net` names → 403), Fetch Metadata (`cross-site`/`same-site` reads → 403),
CORP on media, the web client routing against a stand-in `web/dist` (SPA fallback, caching
headers, the build hint when it is missing), `/board` → 301 and the old app under
`/board/`, uploads (PNG, PDF) round-trip, SVG sandbox header, GoPro URL parsing (unit), and
the book: a generated Curated trip folder (EXIF dates written with exiftool, or by hand
without it; a video with ffmpeg) must draft into the expected date pages (a 01:30 photo stays
on the evening before; a photo from an earlier day gets its own page; an undated photo
stays put), with item URLs that resolve; unknown chapter → 404. `node test/model.mjs`
unit-tests the shared `model/`. `node test/e2e.mjs` (optional, Playwright; SKIP when it
is not installed) serves the built `web/dist` on a generated trip (`makeBookWorkspace`: 24
photos in six shapes over four days, two videos, display copies in `compressed/`) and reads
it in Chromium at 412×915 (touch) and 1440×900, light and dark: plates and page breaks,
captions, justified rows that fill the measure and never crop, lazy thumbnails, viewer
swipes/keys/details/close with focus returned, video fallback, Play (title → plate →
photo, pause, Esc), reduced motion (no drift), settings (`atlas:type`, `atlas:me`), the old
board and its library at `/board/`, no console errors, failed requests or CSP violations;
then stops the server and reloads offline (shell, chapter and thumbnails from the service
worker with the "Offline" line). With
`GOPRO_TEST_LINK` set, also live: add link, items > 0, `play` redirect resolves
to a `video/mp4` URL, thumb redirect works. Clear PASS/FAIL summary; non-zero exit
on failure. Tests never touch a real workspace.

## Repo layout

```
bin/atlas.js      CLI entry
atlas.cmd         Windows helper
src/                  server modules (server, story, boards, local, gopro, uploads, thumbs, security, config)
model/                pure functions shared by the server and the web client (time, view)
web/                  the book (Svelte + Vite); built into web/dist (committed)
public/               the old canvas, served at /board/
test/                 tests + fixtures generator
README.md  SPEC.md  LICENSE (later)  .gitignore
```
