[中文](./README.md) | **English**

# teahouse-desktop

The Windows desktop shell for `teahouse`: a Tauri v2 window pointed at **the app's own
local HTTP server**. The frontend and backend are the ones in the `teahouse` checkout,
untouched — the shell just finds a Node runtime, starts `src/server.ts` on a free port,
waits for `/api/health`, and opens the window at that address.

Data lives in `%APPDATA%\teahouse\` and survives installs and updates.

## Requirements

- **Rust** (with the MSVC toolchain) — the installer asks; this machine uses the VS 2022 VC tools.
- **WebView2 Runtime** — ships with Win10/11.
- **Node ≥ 23.6** — `teahouse`'s `src/server.ts` runs TypeScript natively on Node.

No Tauri CLI is needed for development, `cargo run` is enough; only packaging needs it:
`cargo install tauri-cli --version "^2"`.

## Development

```powershell
# Mode 1: the shell starts the server itself (runs the sibling teahouse checkout,
# or the directory named by TEAHOUSE_APP)
cd teahouse-desktop\src-tauri
cargo run

# Mode 2 (recommended daily): npm start first, then the shell only opens a window
cd ..\teahouse
npm start
cd ..\teahouse-desktop\src-tauri
$env:TEAHOUSE_URL = "http://127.0.0.1:8787"
cargo run
```

In mode 2, frontend changes only need a refresh — same as browser development.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `TEAHOUSE_URL` | Open this address directly, never spawn a server | empty |
| `TEAHOUSE_APP` | App source directory to run (with `src/`, `web/`) | `%APPDATA%\teahouse\app`; seeded or sibling checkout if missing |
| `TEAHOUSE_NODE` | node executable | `resources\runtime\node.exe`, falls back to `node` on PATH |
| `TEAHOUSE_DATA` | Data directory | `%APPDATA%\teahouse\data` |

The shell picks a free port on `127.0.0.1`, never fighting the dev server's 8787.

## Title bar and menu

The window is **frameless** (`decorations: false`) — no system title bar or menu bar; the shell
draws the title bar into the app's own `.topbar` with a script injected into the page
(`src-tauri/scripts/titlebar.js`):

- **Right side** has only the three window controls: minimize / maximize-restore / close.
- **Left side** has a **☰**: open data directory / open program directory / open log /
  restart server / check for updates… / confirm-before-quit (toggle) / quit.
- Drag the window by empty topbar space, **double-click to maximize/restore**.

Window edges and corners still resize natively (the shell answers `WM_NCHITTEST` with
`HTLEFT/HTRIGHT/HTTOP/…` in testing), no custom hot zones needed.

These actions go through the shell's own commands (`shell_control` / `shell_action` /
`shell_state`), authorized via `capabilities/default.json` only for the local origin
`http://127.0.0.1:*`.

## Zoom

- **Ctrl + mouse wheel**, **Ctrl + `+`**, **Ctrl + `-`** adjust the UI zoom, **Ctrl + `0`** resets.
- Steps of 10% from 50% to 200%, stored as `zoom` in `%APPDATA%\teahouse\shell.json`,
  kept next launch.
- Goes through the shell command `shell_zoom` (same local-origin authorization). In a browser
  these keys are the browser's native page zoom — no shell involved.

## Self-update

The shell can download a new `src/` + `web/`, verify it, stage it, and swap it in on restart —
**no repackaging needed**.

1. Zip the sources with **`src/` and `web/` at the zip root**:

   ```
   teahouse-app-0.2.0.zip
     src/...
     web/...
   ```

2. Publish a manifest JSON (a changed `version` triggers an update; `sha256` is optional,
   lowercase hex):

   ```json
   {
     "version": "0.2.0",
     "url": "https://example.com/teahouse-app-0.2.0.zip",
     "sha256": "……"
   }
   ```

3. Point the shell at the manifest: environment variable `TEAHOUSE_UPDATE_URL`, or `updateUrl`
   in `%APPDATA%\teahouse\shell.json`.
4. Menu **Check for updates…** → downloads and extracts to `%APPDATA%\teahouse\update\staged`
   (zip-slip is rejected, a failed checksum aborts) → a dialog says "downloaded vX, takes effect
   after restart" with an **immediate restart** option.
5. On next launch, the shell atomically swaps `update\staged` into `app\` (rolls back to
   `app.bak` on failure) and records `appVersion` in `shell.json`.

`shell.json` fields: `updateUrl`, `confirmQuit`, `appVersion`.

## Packaging and updates (manual)

1. Prepare the runtime and the baseline sources:

   ```
   src-tauri\resources\runtime\node.exe      ← a Node ≥ 23.6 node.exe
   src-tauri\resources\app\src\...           ← copy src/ from the teahouse checkout
   src-tauri\resources\app\web\...           ← copy web/ from the teahouse checkout
   ```

2. Generate icons (placeholders for now, replace with your own later):
   `node scripts/make-icons.mjs`, or `cargo tauri icon your.png` for the whole set at once.
   The icon source of record is `src-tauri/icons/teahouse.svg`; `make-icons.mjs` rasterizes
   the same steaming teacup with zero dependencies.
3. Build the installer: `cargo install tauri-cli --version "^2"`, then
   `cargo tauri build --bundles nsis` → the installer lands in `target\release\bundle\nsis\`.
   - **No console** (official): `cargo tauri build --bundles nsis`
   - **With a terminal window** (troubleshooting): `cargo tauri build --bundles nsis --features console`
     — same release build, only the PE subsystem stays console, so there is an extra terminal window.
   - Both products share the name (`teahouse_<version>_x64-setup.exe`), so save each build
     aside instead of overwriting.
4. Manual updates work too: just overwrite `src/` and `web/` under `%APPDATA%\teahouse\app`
   and reopen the app.

## Tests

The shell's own unit tests: `cd src-tauri; cargo test` (covers zip extraction and the
staged update swap-in/record).

## Directories

```
%APPDATA%\teahouse\
  app\           ← the actually running sources (seeded from the installer's resources/app on first run, replaced on update)
  data\          ← config.json / characters / worlds / chats (the user's real data)
  logs\server.log← server stdout+stderr
  update\        ← download staging (staged + version)
  shell.json     ← updateUrl / confirmQuit / appVersion
```

## When startup fails

If the shell doesn't see `/api/health` within 25 seconds it shows a local fallback page and
points you at `%APPDATA%\teahouse\logs\server.log`. The usual causes are a wrong node.exe
version or an incomplete `app\`.
