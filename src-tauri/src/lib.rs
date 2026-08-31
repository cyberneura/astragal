use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_single_instance;

// ── Pty Session ──────────────────────────────────────────────────────────────

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    _child: Box<dyn ChildKiller + Send>,
}

struct AppState {
    sessions: Mutex<Vec<Option<PtySession>>>,
    next_tab_id: Mutex<u32>,
}

// ── Commands ─────────────────────────────────────────────────────────────────

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

    let cmd = CommandBuilder::new("/bin/zsh");
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
            win.show().map_err(|e| e.to_string())?;
            win.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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

fn setup_main_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(win) = app.get_webview_window("main") {
        let win_clone = win.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(false) = event {
                let _ = win_clone.hide();
            }
        });
    }
    Ok(())
}

// ── App Entry ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        })
        .setup(|app| {
            setup_tray(app.handle())?;
            setup_main_window(app.handle())?;

            // Create small window for popover mode
            let _small_win = tauri::WebviewWindowBuilder::new(
                app,
                "small",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Astragal")
            .inner_size(480.0, 320.0)
            .resizable(true)
            .decorations(true)
            .visible(false)
            .center()
            .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
