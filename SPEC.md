# Corkboard — product spec

A self-hosted, local-first **cork board for memories**: pin photos, videos, notes,
chat messages, flight tickets, screenshots and links onto an infinite board, with
media read **in place** from a folder on disk and from **GoPro share links** —
nothing is copied or uploaded to a third party.

This file is the authoritative spec. Keep it up to date when behaviour changes.

## Principles

- **Your files stay where they are.** The app never modifies, moves or deletes
  media in the workspace folder. Everything it writes goes into
  `<workspace>/.corkboard/`.
- **Zero dependencies, no build step.** Node ≥ 20 built-ins only (`http`, `fs`,
  `path`, `crypto`, `child_process`, `url`, global `fetch`). Vanilla JS frontend.
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
  `node bin/corkboard.js serve "<folder>"`. The app keeps all its state in
  `<folder>/.corkboard/`:
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

## CLI — `bin/corkboard.js`

- `serve <folder> [--port 5180] [--host 127.0.0.1] [--open]` — start the app.
- `info <folder>` — print what the app sees (media counts, display copies, tools found).
- `prepare <folder> [--dry-run]` — (optional, later) generate display copies into
  `<folder>/.corkboard/display/` with ffmpeg/magick. **Dry-run is the default**
  and prints a readable report; `--apply` writes.
- Windows helper: `corkboard.cmd` next to `bin/` that forwards to node.

## Server

Config precedence: CLI flags > env (`PORT`, `HOST`, `CORKBOARD_DATA_DIR`) >
`<workspace>/.corkboard/settings.json` > defaults (`port 5180`, `host 127.0.0.1`).

Security:
- DNS-rebinding guard: reject requests whose `Host` hostname is not `localhost`,
  `127.0.0.1`, `[::1]`, the configured host, or (when `allowTailscale`, default
  true) a name ending in `.ts.net` → 403.
- Every path from a request is resolved and must stay inside its root
  (workspace / display dir / uploads dir) → 404 otherwise. Local media limited to
  known extensions (`.jpg .jpeg .png .webp .gif .heic .mp4 .mov .m4v .webm`).
- CSRF: every non-GET request must send `X-Requested-With: corkboard` (forces a CORS
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
- Never crash on a bad request; JSON errors `{error}` with proper status; one log
  line per request.

### API

- `GET /api/health` → `{ok, version, workspace:{title}, counts:{local, boards, goproLinks}, tools:{ffmpeg, magick, exiftool}}`
  (`counts.local` is `null` while a first media scan is still running; health never blocks on it)
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

## Frontend (`public/`)

Vanilla ES modules (e.g. `api.js`, `board.js`, `interactions.js`, `library.js`,
`lightbox.js`, `uploads.js`, `undo.js`, `ui.js`). Only external resource: a Google
Font (handwriting, e.g. Caveat) with good offline fallbacks. Never use `innerHTML`
with untrusted strings (captions, filenames, notes, GoPro titles).

Look & feel — a warm, beautiful physical cork board: CSS cork texture (gradients +
SVG noise data URI), soft vignette; photos as polaroids with handwritten captions
and push pins; sticky notes in handwriting; chat-bubble message cards (sender,
time; people from settings); ticket-style file cards with preview; link cards;
frames as labelled translucent areas; videos as polaroids with play badge and
duration; strings as sagging red yarn (SVG) between pins.

Mechanics:
- Infinite canvas: world div with `translate() scale()`; pan (drag background /
  one finger), zoom (wheel around cursor, trackpad pinch, two-finger pinch,
  buttons, fit-all), range 0.1–4, viewport persisted.
- Select, shift-multi-select, drag (pointer capture, rAF transforms), resize
  (aspect-locked for media), rotate, z-to-front, delete, duplicate, undo/redo
  (≤100 snapshots), Escape, keyboard help popover.
- Double-click/tap: edit text inline; media opens a lightbox (prev/next, arrows,
  swipe, video playback, open original/download).
- Connect tool for strings; click a string to select/delete.
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
- Boards menu: list, switch, create, rename, delete (→ trash), **Export for Obsidian**
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
backslashes, absolute paths, drive letters) → 403/404, bad Host → 403, uploads
(PNG, PDF) round-trip, SVG sandbox header, GoPro URL parsing (unit). With
`GOPRO_TEST_LINK` set, also live: add link, items > 0, `play` redirect resolves
to a `video/mp4` URL, thumb redirect works. Clear PASS/FAIL summary; non-zero exit
on failure. Tests never touch a real workspace.

## Repo layout

```
bin/corkboard.js      CLI entry
corkboard.cmd         Windows helper
src/                  server modules (server, routes, boards, local, gopro, uploads, thumbs, security, config)
public/               frontend
test/                 tests + fixtures generator
README.md  SPEC.md  LICENSE (later)  .gitignore
```
