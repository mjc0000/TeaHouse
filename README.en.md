[中文](./README.md) | **English**

<img src="teahouse/web/logo.svg" width="96" alt="teahouse, a cup of steaming tea" />

# teahouse

Local single-user AI roleplay frontend: **character cards**, **world books**, **prompt stack**,
plus a Windows desktop shell.

SillyTavern is the noisy grand tavern; teahouse is the quiet teahouse on the corner — sit down
and take your time. It is **fully compatible with SillyTavern world book files** (any JSON world
book you find online works here, stored byte-for-byte and written back losslessly). Every block of
the prompt stack can be toggled, counted and inspected, and the exact request can be exported:
what you see is what the model gets.

- Character / world book / chat panels, streaming output, swipe variants, per-message editing,
  retry or fork from any message
- World book hit explanations (which entry hit, which key, why something did not hit),
  request preview, token breakdown
- Group chats (5 speaker modes + per-member endpoints), long-term memory, vector retrieval,
  model-picked entries, agent file reading
- Sprite board, voice readout (free local / online), translation, Chinese/English UI,
  6 accents × light/dark themes
- Zero runtime dependencies: runs directly on Node, no build step; all data is plain text
  files under `data/`

```
teahouse-suite/
  teahouse/            The web app itself (src/ + web/ is the single source of truth)
  teahouse-desktop/    Tauri v2 desktop shell (frameless window + bundled server)
```

## Quick start

### Prerequisites

| | Windows | Linux | macOS |
|---|---|---|---|
| Git | [git-scm.com](https://git-scm.com) | Ships with most distros or via package manager | Ships with Xcode CLT |
| Node ≥ 23 | [nodejs.org](https://nodejs.org) | Same | Same |
| Desktop additionally needs | Rust ([rustup.rs](https://rustup.rs), pick MSVC when asked) + WebView2 (ships with Win10/11) | Rust + [Tauri system dependencies](https://tauri.app/start/prerequisites/) (mostly webkit2gtk) | Rust + Xcode CLT |

```powershell
node --version   # v23 or newer
cargo --version  # only needed for the desktop shell
```

### 1. Web app (same three commands on all systems)

Windows (PowerShell):

```powershell
git clone https://github.com/<你>/<仓库>.git
cd teahouse-suite\teahouse
npm start
```

Linux / macOS (bash):

```bash
git clone https://github.com/<你>/<仓库>.git
cd teahouse-suite/teahouse
npm start
```

Open http://127.0.0.1:8787, click Settings (top right), fill in the endpoint URL, API key and
model name, save, and start chatting.
Example with DeepSeek: `https://api.deepseek.com/v1` + `deepseek-chat`; for local Ollama /
LM Studio just fill in the local address and leave the key empty.

### 2. Desktop app (Windows)

Easiest: download `teahouse_*_x64-setup.exe` from [Releases](../../releases) and install it.

Run the debug build from source:

```powershell
cd teahouse-suite\teahouse-desktop\src-tauri
cargo run
```

The shell automatically: finds Node → starts `teahouse/src/server.ts` on a free port →
waits for `/api/health` → opens the frameless window.
For everyday frontend work, run `npm start` first, then set
`$env:TEAHOUSE_URL = "http://127.0.0.1:8787"` before `cargo run`, so the shell only opens
a window and a page refresh picks up frontend changes.

Same for Linux / macOS from source
(`cd teahouse-suite/teahouse-desktop/src-tauri && cargo run`), plus the system dependencies
in the table above. Note: there is no `%APPDATA%` outside Windows, so set a data directory
before launching, otherwise data lands in the system temp directory:

```bash
export TEAHOUSE_DATA="$HOME/.teahouse/data"
cargo run
```

### 3. Build the installer (Windows)

```powershell
# 1. Copy teahouse/src and teahouse/web into teahouse-desktop/src-tauri/resources/app/
# 2. Place a Node 23.6+ node.exe into teahouse-desktop/src-tauri/resources/runtime/
#    (cargo install tauri-cli --version "^2" is a one-time setup)
cd teahouse-suite\teahouse-desktop\src-tauri
cargo tauri build --bundles nsis
```

The bundle lands in `target\release\bundle\nsis\`. Installers ship via GitHub Releases,
never through git.

## Where is the data

| | Web app (`npm start`) | Desktop app |
|---|---|---|
| Windows | `teahouse\data\` (inside the checkout) | `%APPDATA%\teahouse\data\` |
| Linux / macOS | `teahouse/data/` (inside the checkout) | `$TEAHOUSE_DATA` (system temp dir if unset — **always set it**) |

`data/` holds `config.json` (contains API keys — **never commit it**) + `characters/` +
`worlds/` (imported byte-for-byte) + `chats/`.
All plain text, back it up directly. Run tests: web app with `cd teahouse && npm test`,
shell with `cargo test`.

## Compatibility and thanks

- Six world book sources (SillyTavern native / standalone CharacterBook / card-embedded /
  Agnai / Risu / NovelAI) and the scanning semantics follow upstream; chat logs, quick replies
  and context templates convert both ways with SillyTavern. SillyTavern (AGPL-3.0) and TavernAI
  are independent projects — only their file formats are supported here.
