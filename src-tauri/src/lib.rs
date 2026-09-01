mod config;

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::process::Command as ShellCommand;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow,
};

// ── Pty Session ──────────────────────────────────────────────────────────────

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    _child: Box<dyn ChildKiller + Send>,
}

struct AppState {
    sessions: Mutex<Vec<Option<PtySession>>>,
    next_tab_id: Mutex<u32>,
    config: config::LoadedConfig,
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// フロントに渡す設定。ウインドウ設定は Rust 側で適用済みなので含めない。
#[derive(Serialize)]
struct FrontendConfig {
    font: config::FontConfig,
    theme: BTreeMap<String, String>,
    /// タブのラベルに使う、起動するコマンドのファイル名
    shell_name: String,
    config_path: String,
    warning: Option<String>,
}

#[tauri::command]
fn get_config(app: AppHandle) -> FrontendConfig {
    let loaded = &app.state::<AppState>().config;
    let shell = loaded.config.shell.resolve_command();
    FrontendConfig {
        font: loaded.config.font.clone(),
        theme: loaded.config.theme.clone(),
        shell_name: shell
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "shell".to_string()),
        config_path: loaded.path.display().to_string(),
        warning: loaded.warning.clone(),
    }
}

fn shell_command(shell: &config::ShellConfig) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell.resolve_command());
    for arg in &shell.args {
        cmd.arg(arg);
    }
    cmd.env("TERM", "xterm-256color");
    // Finder / open から起動したアプリは LANG を持たない。未設定のままだと
    // シェルや各種コマンドが出力を UTF-8 として扱わず、日本語が壊れる。
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    for (key, value) in &shell.env {
        cmd.env(key, value);
    }
    // GUI 起動時の cwd は / なので、ターミナルの開始位置としては使えない。
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }
    cmd
}

#[tauri::command]
fn create_terminal(app: AppHandle) -> Result<u32, String> {
    let app_state = app.state::<AppState>();
    let mut sessions = app_state.sessions.lock().map_err(|e| e.to_string())?;
    let mut next_id = app_state.next_tab_id.lock().map_err(|e| e.to_string())?;

    let tab_id = *next_id;
    *next_id += 1;

    // Spawn pty
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open pty: {}", e))?;

    let cmd = shell_command(&app_state.config.config.shell);
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take writer: {}", e))?;

    let app_clone = app.clone();
    let session_id = tab_id;

    // Spawn reader thread: read from pty and send to frontend via events
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let encoded =
                        base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_clone.emit(
                        "terminal-output",
                        serde_json::json!({
                            "tab_id": session_id,
                            "data": encoded,
                        }),
                    );
                }
                Ok(_) => {
                    // EOF
                    let _ = app_clone.emit(
                        "terminal-exit",
                        serde_json::json!({
                            "tab_id": session_id,
                        }),
                    );
                    break;
                }
                Err(e) => {
                    eprintln!("Pty read error: {}", e);
                    break;
                }
            }
        }
    });

    let session = PtySession {
        master: pair.master,
        writer: Mutex::new(writer),
        _child: child,
    };

    if (tab_id as usize) < sessions.len() {
        sessions[tab_id as usize] = Some(session);
    } else {
        sessions.resize_with(tab_id as usize + 1, || None);
        sessions[tab_id as usize] = Some(session);
    }

    Ok(tab_id)
}

#[tauri::command]
fn write_stdin(app: AppHandle, tab_id: u32, data: String) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let sessions = app_state.sessions.lock().map_err(|e| e.to_string())?;

    if let Some(Some(session)) = sessions.get(tab_id as usize) {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&data)
            .map_err(|e| format!("Base64 decode error: {}", e))?;
        let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
        writer
            .write_all(&decoded)
            .map_err(|e| format!("Write error: {}", e))?;
        writer.flush().map_err(|e| format!("Flush error: {}", e))?;
        Ok(())
    } else {
        Err(format!("No session for tab_id {}", tab_id))
    }
}

#[tauri::command]
fn resize_terminal(
    app: AppHandle,
    tab_id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let sessions = app_state.sessions.lock().map_err(|e| e.to_string())?;

    if let Some(Some(session)) = sessions.get(tab_id as usize) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize error: {}", e))
    } else {
        Err(format!("No session for tab_id {}", tab_id))
    }
}

#[tauri::command]
fn close_terminal(app: AppHandle, tab_id: u32) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let mut sessions = app_state.sessions.lock().map_err(|e| e.to_string())?;

    if let Some(slot) = sessions.get_mut(tab_id as usize) {
        *slot = None;
    }
    Ok(())
}

// ── Window Management ────────────────────────────────────────────────────────

#[tauri::command]
fn toggle_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            win.hide().map_err(|e| e.to_string())?;
        } else {
            win.show().map_err(|e| e.to_string())?;
            win.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn show_small_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("small") {
        if win.is_visible().unwrap_or(false) {
            win.hide().map_err(|e| e.to_string())?;
        } else {
            // Position at current mouse cursor
            if let Ok(pos) = mouse_position() {
                let _ = win.set_position(pos);
            }
            win.show().map_err(|e| e.to_string())?;
            win.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn mouse_position() -> Result<PhysicalPosition<f64>, String> {
    let output = ShellCommand::new("osascript")
        .args(["-e", r#"tell application "System Events" to return mouse position as string"#])
        .output()
        .map_err(|e| format!("osascript failed: {}", e))?;

    if !output.status.success() {
        return Err(format!("osascript exit: {}", output.status));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<&str> = stdout.split(", ").collect();
    if parts.len() != 2 {
        return Err(format!("unexpected mouse position format: {}", stdout));
    }

    let x: f64 = parts[0].parse().map_err(|e| format!("parse x: {}", e))?;
    let y: f64 = parts[1].parse().map_err(|e| format!("parse y: {}", e))?;

    Ok(PhysicalPosition { x, y })
}

#[tauri::command]
fn hide_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.hide().map_err(|e| e.to_string())?;
    }
    if let Some(win) = app.get_webview_window("small") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show_small = MenuItemBuilder::with_id("show_small", "Show Small Window").build(app)?;
    let toggle = MenuItemBuilder::with_id("toggle", "Show Window").build(app)?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let close = MenuItemBuilder::with_id("close", "Close").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show_small)
        .item(&toggle)
        .item(&separator)
        .item(&close)
        .build()?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show_small" => {
                let _ = show_small_window(app.clone());
            }
            "toggle" => {
                let _ = toggle_window(app.clone());
            }
            "close" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_small_window(tray.app_handle().clone());
            }
        })
        .build(app)?;

    Ok(())
}

/// フォーカスを失ったらウインドウを隠す。
///
/// 「一度フォーカスを得た後の blur」だけを対象にする。起動シーケンス中は
/// ウインドウ生成やアプリのアクティベート順で、フォーカスを得ていない
/// ウインドウにも blur が飛んでくる。それで隠すと、表示された直後に消える。
fn hide_on_blur(win: &WebviewWindow) {
    let focused_once = AtomicBool::new(false);
    let target = win.clone();
    win.on_window_event(move |event| {
        let tauri::WindowEvent::Focused(focused) = event else {
            return;
        };
        if *focused {
            focused_once.store(true, Ordering::Relaxed);
        } else if focused_once.swap(false, Ordering::Relaxed) {
            let _ = target.hide();
        }
    });
}

// ── App Entry ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ウインドウを出す前に設定を確定させる (config_override_command の実行を
    // 含むため、ここで数秒かかることがある)。
    let loaded_config = config::load();
    if let Some(warning) = &loaded_config.warning {
        eprintln!("astragal: {warning}");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .manage(AppState {
            sessions: Mutex::new(Vec::new()),
            next_tab_id: Mutex::new(0),
            config: loaded_config.clone(),
        })
        .setup(move |app| {
            let cfg = &loaded_config.config;
            setup_tray(app.handle())?;

            // small ウインドウを先に作る。生成に伴うフォーカス移動が main の
            // 表示より後に起きないようにするため。
            let small_spec = cfg.small_window();
            let small_win = tauri::WebviewWindowBuilder::new(
                app,
                "small",
                tauri::WebviewUrl::App("small.html".into()),
            )
            .title("")
            .inner_size(small_spec.width, small_spec.height)
            .resizable(true)
            .decorations(false)
            .visible(false)
            .center()
            .build()?;
            if small_spec.hide_on_blur {
                hide_on_blur(&small_win);
            }

            // main は tauri.conf.json では非表示で作り、設定を反映してから出す。
            if let Some(win) = app.get_webview_window("main") {
                let main_spec = cfg.main_window();
                let _ = win.set_size(LogicalSize::new(main_spec.width, main_spec.height));
                let _ = win.center();
                if main_spec.hide_on_blur {
                    hide_on_blur(&win);
                }
                win.show()?;
                let _ = win.set_focus();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            create_terminal,
            write_stdin,
            resize_terminal,
            close_terminal,
            toggle_window,
            show_small_window,
            hide_window,
            show_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
