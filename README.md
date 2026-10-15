# corkboard

A local-first cork board for memories. Pin photos, videos, notes, chat messages,
flight tickets, screenshots and links onto an infinite board. Media is read in
place from a folder on disk and from GoPro share links, with no login and no
copying.

> **Status: in development.** [SPEC.md](SPEC.md) is the authoritative spec.

## Run

```
node bin/corkboard.js serve "C:\path\to\your\photos"
```

Then open http://localhost:5180. Requires Node ≥ 20 and nothing else. The
optional tools below are used when present:

| Tool | Used for | Install (Windows) |
|---|---|---|
| ffmpeg / ffprobe | video thumbnails | `winget install Gyan.FFmpeg` |
| ImageMagick | photo thumbnails, PDF previews | `winget install ImageMagick.ImageMagick` |
| ExifTool | capture dates | `winget install OliverBetz.ExifTool` |

## Where your data lives

Everything the app writes goes into `<your folder>/.corkboard/`: boards, backups,
uploads, the GoPro link cache and thumbnails. Your photos and videos are never
modified. To back up, copy the whole folder. Deleted boards go to
`.corkboard/trash/`, and every save keeps the previous version in
`.corkboard/backups/`.
