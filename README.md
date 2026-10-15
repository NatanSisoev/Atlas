# Atlas

A local-first canvas for memories. Place photos, videos, notes, chat messages,
flight tickets, screenshots and links on an infinite board, connect related
things, and look at them from your laptop or your phone. Media is read
**in place** from a folder on disk and from **GoPro share links**: no login, no
uploads to anyone, no copying.

[SPEC.md](SPEC.md) is the authoritative spec.

## Run

Requires [Node.js](https://nodejs.org) 20 or newer and nothing else.

```
node bin/atlas.js serve "C:\path\to\your\folder"
```

Then open <http://localhost:5180>. Add `--open` to open the browser for you, or
`--port 5181` for another port. On Windows you can also use `atlas.cmd serve "…"`.

Other commands:

```
node bin/atlas.js info "C:\path\to\your\folder"      # what the app sees, which tools it found
node bin/atlas.js prepare "C:\path\to\your\folder"   # dry run: which display copies are missing
```

### Optional tools

They make it nicer but the app works without them (placeholders instead of video
posters, file dates instead of capture dates).

| Tool | Used for | Install (Windows) |
|---|---|---|
| ffmpeg / ffprobe | video posters and durations | `winget install Gyan.FFmpeg` |
| ImageMagick (+ Ghostscript for PDFs) | photo thumbnails, PDF previews | `winget install ImageMagick.ImageMagick` |
| ExifTool | capture dates and sizes | `winget install OliverBetz.ExifTool` |

Restart the server after installing; `info` shows what it found.

### Display copies (recommended for 4K/HEVC videos)

If the folder has a `compressed` subfolder with smaller copies that use the **same
filenames** (e.g. 2000 px JPGs and 1080p H.264 MP4s), the board and the viewer use
those, which keeps phones fast and makes HEVC videos playable everywhere. The
viewer always has **Open original** for the full-quality file. Use a different
folder with `"displayDir": "my-folder"` in `.atlas/settings.json`.

## Using it

- **Library** (L): photos and videos from the folder, grouped by day. Tap to
  select (or "Select day"), then **Add N to board**, or drag tiles onto the board.
- **GoPro**: Library → GoPro → paste a share link (`https://gopro.com/v/…`, made
  with *Share* in GoPro Quik). Items are grouped by the day they were shot. Nothing
  is downloaded; thumbnails and videos stream from GoPro when you view them.
  **Refresh** picks up new items; removing a link keeps the cards already pinned.
- **Add**: sticky notes (N, or double-click empty board), chat messages (people and
  colours in Settings), links, frames, and files (tickets, PDFs, screenshots). You
  can also drop files on the board or paste a screenshot with Ctrl+V.
- **Connect** (C): tap two cards to draw a line between them; tap a line to
  recolour or remove it.
- Double-click a photo or video to view it full screen (arrows/swipe for next).
  Double-click a note to write, or a caption to change it.
- **Lock / Edit** (E): phones start locked, so you can pan, pinch and tap to view
  without moving anything by accident. Switch to Edit to rearrange; long-press a card
  for its menu.
- Boards menu (top left): several boards per folder, rename, delete, **Export as
  PDF** (choose "Save as PDF" in the print dialog; the whole board goes on one page),
  and **Export for Obsidian** (a `.canvas` file; save it into a vault that contains this folder
  and the local photos show up).
- Press **?** for all keyboard shortcuts.

## Where your data lives

Everything the app writes goes into `<your folder>/.atlas/`. (A folder that already has a `.corkboard/` from before the rename keeps using it.) Your photos and
videos are never modified, moved or deleted.

| Path | What |
|---|---|
| `boards/<id>.json` | your boards (plain JSON) |
| `backups/<id>/…_r<rev>.json` | previous versions of each board: the last 30 saves, then one per 10 minutes, up to 100 |
| `uploads/` | files added through the app (tickets, screenshots…), named by content hash |
| `gopro/<link>.json` | cached GoPro link listings |
| `trash/` | deleted boards and GoPro links (nothing is ever hard-deleted) |
| `cache/` | thumbnails and the media index; safe to delete |
| `settings.json` | title, people, display folder |

**To back up, copy the whole folder** (it includes `.atlas`). To restore an
older version of a board, stop the server and copy a file from
`backups/<id>/` over `boards/<id>.json`. To undelete a board, move it from
`trash/boards/` back into `boards/` and drop the timestamp prefix from the name.

Saving is automatic. If the server is unreachable, changes are kept in the
browser and sent when it is back; if the same board was changed on another device,
you choose between the two versions and the other one is kept as a separate board.

## Phone access with Tailscale

The server only listens on your laptop (`127.0.0.1`). To reach it from your phone,
use [Tailscale](https://tailscale.com) (free), which keeps it private to your own
devices:

1. Install Tailscale on the laptop and the phone and sign in with the same account.
2. Start Atlas on the laptop as usual, then run (once; it survives restarts):

   ```
   tailscale serve --bg 5180
   ```

3. On the phone, open the `https://<laptop-name>.<tailnet>.ts.net` address that the
   command prints. Add it to the home screen for an app-like icon.

To stop sharing: `tailscale serve --https=443 off` (or `tailscale serve reset`).

**Never use `tailscale funnel`** for this: Funnel publishes the board to the whole
internet, and Atlas has no login.

The laptop has to be awake with Atlas running. GoPro videos play straight
from GoPro; local videos stream from the laptop, so display copies help a lot.

## Tests

```
node test/run.mjs
```

This starts the server on a temporary folder of generated test files (it never
touches your data) and checks the API, security guards, uploads and saving. With a
GoPro share link it also checks the live GoPro integration:

```
GOPRO_TEST_LINK=https://gopro.com/v/… node test/run.mjs          # macOS/Linux
$env:GOPRO_TEST_LINK="https://gopro.com/v/…"; node test/run.mjs  # PowerShell
```

## Troubleshooting

- **A video shows "cannot play"**: the original is probably 4K HEVC. Add a 1080p
  H.264 copy with the same name to `compressed/`, or run `prepare --apply` with
  ffmpeg installed (it writes copies to `.atlas/display/`), or use *Open original*.
- **Port 5180 is busy**: another Atlas is running, or use `--port 5181`
  (and `tailscale serve --bg 5181`).
- **Photos show placeholders**: the file was moved or renamed since it was pinned;
  move it back, or remove the card and add it again from the Library.
