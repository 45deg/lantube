> ⚠️ **Disclaimer**
>
> - 🎛️ This is a hobby project that was “vibe-coded” for personal use.
> - 🔒 Security hardening and careful threat modeling may be incomplete.
> - 🧪 Behavior, stability, and edge-case handling may be insufficient.
> - 🌐 Please avoid exposing it to untrusted networks, and use it at your own risk.

## Overview

LanTube is a local video browser and streamer built with Next.js. It scans a target directory, builds a lightweight SQLite index, generates thumbnails, and serves videos with HTTP range streaming for smooth playback.

## Requirements

- Node.js 20+ (for `node:sqlite`)
- ffmpeg / ffprobe available in your PATH

## Setup

Install dependencies:

```bash
pnpm install
```

Create `.env.local` in the project root:

```dotenv
# Absolute path to your video directory
TARGET_DIRECTORY=/Users/you/Videos

# Enable smart thumbnail selection (optional)
SMART_THUMB=1
```

Notes:

- `TARGET_DIRECTORY` must be an absolute path.
- When `SMART_THUMB=1`, the app samples 5 timestamps and picks the largest thumbnail file.
- When `SMART_THUMB` is unset or `0`, it uses the 1-second frame only.

## Development

Start the dev server:

```bash
pnpm dev
```

Expose the dev server to your LAN:

```bash
pnpm dev:host
```

Open http://localhost:3000

## Thumbnail Batch Tool

Generate or refresh thumbnails and the SQLite index:

```bash
pnpm thumbs:build
```

Force rebuild (ignore cached thumbnails):

```bash
pnpm thumbs:build -- --rebuild
```

## Troubleshooting

- If thumbnails look outdated, run the batch tool with `--rebuild`.
- If videos fail to stream, confirm ffmpeg/ffprobe are installed and `TARGET_DIRECTORY` is correct.

## License

MIT
