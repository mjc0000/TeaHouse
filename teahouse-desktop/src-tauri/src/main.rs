//! Desktop shell for teahouse: a WebView2 window pointed at the app's own local
//! HTTP server.
//!
//! The frontend and the server are the ones in the `teahouse` checkout, untouched.
//! The shell finds a Node runtime, starts `src/server.ts` on a free port with a
//! per-user data directory, waits for `/api/health`, and opens the window at
//! that URL. A feature update is then a file replacement under
//! `%APPDATA%\teahouse\app` — or, with `TEAHOUSE_UPDATE_URL`, a downloaded zip that
//! is staged and swapped in on the next start.

// A release build is a windowed app (no terminal). `--features console` keeps the
// console subsystem, for a troubleshooting build that shows a terminal window.
#![cfg_attr(
    all(not(debug_assertions), not(feature = "console")),
    windows_subsystem = "windows"
)]

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// The client-side decorations injected into the page (see the file's header).
const TITLEBAR_JS: &str = include_str!("../scripts/titlebar.js");

/// `CREATE_NO_WINDOW`, so spawning Node never flashes a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Page zoom limits and step, for the desktop app's own Ctrl+wheel / Ctrl±.
const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 2.0;
const ZOOM_STEP: f64 = 0.1;

/// `%APPDATA%\teahouse\shell.json`: settings that live in this browser-less shell
/// rather than in the app's own `data/config.json`.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(default)]
struct Settings {
    #[serde(rename = "updateUrl", skip_serializing_if = "Option::is_none")]
    update_url: Option<String>,
    #[serde(rename = "confirmQuit")]
    confirm_quit: bool,
    #[serde(rename = "appVersion", skip_serializing_if = "Option::is_none")]
    app_version: Option<String>,
    /// Page zoom, 1.0 = 100%. Persisted so the reader keeps their size.
    #[serde(rename = "zoom")]
    zoom: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            update_url: None,
            confirm_quit: true,
            app_version: None,
            zoom: 1.0,
        }
    }
}

struct ShellState {
    home: PathBuf,
    app_dir: PathBuf,
    data_dir: PathBuf,
    node: PathBuf,
    child: Mutex<Option<Child>>,
    port: AtomicU16,
    confirm_quit: AtomicBool,
    force_quit: AtomicBool,
    settings: Mutex<Settings>,
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            shell_control,
            shell_action,
            shell_state,
            shell_zoom
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let ask = app
                    .try_state::<ShellState>()
                    .map(|state| {
                        state.confirm_quit.load(Ordering::SeqCst)
                            && !state.force_quit.load(Ordering::SeqCst)
                    })
                    .unwrap_or(false);
                if !ask {
                    return;
                }
                api.prevent_close();
                let window = window.clone();
                app.dialog()
                    .message("退出 teahouse？正在生成的回复会被中断。")
                    .title("teahouse")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom("退出".into(), "取消".into()))
                    .show(move |confirmed| {
                        if !confirmed {
                            return;
                        }
                        if let Some(state) = window.app_handle().try_state::<ShellState>() {
                            state.force_quit.store(true, Ordering::SeqCst);
                        }
                        let _ = window.close();
                    });
            }
        })
        .setup(|app| {
            setup(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the teahouse shell");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            stop_server(app_handle);
        }
    });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let home = teahouse_home();
    fs::create_dir_all(&home)?;
    fs::create_dir_all(home.join("logs"))?;

    let handle = app.handle().clone();
    let mut settings = load_settings(&home);
    if let Some(url) = std::env::var_os("TEAHOUSE_UPDATE_URL") {
        settings.update_url = Some(url.to_string_lossy().to_string());
    }
    let confirm = settings.confirm_quit;

    let resources = resource_roots(app);
    // In `TEAHOUSE_URL` mode the server is the developer's `npm start`, whose data
    // lives in the checkout; nothing is seeded and no server is spawned.
    let dev_url = std::env::var_os("TEAHOUSE_URL").map(|url| url.to_string_lossy().to_string());
    if dev_url.is_none() && std::env::var_os("TEAHOUSE_APP").is_none() {
        if let Some(version) = apply_staged_update(&home) {
            settings.app_version = Some(version);
        }
    }

    let app_dir = resolve_app_dir(&resources, &home, dev_url.is_none());
    let node = resolve_node(&resources);
    let data_dir = std::env::var_os("TEAHOUSE_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if dev_url.is_some() {
                app_dir.join("data")
            } else {
                home.join("data")
            }
        });

    // A spawned server's data directory must exist before Node starts; in
    // `TEAHOUSE_URL` mode the developer's own `data/` is left alone.
    if dev_url.is_none() {
        fs::create_dir_all(&data_dir)?;
    }

    let initial_zoom = settings.zoom;
    app.manage(ShellState {
        home,
        app_dir,
        data_dir,
        node,
        child: Mutex::new(None),
        port: AtomicU16::new(0),
        confirm_quit: AtomicBool::new(confirm),
        force_quit: AtomicBool::new(false),
        settings: Mutex::new(settings),
    });

    // Development shortcut: show an already-running server, never spawn one.
    if let Some(url) = dev_url {
        let parsed = tauri::Url::parse(&url)?;
        open_window(app, WebviewUrl::External(parsed), initial_zoom)?;
        return Ok(());
    }

    let state = app.state::<ShellState>();
    if let Err(error) = spawn_server(state.inner()) {
        open_window(app, WebviewUrl::App("error.html".into()), 1.0)?;
        let _ = handle
            .dialog()
            .message(format!("teahouse 服务端启动失败：{error}"))
            .title("teahouse")
            .kind(MessageDialogKind::Error)
            .show(|_| {});
        return Ok(());
    }

    let port = state.port.load(Ordering::SeqCst);
    let parsed = tauri::Url::parse(&format!("http://127.0.0.1:{port}"))?;
    open_window(app, WebviewUrl::External(parsed), initial_zoom)?;
    Ok(())
}

fn open_window(app: &tauri::App, url: WebviewUrl, zoom: f64) -> tauri::Result<()> {
    // Frameless: the OS draws no title bar or menu bar, and the injected script
    // draws the window controls into the app's own topbar.
    let window = WebviewWindowBuilder::new(app, "main", url)
        .title("teahouse")
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 600.0)
        .decorations(false)
        .shadow(true)
        .initialization_script(TITLEBAR_JS)
        .build()?;
    if (zoom - 1.0).abs() > f64::EPSILON {
        let _ = window.set_zoom(zoom);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands called by the injected title bar
// ---------------------------------------------------------------------------

/// The three window controls plus window dragging. Routed through our own
/// command so the remote page needs no `core:window` permissions.
#[tauri::command]
fn shell_control(window: tauri::Window, action: String) -> Result<(), String> {
    match action.as_str() {
        "minimize" => window.minimize().map_err(describe),
        "toggle-maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize().map_err(describe)
            } else {
                window.maximize().map_err(describe)
            }
        }
        "close" => window.close().map_err(describe),
        "drag" => window.start_dragging().map_err(describe),
        other => Err(format!("unknown window action: {other}")),
    }
}

/// The shell menu items.
#[tauri::command]
fn shell_action(app: AppHandle, action: String) {
    match action.as_str() {
        "open-data" => reveal(&state_path(&app, |state| state.data_dir.clone())),
        "open-app" => reveal(&state_path(&app, |state| state.app_dir.clone())),
        "open-log" => reveal_file(&state_path(&app, |state| state.home.join("logs").join("server.log"))),
        "restart-server" => restart_server(&app),
        "check-update" => check_updates(&app),
        "toggle-confirm" => toggle_confirm(&app),
        "quit" => {
            force_quit(&app);
            app.exit(0);
        }
        _ => {}
    }
}

#[derive(serde::Serialize)]
struct ShellInfo {
    confirm_quit: bool,
    maximized: bool,
    zoom: f64,
}

/// What the title bar needs to draw itself: the confirm toggle, whether the
/// maximize button should show "maximize" or "restore", and the current zoom.
#[tauri::command]
fn shell_state(app: AppHandle, window: tauri::Window) -> ShellInfo {
    ShellInfo {
        confirm_quit: app
            .try_state::<ShellState>()
            .map(|state| state.confirm_quit.load(Ordering::SeqCst))
            .unwrap_or(true),
        maximized: window.is_maximized().unwrap_or(false),
        zoom: app
            .try_state::<ShellState>()
            .and_then(|state| state.settings.lock().ok().map(|settings| settings.zoom))
            .unwrap_or(1.0),
    }
}

fn describe(error: tauri::Error) -> String {
    error.to_string()
}

/// The next zoom factor for one step; clamped and snapped to 0.1 so repeated
/// wheel ticks cannot drift to 0.8999999.
fn zoom_step(current: f64, action: &str) -> Result<f64, String> {
    let next = match action {
        "in" => current + ZOOM_STEP,
        "out" => current - ZOOM_STEP,
        "reset" => 1.0,
        other => return Err(format!("unknown zoom action: {other}")),
    };
    Ok((next.clamp(ZOOM_MIN, ZOOM_MAX) * 10.0).round() / 10.0)
}

/// Ctrl+wheel / Ctrl+= / Ctrl+- on the page, applied to the webview and kept.
#[tauri::command]
fn shell_zoom(window: tauri::WebviewWindow, action: String) -> Result<f64, String> {
    let app = window.app_handle();
    let Some(state) = app.try_state::<ShellState>() else {
        return Err("shell state unavailable".into());
    };
    let current = state
        .settings
        .lock()
        .map(|settings| settings.zoom)
        .unwrap_or(1.0);
    let next = zoom_step(current, &action)?;
    window.set_zoom(next).map_err(describe)?;
    if let Ok(mut settings) = state.settings.lock() {
        settings.zoom = next;
        save_settings(&state.home, &settings);
    };
    Ok(next)
}

fn state_path(app: &AppHandle, pick: impl Fn(&ShellState) -> PathBuf) -> PathBuf {
    match app.try_state::<ShellState>() {
        Some(state) => pick(state.inner()),
        None => PathBuf::new(),
    }
}

fn reveal(path: &Path) {
    if path.as_os_str().is_empty() {
        return;
    }
    #[cfg(windows)]
    {
        let _ = Command::new("explorer").arg(path).spawn();
    }
}

fn reveal_file(path: &Path) {
    if path.as_os_str().is_empty() {
        return;
    }
    #[cfg(windows)]
    {
        let _ = Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn();
    }
}

fn force_quit(app: &AppHandle) {
    if let Some(state) = app.try_state::<ShellState>() {
        state.force_quit.store(true, Ordering::SeqCst);
    }
}

fn toggle_confirm(app: &AppHandle) {
    let Some(state) = app.try_state::<ShellState>() else {
        return;
    };
    let next = !state.confirm_quit.load(Ordering::SeqCst);
    state.confirm_quit.store(next, Ordering::SeqCst);
    if let Ok(mut settings) = state.settings.lock() {
        settings.confirm_quit = next;
        save_settings(&state.home, &settings);
    };
    // The check mark lives in the page's ☰ menu; it re-reads this on open.
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

fn spawn_server(state: &ShellState) -> Result<(), String> {
    let entry = state.app_dir.join("src").join("server.ts");
    if !entry.is_file() {
        return Err(format!("找不到 {}", entry.display()));
    }

    let logs = state.home.join("logs");
    fs::create_dir_all(&logs).map_err(|error| error.to_string())?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join("server.log"))
        .map_err(|error| error.to_string())?;

    let port = free_port();
    let mut command = Command::new(&state.node);
    command
        .arg(&entry)
        .current_dir(&state.app_dir)
        .env("TEAHOUSE_DATA", &state.data_dir)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|error| error.to_string())?))
        .stderr(Stdio::from(log));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 {} 失败：{error}", state.node.display()))?;
    if !wait_for_health(port, Duration::from_secs(25)) {
        let _ = child.kill();
        return Err(format!("25 秒内没有等到 http://127.0.0.1:{port}/api/health"));
    }

    state.port.store(port, Ordering::SeqCst);
    if let Ok(mut guard) = state.child.lock() {
        *guard = Some(child);
    }
    Ok(())
}

fn stop_server(app: &AppHandle) {
    if let Some(state) = app.try_state::<ShellState>() {
        if let Ok(mut guard) = state.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
            }
            *guard = None;
        }
    }
}

fn restart_server(app: &AppHandle) {
    // In `TEAHOUSE_URL` mode the server is the developer's `npm start`, not ours.
    if std::env::var_os("TEAHOUSE_URL").is_some() {
        return;
    }
    stop_server(app);
    let Some(state) = app.try_state::<ShellState>() else {
        return;
    };
    if let Err(error) = spawn_server(state.inner()) {
        let _ = app
            .dialog()
            .message(format!("重启服务端失败：{error}"))
            .title("teahouse")
            .kind(MessageDialogKind::Error)
            .show(|_| {});
    }
}

fn relaunch(app: &AppHandle) {
    stop_server(app);
    force_quit(app);
    if let Ok(exe) = std::env::current_exe() {
        let _ = Command::new(exe).spawn();
    }
    app.exit(0);
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/// Fetch the manifest, download the zip, verify it if a hash is given, and
/// stage it under `%APPDATA%\teahouse\update\staged`. `Ok(None)` means current.
fn stage_update(manifest_url: &str, home: &Path, installed: Option<&str>) -> Result<Option<String>, String> {
    let response = ureq::get(manifest_url)
        .timeout(Duration::from_secs(30))
        .call()
        .map_err(|error| error.to_string())?;
    let manifest: serde_json::Value = response.into_json().map_err(|error| error.to_string())?;
    let version = manifest
        .get("version")
        .and_then(|value| value.as_str())
        .ok_or("清单里没有 version")?
        .to_string();
    let url = manifest
        .get("url")
        .and_then(|value| value.as_str())
        .ok_or("清单里没有 url")?
        .to_string();
    let expected = manifest
        .get("sha256")
        .and_then(|value| value.as_str())
        .map(|value| value.to_lowercase());
    if installed == Some(version.as_str()) {
        return Ok(None);
    }

    let update_dir = home.join("update");
    fs::create_dir_all(&update_dir).map_err(|error| error.to_string())?;
    let zip_path = update_dir.join("download.zip");
    let mut reader = ureq::get(&url)
        .timeout(Duration::from_secs(300))
        .call()
        .map_err(|error| error.to_string())?
        .into_reader();
    let mut file = File::create(&zip_path).map_err(|error| error.to_string())?;
    std::io::copy(&mut reader, &mut file).map_err(|error| error.to_string())?;
    drop(file);

    if let Some(expected) = expected {
        let actual = sha256_file(&zip_path)?;
        if actual != expected {
            let _ = fs::remove_file(&zip_path);
            return Err(format!("校验和不匹配（期望 {expected}，实际 {actual}）"));
        }
    }

    let staged = update_dir.join("staged");
    let _ = fs::remove_dir_all(&staged);
    fs::create_dir_all(&staged).map_err(|error| error.to_string())?;
    let result = extract_zip(&zip_path, &staged);
    let _ = fs::remove_file(&zip_path);
    result?;
    if !staged.join("src").join("server.ts").is_file() || !staged.join("web").is_dir() {
        let _ = fs::remove_dir_all(&staged);
        return Err("压缩包里没有 src/server.ts 与 web/，目录结构不对".into());
    }
    fs::write(update_dir.join("version"), &version).map_err(|error| error.to_string())?;
    Ok(Some(version))
}

/// Swap `update\staged` into `app`, rolling back if the rename fails. Runs at
/// startup, so a half-swapped app is never served.
fn apply_staged_update(home: &Path) -> Option<String> {
    let staged = home.join("update").join("staged");
    if !staged.join("src").join("server.ts").is_file() {
        return None;
    }
    let app_dir = home.join("app");
    let backup = home.join("app.bak");
    let _ = fs::remove_dir_all(&backup);
    if app_dir.exists() && fs::rename(&app_dir, &backup).is_err() {
        return None;
    }
    if fs::rename(&staged, &app_dir).is_err() {
        if backup.exists() {
            let _ = fs::rename(&backup, &app_dir);
        }
        return None;
    }
    let _ = fs::remove_dir_all(&backup);
    let version = fs::read_to_string(home.join("update").join("version"))
        .ok()
        .map(|text| text.trim().to_string());
    if let Some(version) = &version {
        let mut settings = load_settings(home);
        settings.app_version = Some(version.clone());
        save_settings(home, &settings);
    }
    version
}

fn check_updates(app: &AppHandle) {
    let Some(state) = app.try_state::<ShellState>() else {
        return;
    };
    let (url, installed) = match state.settings.lock() {
        Ok(settings) => (settings.update_url.clone(), settings.app_version.clone()),
        Err(_) => (None, None),
    };
    let Some(url) = url else {
        let _ = app
            .dialog()
            .message("没有配置更新地址：设置环境变量 TEAHOUSE_UPDATE_URL，或写进 %APPDATA%\\teahouse\\shell.json 的 updateUrl。")
            .title("teahouse")
            .show(|_| {});
        return;
    };
    let home = state.home.clone();
    let handle = app.clone();
    std::thread::spawn(move || match stage_update(&url, &home, installed.as_deref()) {
        Ok(Some(version)) => {
            let next = handle.clone();
            handle
                .dialog()
                .message(format!("已下载 v{version}，重启后生效。"))
                .title("teahouse")
                .buttons(MessageDialogButtons::OkCancelCustom("立即重启".into(), "稍后".into()))
                .show(move |restart| {
                    if restart {
                        relaunch(&next);
                    }
                });
        }
        Ok(None) => {
            let _ = handle.dialog().message("已经是最新版。").title("teahouse").show(|_| {});
        }
        Err(error) => {
            let _ = handle
                .dialog()
                .message(format!("检查更新失败：{error}"))
                .title("teahouse")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    });
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        // `enclosed_name` refuses `..` and absolute paths: no zip-slip.
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let target = dest.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut out = File::create(&target).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn load_settings(home: &Path) -> Settings {
    fs::read_to_string(home.join("shell.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_settings(home: &Path, settings: &Settings) {
    if let Ok(text) = serde_json::to_string_pretty(settings) {
        let _ = fs::write(home.join("shell.json"), text);
    }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn teahouse_home() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("teahouse")
}

/// Where bundled resources may live. Tauri keeps the configured relative path,
/// so a bundled `resources/runtime/node.exe` ends up under `<resource_dir>/resources`;
/// `cargo run` uses the crate's own `resources/`. Both are checked.
fn resource_roots(app: &tauri::App) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir.join("resources"));
        roots.push(dir);
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    roots
}

fn resolve_node(roots: &[PathBuf]) -> PathBuf {
    if let Some(path) = std::env::var_os("TEAHOUSE_NODE") {
        return PathBuf::from(path);
    }
    for root in roots {
        let bundled = root.join("runtime").join("node.exe");
        if bundled.exists() {
            return bundled;
        }
    }
    // A development machine has Node on PATH; a release bundles the runtime.
    PathBuf::from("node")
}

/// The app source to run, in order: `TEAHOUSE_APP`, the per-user copy, a seed from
/// the bundled resources (only when this run will spawn a server), then the
/// sibling checkout — which is what `TEAHOUSE_URL` development uses.
fn resolve_app_dir(roots: &[PathBuf], home: &Path, seed: bool) -> PathBuf {
    if let Some(dir) = std::env::var_os("TEAHOUSE_APP") {
        return PathBuf::from(dir);
    }
    let user = home.join("app");
    if is_app_dir(&user) {
        return user;
    }
    if seed {
        for root in roots {
            let bundled = root.join("app");
            if is_app_dir(&bundled) && copy_dir(&bundled, &user).is_ok() {
                return user;
            }
        }
    }
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(|dir| dir.join("teahouse"));
    if let Some(checkout) = checkout {
        if is_app_dir(&checkout) {
            return checkout;
        }
    }
    user
}

fn is_app_dir(dir: &Path) -> bool {
    dir.join("src").join("server.ts").is_file()
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .unwrap_or(8787)
}

fn wait_for_health(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if health_ok(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// A minimal `GET /api/health`; one readiness probe is not worth an HTTP crate.
fn health_ok(port: u16) -> bool {
    let mut stream = match TcpStream::connect(("127.0.0.1", port)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let request = "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buffer = [0_u8; 64];
    match stream.read(&mut buffer) {
        Ok(read) if read > 0 => {
            let head = String::from_utf8_lossy(&buffer[..read]);
            head.starts_with("HTTP/") && head.contains(" 200")
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("teahouse-shell-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn extract_zip_writes_files_and_refuses_traversal() {
        let dir = temp_dir("zip");
        let zip_path = dir.join("a.zip");
        {
            let file = File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("src/server.ts", options).unwrap();
            writer.write_all(b"// hi").unwrap();
            writer.start_file("web/index.html", options).unwrap();
            writer.write_all(b"<html>").unwrap();
            writer.start_file("../escape.txt", options).unwrap();
            writer.write_all(b"nope").unwrap();
            writer.finish().unwrap();
        }
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        extract_zip(&zip_path, &out).unwrap();
        assert!(out.join("src").join("server.ts").is_file());
        assert!(out.join("web").join("index.html").is_file());
        assert!(!dir.join("escape.txt").exists(), "zip-slip must be refused");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_staged_update_swaps_and_records_the_version() {
        let home = temp_dir("apply");
        let staged = home.join("update").join("staged");
        fs::create_dir_all(staged.join("src")).unwrap();
        fs::create_dir_all(staged.join("web")).unwrap();
        fs::write(staged.join("src").join("server.ts"), "// new").unwrap();
        fs::write(staged.join("web").join("index.html"), "<html>").unwrap();
        fs::write(home.join("update").join("version"), "9.9.9").unwrap();
        let app = home.join("app");
        fs::create_dir_all(app.join("src")).unwrap();
        fs::write(app.join("src").join("server.ts"), "// old").unwrap();

        let version = apply_staged_update(&home);

        assert_eq!(version.as_deref(), Some("9.9.9"));
        assert!(home.join("app").join("web").join("index.html").is_file());
        assert!(!home.join("app.bak").exists());
        assert!(!home.join("update").join("staged").exists());
        assert_eq!(load_settings(&home).app_version.as_deref(), Some("9.9.9"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn zoom_steps_are_clamped_and_snapped() {
        assert_eq!(zoom_step(1.0, "in").unwrap(), 1.1);
        assert_eq!(zoom_step(1.0, "out").unwrap(), 0.9);
        assert_eq!(zoom_step(1.3, "reset").unwrap(), 1.0);
        assert_eq!(zoom_step(2.0, "in").unwrap(), 2.0, "clamped at the top");
        assert_eq!(zoom_step(0.5, "out").unwrap(), 0.5, "clamped at the bottom");
        assert!(zoom_step(1.0, "nope").is_err());
        let mut level = 1.0;
        for _ in 0..3 {
            level = zoom_step(level, "out").unwrap();
        }
        assert_eq!(level, 0.7, "no floating point drift");
    }
}
