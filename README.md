<div align="center">

# ⚡ TachyonStream

**Self-hosted Real-Time Synchronized Video Streaming Platform & Discord Watch Together Activity**

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4.x-010101?style=flat-square&logo=socket.io&logoColor=white)](https://socket.io/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)

[English](README.md) • [日本語](docs/README_JA.md) • [ภาษาไทย](docs/README_TH.md)

</div>

---

## 📖 Overview

**TachyonStream** is a lightweight, responsive, and secure self-hosted media streaming server designed for shared watching experiences. It enables seamless real-time playback synchronization across rooms, chunked video uploads with resumption, automatic thumbnail generation, dynamic hierarchical folder organization, and direct integration as a **Discord Watch Together Voice Activity**.

---

## ✨ Key Features

- 🔄 **Real-Time Synchronized Playback:** Instant sync for play, pause, seek, playback rate, and room video switching powered by Socket.IO rooms.
- 📁 **Smart Folder & Library Management:** Hierarchical folder navigation, nested directory support, video relocation, and automatic cascading folder covers.
- 🖼️ **Automated Video Thumbnails:** Server-side FFmpeg thumbnail generation on upload with duration extraction, batch generator script, and client-side browser snapshot fallback.
- 🚀 **Chunked Resumable Uploads:** Fast, reliable uploads for large video files with slice assembly, cleanup, and integrity verification.
- 🤖 **Discord Activity & Bot Integration:** Includes a Discord bot using Discord's Embedded App SDK to launch Watch Together sessions directly inside Voice Channels via `/watch`.
- 🛡️ **Zero-Trust Security Architecture:**
  - **No Plain Static Serving:** Raw access to `public/uploads/` and `temp_chunks/` is strictly blocked (even for case-manipulated or URL-encoded paths). Media is securely served through `/api/stream` with HTTP Range and session validation.
  - **Session Verification:** Requires active player session tokens (`X-Playback-Session`) for library modifications and streaming requests.
  - **Origin & Metadata Protection:** Validates Origin and `Sec-Fetch-*` headers to reject unauthorized cross-origin API calls and cross-site WebSocket hijackings.

---

## 🛠️ Prerequisites

- **[Node.js](https://nodejs.org/)** (v18.0.0 or higher recommended)
- **[FFmpeg](https://ffmpeg.org/)** and **FFprobe** installed and added to your system `PATH` (optional for playback, required for automated thumbnail extraction).
  - *Alternatively, set custom paths via `FFMPEG_PATH` and `FFPROBE_PATH` environment variables.*

---

## 🚀 Quick Start

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/Minta1234/TachyonStream.git
cd TachyonStream
npm install
```

### 2. Configure Environment

Copy the sample environment file:

```bash
cp .env.example .env
```

Available environment variables:

| Variable | Description | Default |
|---|---|---|
| `PORT` | Web server listening port | `9815` |
| `TUNNEL_TOKEN` | Optional Cloudflare Tunnel token for public access | *(unset)* |
| `DISCORD_TOKEN` | Bot token for the Discord Watch Together launcher | *(unset)* |
| `DISCORD_CLIENT_ID` | Discord Application Client ID | *(unset)* |
| `FFMPEG_PATH` | Path to `ffmpeg` binary | System PATH |
| `FFPROBE_PATH` | Path to `ffprobe` binary | System PATH |

### 3. Run the Server

#### Development / Direct Run
```bash
npm start
```
The web dashboard will be accessible at: `http://localhost:9815`

#### Background Service (Windows)
To start both the streaming server and background tasks silently without leaving a terminal window open:

```cmd
start.bat
```

To stop all managed background processes:

```cmd
stop.bat
```

*(Process IDs are tracked in `.processes.json`, ensuring unrelated Node.js instances are never killed).*

---

## 🌐 Cloudflare Tunnel Setup (Public Access & HTTPS)

Discord Activities run inside an iframe hosted on Discord's CDN (`*.discordsays.com`), requiring a secure public **HTTPS** endpoint. Cloudflare Tunnel exposes your local TachyonStream server to the internet without port forwarding or exposing your home IP.

### Step 1: Install `cloudflared`
- **Windows:**
  ```powershell
  winget install --id Cloudflare.cloudflared
  ```
  *(Or download `cloudflared.exe` from [Cloudflare Releases](https://github.com/cloudflare/cloudflared/releases) and place it in your system PATH).*
- **Linux:**
  ```bash
  sudo apt install cloudflared
  ```

### Step 2: Create a Tunnel in Cloudflare Zero Trust
1. Navigate to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/) > **Networks** > **Tunnels**.
2. Click **Create a Tunnel** > Select **Cloudflare Tunnel (cloudflared)**.
3. Enter a tunnel name (e.g., `tachyonstream`) and save.
4. Copy your **Tunnel Token** (the base64 string starting with `ey...`).

### Step 3: Configure Public Hostname
In the tunnel configuration:
1. Go to the **Public Hostnames** tab and click **Add a public hostname**.
2. Fill in:
   - **Subdomain:** e.g., `stream`
   - **Domain:** e.g., `yourdomain.com` (full URL: `stream.yourdomain.com`)
   - **Service Type:** `HTTP`
   - **URL:** `localhost:9815`
3. Save the hostname.

### Step 4: Run with TachyonStream
Set the `TUNNEL_TOKEN` environment variable in your launcher:
```powershell
$env:TUNNEL_TOKEN="your_tunnel_token_here"
```
Or start via `start.bat` — `launch.ps1` automatically detects `TUNNEL_TOKEN`, spawns `cloudflared tunnel run` in the background, and outputs logs to `tunnel.log`.

---

## 🎮 Discord Developer Portal & Activity Setup

To configure TachyonStream as an official Discord Voice Activity:

### 1. Application Creation
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** (e.g., `Tachyon Stream`).

### 2. Activity Settings (`Activities` > `Settings`)
Configure the Activity surface:
- **Enable Activities:** Toggle **ON** (allows users to launch the activity).
- **Age Gate:** **OFF** (toggle ON only if serving 18+ content).
- **Proxy Authentication:** **OFF**.
- **Maximum Participants:** Set to `5` (or desired capacity).
- **Default Orientation:** Set both Phone and Tablet to **Unlocked**.
- **Supported Platforms:** Check ✅ **Web**, ✅ **iOS**, and ✅ **Android**.

<p align="center">
  <img src="docs/assets/imgs/media_1792852638891.png" alt="Discord Activity Settings" width="850"/>
</p>

### 3. URL Mappings (`Activities` > `URL Mappings`)
Map Discord's proxy to your Cloudflare Tunnel hostname:
- **Root Mapping:**
  - **Prefix:** `/`
  - **Target:** `stream.yourdomain.com` *(your Cloudflare Tunnel hostname without `https://`)*
- *How it works:* Discord proxies iframe connections from `https://<app_id>.discordsays.com/` directly to your tunnel target over HTTPS.

<p align="center">
  <img src="docs/assets/imgs/media_1792852738042.png" alt="Discord Activity URL Mappings" width="850"/>
</p>

### 4. Bot Setup & Voice Permissions
1. Navigate to **Bot** > Click **Reset Token** and copy the token.
2. Put the token in your `.env` file:
   ```env
   Discord_token=your_bot_token_here
   ```
3. Go to **OAuth2** > **URL Generator**:
   - **Scopes:** `bot`, `applications.commands`
   - **Bot Permissions:** `Create Instant Invite`, `Send Messages`, `View Channels`
4. Use the generated invite URL to add the bot to your Discord server.

---

## 🤖 Discord Watch Together Bot

Once configured, run the companion Discord bot to host sessions directly within Discord Voice Channels:

1. Start the bot:
   ```bash
   npm run bot
   ```
2. Join any Discord Voice Channel.
3. Type:
   ```text
   /watch
   ```
4. The bot will create an interactive button inviting channel members to launch and join the synchronized streaming session.

---

## 🎬 Generating Thumbnails

To process and extract thumbnail cards for your entire existing video library in one batch:

```bash
npm run thumbnails
```

*This scans the library non-destructively, generates `.jpg` covers in `public/thumbnails/`, and skips videos that already have valid thumbnails.*

---

## 🧪 Testing

TachyonStream includes an automated regression test suite covering security gates, upload slice integrity, and session handling:

```bash
npm test
```

Tests run in isolated temporary workspaces without modifying your live video repository.

---

## 📂 Project Structure

```text
TachyonStream/
├── docs/                   # Multilingual documentation (Japanese, Thai)
│   ├── README_JA.md
│   └── README_TH.md
├── lib/
│   └── thumbnails.js       # FFmpeg thumbnail generation helper
├── public/                 # Frontend assets (HTML, CSS, Player JS, Treeselect)
│   ├── app.js              # Client application & room synchronization logic
│   ├── thumbnails/         # Cached video cover images (.jpg)
│   └── uploads/            # Video library storage
├── scripts/
│   └── generate-thumbnails.mjs # Library batch thumbnail scanner
├── tests/
│   └── regression.mjs      # Security & regression test suite
├── bot.js                  # Discord Watch Together Bot
├── launch.ps1              # Process supervisor script
├── server.js               # Express & Socket.IO core backend
├── start.bat               # Windows background launcher
└── stop.bat                # Windows background process terminator
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
