# TachyonStream

Self-hosted watch-together video streaming with Express and Socket.IO. Includes synchronized playback, nested folders, thumbnails, and adaptive HLS quality.

[English](README.md) · [ภาษาไทย](docs/README_TH.md) · [日本語](docs/README_JA.md) · [MIT License](LICENSE)

## Features

- Synchronize playback, pause, seeking, and video selection within a room.
- Choose a room using the `channel_id` URL parameter.
- Create nested folders, move videos, and delete videos or folders.
- Play the next episode in the current folder with Auto-Next.
- Upload videos in 5 MB chunks, with retries for failed chunks during the current upload.
- Generate thumbnails and read video duration with FFmpeg/FFprobe after upload.
- Use a video inside a folder or its descendants as the folder cover.
- Open card actions using the three-dot button at the bottom right.
- Choose Auto, Original, or an available HLS resolution independently on each device.
- Create Discord Activity invitation links through the optional `/watch` bot command.

Uploads do not resume after the page is refreshed or closed. Browser playback depends on the container and codec; accepting an upload does not guarantee direct playback on every browser.

## Access model

There are no user accounts or administrator passwords. **Anyone who can access the website can watch, upload, move, and delete library content.** Anyone who joins a room can control its playback. Deleting a folder also deletes its contents.

Existing request protections include:

- Library mutations require an active player session.
- Origin and Fetch Metadata checks reject cross-site HTTP mutations and Socket.IO connections.
- Uploaded videos and temporary chunks are not exposed through static serving, including encoded and case-varied URL attempts.
- `/api/stream` and HLS playlists/segments validate the playback session and Referer.

These checks do not authenticate the server owner or verify Discord voice-channel membership. Room names are not access credentials. Browser code and request URLs remain visible in DevTools.

## Requirements

- Node.js and npm. Development regression checks have used Node.js 24.
- FFmpeg and FFprobe in `PATH`, or explicit executable paths in `.env`.
- FFmpeg with `libx264` and AAC support for adaptive quality.
- `cloudflared` when using Cloudflare Tunnel.
- A Discord Application and bot token when using the bot or Activity integration.

Uploads can still be accepted without FFmpeg/FFprobe, but server thumbnails and adaptive conversion will fail. Browser thumbnail capture is a fallback only when the browser can decode the original video.

## Quick start

```bash
git clone https://github.com/Minta1234/TachyonStream.git
cd TachyonStream
npm ci
```

Create a local environment file.

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Linux/macOS:

```bash
cp .env.example .env
```

Example configuration uses a placeholder hostname:

```env
PORT=9815
STREAM_DOMAIN=stream.example.com
TUNNEL_TOKEN=
Discord_token=
```

- `PORT`: web server port; defaults to `9815`.
- `STREAM_DOMAIN`: allowed playback hostname, without a scheme or path. Leave empty for localhost-only use. `ALLOWED_DOMAIN` is a fallback when `STREAM_DOMAIN` is unset; `domain_authorized` is not supported.
- `TUNNEL_TOKEN`: optional Cloudflare Tunnel token used by the Windows launcher.
- `Discord_token`: optional bot token. `DISCORD_TOKEN` is also accepted; `Discord_token` takes precedence.
- `FFMPEG_PATH` / `FFPROBE_PATH`: full executable paths when the server process cannot find the tools in `PATH`.
- `DATA_DIR`: optional server data directory; defaults to `public`. Server uploads, chunks, thumbnails, and adaptive output use this directory.

Restart the affected processes after editing `.env`. Setting `STREAM_DOMAIN` does not create DNS records or configure a Tunnel.

Start the web server:

```bash
npm start
```

Open [localhost:9815](http://localhost:9815). Stop the foreground process with `Ctrl+C`. Run the optional bot in another terminal:

```bash
npm run bot
```

### Windows background launcher

```powershell
.\start.bat
```

The launcher reads `.env`, invokes `stop.ps1`, and starts the web server and bot in hidden windows. It also starts `cloudflared` when `TUNNEL_TOKEN` is set. Required executables must be available to the launcher.

Stop the background processes:

```powershell
.\stop.bat
```

The current stop script checks saved process IDs, project processes, and processes listening on **port 9815**. An unrelated application on that port may also be stopped. The port lookup does not follow a custom `PORT` setting.

Logs are stored in `server.log` / `server.error.log`, `bot.log` / `bot.error.log`, and `tunnel.log` / `tunnel.error.log`. The launcher records process IDs in `.processes.json`.

## Domain and Tunnel setup

1. Configure a Tunnel hostname to forward to `http://localhost:9815`, or the configured port.
2. Put the same hostname in `STREAM_DOMAIN` in the server's local `.env`.
3. Set `TUNNEL_TOKEN` if the Windows launcher should start the Tunnel.
4. Restart the affected processes. Check `tunnel.error.log` if the hostname is unreachable.

`npm start` starts only the web server; it does not start a Tunnel. Keep the real hostname and tokens in the server's `.env`, rather than frontend code or documentation.

## Library and rooms

Select a movie in Library, or enter a folder to choose an episode. Upload uses the currently open folder as its initial destination; another destination can be selected. After upload, the server assembles the file and attempts thumbnail generation before playback starts.

Use the three-dot card button for management actions. It supports clicking or Tab followed by Enter; Tab moves through its actions, and Esc closes the menu and restores focus. Preview media does not intercept card-button clicks. Hidden views do not receive pointer input or keyboard focus. Navigation and search wrap on smaller screens. Interface icons use SVG; native selection options use plain text.

Example room:

```text
http://localhost:9815/?channel_id=movie-night
```

Pages using the same `channel_id` share playback state. Omitting it uses `default-voice-room`.

## Keyboard shortcuts

Select a video before using playback shortcuts.

- **Space / K:** play or pause.
- **Left / J:** seek back 10 seconds.
- **Right / L:** seek forward 10 seconds.
- **Up / Down:** adjust volume by 5% and unmute.
- **M:** mute or unmute.
- **F:** toggle fullscreen.
- **Esc:** close a dialog, or return from Cinema/Upload to Library when an input or selection control is not focused. In fullscreen, the browser handles exiting fullscreen first.
- **?:** show shortcut help. The navigation bar also has a help button.

Letter shortcuts use physical English-keyboard positions. Playback shortcuts do not interfere with typing, focused controls, Upload, or open dialogs. Ctrl/Alt/Command combinations are left to the browser. Playback and seeking synchronize with the room; volume, fullscreen, and quality are local to each viewer.

## Adaptive video quality

The **Quality** menu offers:

- **Auto:** HLS adapts to bandwidth and buffer conditions. With hls.js, automatic quality is also capped to the player size.
- **360p / 480p / 720p / 1080p:** select a fixed available resolution. Outputs do not exceed the source height. Sources below 360p use their height rounded down to an even number.
- **Original:** play the original file directly, including while adaptive versions are being prepared.

Opening a video queues background conversion on first use. While `Preparing quality · Original` is displayed, the original remains available if its codec is supported by the browser. Adaptive quality becomes available **after every configured rendition has finished**. Switching between Original and HLS preserves playback time and play/pause state, but may require a brief reload. Manual HLS changes take effect at a suitable subsequent segment.

The converter creates H.264 video with AAC audio when an audio track exists, without modifying the original. Compatible browsers use locally served hls.js. Safari can fall back to native HLS; native Auto is controlled by the browser.

Conversion runs one video at a time, with two encoder threads and up to four waiting jobs. Long videos can take substantial time to prepare. Jobs continue after the viewing page is closed. Existing output is reused while the original file's path, size, and modification time remain unchanged.

Generated output is stored in `DATA_DIR/adaptive/`, defaulting to `public/adaptive/`, and is excluded from Git. Conversion estimates required space before starting, with a 512 MB free-space allowance. Old cache entries are not deleted automatically. Moving or deleting the original makes its old adaptive output unavailable; a moved video needs preparation at its new path. Monitor disk usage periodically.

Playlists and segments require a valid session and Referer and are not exposed as static files or shared CDN cache entries. If conversion fails, disk space is insufficient, or HLS is unsupported, Original remains available subject to browser codec support. Auto cannot guarantee uninterrupted playback on a connection slower than the lowest rendition.

### Only Auto and Original appear

Check the status beside Quality. Wait while conversion is queued or processing. If FFmpeg/FFprobe cannot be found, set full `FFMPEG_PATH` and `FFPROBE_PATH` values in `.env`, restart the web server, refresh the page, and use **Retry quality**. Disk-space and conversion failures display a reason without exposing private file paths.

## Streaming performance

- Open-ended byte ranges stream continuously with Node backpressure instead of forcing another HTTP request every 3 MB. Suffix ranges support reading metadata at the end of MP4 files; HEAD does not read the video body.
- File metadata is read asynchronously to reduce event-loop blocking.
- Hover previews start after 700 ms and are suppressed during main playback, in hidden tabs, or when the browser reports Data Saver or 2G.
- Posters use lazy loading and asynchronous decoding. Browser thumbnail fallback runs one job at a time and pauses its queue during playback or in hidden tabs.
- Overlapping library refreshes are serialized. Unchanged data does not rebuild cards or dropdowns; old observers and queued card tasks are cleared during rebuilding.

Session validation and restrictions on shared video caching remain enabled. Server upload bandwidth must support the combined bitrate of viewers. Cross-country performance still needs measurement from the actual viewing location.

## Discord Activity and bot

Configure the Discord Application's Activity and URL Mapping to use the server's HTTPS hostname. The bot creates an invitation to the Activity belonging to that same Application.

- Invite the bot with permission to view channels, send messages, and create invitations.
- Set `Discord_token` or `DISCORD_TOKEN` in `.env`.
- Register the `/watch` slash command separately. `bot.js` handles the command but does not automatically register it.
- Run `npm run bot`, join a voice channel, and use `/watch` after registration.

The response contains an invitation link; videos are not uploaded to Discord. See the illustrated [Thai guide](docs/README_TH.md) or [Japanese guide](docs/README_JA.md). Discord and proxy integration require validation in the deployed environment.

## Thumbnails

New uploads attempt server-side thumbnail generation automatically. Generate missing thumbnails for existing videos:

```bash
npm run thumbnails
```

Regenerate existing thumbnails:

```bash
npm run thumbnails -- --refresh
```

This script uses `public/uploads` and `public/thumbnails`, rather than the server's custom `DATA_DIR`. Images and `metadata.json` are generated without modifying videos. Moving videos through the UI preserves thumbnail and duration metadata at the new path.

## Keep private configuration out of Git

`.gitignore` excludes `.env`, logs, backups, launcher state, and generated video, thumbnail, chunk, and adaptive data. `.env.example` is tracked and must contain only placeholders or empty values.

Before committing:

```bash
git status --short
git check-ignore .env
git ls-files .env
```

The last command should produce no output. Review diffs and documentation screenshots for private hostnames, tokens, and server addresses. Ignoring a file does not remove an earlier committed copy; previously exposed secrets require separate history cleanup and token rotation.

## Tests

```bash
npm test
```

Regression checks use an isolated server and temporary data. They cover session/origin validation, static-path blocking, upload assembly, byte ranges and HEAD, thumbnails, folder labels, file moves, keyboard safeguards, inactive views, preview restrictions, library refresh coalescing, real HLS conversion, protected playlists/segments, quality selection, time preservation, and conversion retry after a missing executable. FFmpeg/FFprobe are required for synthetic fixtures.

These checks do not prove end-to-end Discord Activity, Cloudflare Tunnel, real-device Safari/mobile behavior, or multi-viewer performance over the deployed domain.

## Troubleshooting

- **Playback returns `403`:** check `STREAM_DOMAIN`, restart the server, and refresh the page to obtain a new session.
- **Upload returns `401`:** wait for the player to connect and show Synced, then retry. No administrator password is required.
- **Library mutation returns `403`:** check that the page and API share an origin, including the Host forwarded by the reverse proxy.
- **Missing thumbnails or quality options:** check FFmpeg/FFprobe paths, available disk space, the quality status, and server error logs.
- **Missing `/watch`:** check slash-command registration and the bot's server membership.
- **Names contain `%20`:** refresh with `Ctrl+F5` to load current frontend assets.
- **`XHR finished loading` / `Fetch finished loading`:** these messages alone are informational. Inspect the response status and body for an actual failure.

## Project layout

```text
server.js                       HTTP API, streaming, and Socket.IO
bot.js                          Discord Activity invitation bot
public/app.js                   Player and library interface
public/quality-player.js        Auto/manual HLS playback
public/style.css                Interface styles
public/uploads/                 Original videos
public/temp_chunks/             In-progress upload chunks
public/thumbnails/              Posters and duration metadata
public/adaptive/                Generated HLS output
lib/thumbnails.js               FFmpeg thumbnail generation
lib/http-range.js               HTTP byte-range parsing
lib/adaptive-video.js           Adaptive conversion queue and storage
scripts/generate-thumbnails.mjs Batch thumbnail command
tests/regression.mjs            Regression checks
launch.ps1 / start.bat           Windows background startup
stop.ps1 / stop.bat              Windows shutdown
```

## License

[MIT License](LICENSE)
