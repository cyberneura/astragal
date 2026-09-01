mod config;

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

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
    /// 起動後に判明した警告 (ホットキーの登録失敗など)。設定の警告と一緒に
    /// ターミナルへ表示する。
    warnings: Mutex<Vec<String>>,
    /// 最後にイベントを受けたトレイアイコンの位置 (物理ピクセル)
    tray_anchor: Mutex<Option<TrayAnchor>>,
    /// small ウインドウが blur で隠れた時刻。トレイクリックのトグル判定に使う。
    blur_hidden_at: Mutex<Option<Instant>>,
    /// 自分から hide() した時に飛んでくる blur を、記録から除くための印。
    suppress_blur_record: AtomicBool,
    /// 最後に送ったツノの位置。フロントの購読が間に合わなかった時に送り直す。
    last_arrow_x: Mutex<Option<f64>>,
}

/// トレイアイコンの中心 x と下端 y (グローバル論理ポイント)
#[derive(Debug, Clone, Copy)]
struct TrayAnchor {
    center_x: f64,
    bottom: f64,
}

/// トレイアイコンの位置が取れない時に使うメニューバーの高さ (論理ピクセル)
const MENU_BAR_HEIGHT: f64 = 24.0;
/// 画面端に張り付かせない余白 (論理ピクセル)
const SCREEN_EDGE_MARGIN: f64 = 8.0;
/// blur で隠れた直後の表示要求を「閉じる操作」とみなす猶予
const BLUR_HIDE_GUARD: Duration = Duration::from_millis(250);
/// トレイイベントの記録位置と現在のカーソルのずれを許容する幅 (論理ピクセル)。
/// 超えたらイベント発生後にカーソルが動いたとみなし、アンカーの更新を見送る。
const CURSOR_DRIFT_TOLERANCE: f64 = 8.0;

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
    let state = app.state::<AppState>();
    let loaded = &state.config;
    let shell = loaded.config.shell.resolve_command();

    let mut warnings: Vec<String> = loaded.warning.clone().into_iter().collect();
    if let Ok(runtime) = state.warnings.lock() {
        warnings.extend(runtime.iter().cloned());
    }

    FrontendConfig {
        font: loaded.config.font.clone(),
        theme: loaded.config.theme.clone(),
        shell_name: shell
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "shell".to_string()),
        config_path: loaded.path.display().to_string(),
        warning: (!warnings.is_empty()).then(|| warnings.join("\n")),
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
fn create_terminal(app: AppHandle, window: WebviewWindow) -> Result<u32, String> {
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
    // 出力は pty を作ったウインドウにだけ送る。全ウインドウへブロードキャストすると、
    // もう一方は自分の知らない tab_id の出力を溜め続ける (捨てる術が無い)。
    let label = window.label().to_string();

    // Spawn reader thread: read from pty and send to frontend via events
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let encoded =
                        base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_clone.emit_to(
                        label.as_str(),
                        "terminal-output",
                        serde_json::json!({
                            "tab_id": session_id,
                            "data": encoded,
                        }),
                    );
                }
                Ok(_) => {
                    // EOF
                    let _ = app_clone.emit_to(
                        label.as_str(),
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
        toggle_visibility(&win)?;
    }
    Ok(())
}

/// 表示・非表示を切り替える。
///
/// `is_visible()` は他アプリの背後にある可視ウインドウでも true を返すので、
/// フォーカスも見ないと、ホットキーで前面に出すつもりが隠れてしまう。
fn toggle_visibility(win: &WebviewWindow) -> Result<(), String> {
    if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
        return win.hide().map_err(|e| e.to_string());
    }
    let _ = move_to_cursor_monitor(win);
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())
}

/// カーソルが載っているディスプレイの中央へ移す。既にそのディスプレイに居る時は
/// 動かさない。手で置いた位置を毎回中央へ戻されると使いにくいため。
fn move_to_cursor_monitor(win: &WebviewWindow) -> Result<(), String> {
    let Some(target) = monitor_with_cursor(win.app_handle()) else {
        return Ok(());
    };
    if win
        .current_monitor()
        .ok()
        .flatten()
        .is_some_and(|current| current.position() == target.position())
    {
        return Ok(());
    }

    // 論理ポイントに揃えて計算する。outer_size は移動元モニタの物理値なので、
    // 移動先の scale が違うと物理のままでは幅が食い違う。
    let scale = target.scale_factor();
    let win_scale = win.scale_factor().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let win_width = size.width as f64 / win_scale;
    let win_height = size.height as f64 / win_scale;

    let left = target.position().x as f64 / scale;
    let top = target.position().y as f64 / scale;
    let mon_width = target.size().width as f64 / scale;
    let mon_height = target.size().height as f64 / scale;

    // 中央揃えの式は、ウインドウが移動先より大きいと負のオフセットになり、上端や
    // 左端が画面外へ出る。タイトルバーが画面外に出ると掴めなくなり、手で戻せない。
    let left_limit = left + SCREEN_EDGE_MARGIN;
    let top_limit = top + MENU_BAR_HEIGHT;
    let right_limit = left + mon_width - win_width - SCREEN_EDGE_MARGIN;
    let bottom_limit = top + mon_height - win_height - SCREEN_EDGE_MARGIN;

    let x = left + (mon_width - win_width) / 2.0;
    let y = top + (mon_height - win_height) / 2.0;
    // 入り切らない時は左上に寄せる (clamp は lo > hi でパニックするので分岐する)
    let x = if right_limit >= left_limit {
        x.clamp(left_limit, right_limit)
    } else {
        left_limit
    };
    let y = if bottom_limit >= top_limit {
        y.clamp(top_limit, bottom_limit)
    } else {
        top_limit
    };

    // 物理のまま渡すと tao が移動元ウインドウの scale で論理化するため、スケールの
    // 違うモニタへ動かす時にずれる。論理座標で渡して換算を挟ませない。
    win.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn show_small_window(app: AppHandle) -> Result<(), String> {
    toggle_small_window(app, false)
}

/// 吹き出しの表示・非表示を切り替える。
///
/// トレイの status item は自プロセスの NSWindow なので、`Click` が届く時点で
/// 吹き出しは既に key を失っている (`is_focused()` は常に false)。そのため
/// トレイ起点かどうかで閉じる判定を変える必要がある。
///
/// - `hide_on_blur` が有効: blur ハンドラが先に隠しているので、直後の表示要求を
///   「閉じる操作」とみなして捨てる (でないと閉じてすぐ開き直すだけになる)
/// - `hide_on_blur` が無効: blur では隠れないので、可視ならここで閉じる
///
/// blur の記録は自分の `hide()` でも立つため、ガードはトレイ起点の時だけ見る。
/// ホットキーやメニューから見てしまうと、連続操作が黙って捨てられる。
fn toggle_small_window(app: AppHandle, from_tray_click: bool) -> Result<(), String> {
    let Some(win) = app.get_webview_window("small") else {
        return Ok(());
    };
    let hides_on_blur = app
        .state::<AppState>()
        .config
        .config
        .small_window()
        .hide_on_blur;

    let closable = win.is_focused().unwrap_or(false) || (from_tray_click && !hides_on_blur);
    if win.is_visible().unwrap_or(false) && closable {
        return hide_small_window(&win);
    }
    if from_tray_click && consume_recent_blur_hide(&app) {
        return Ok(());
    }

    // 吹き出しのツノをトレイアイコンの真下に合わせる。位置は画面端で
    // クランプするので、ウインドウ左端からのオフセットを front に渡す。
    // 位置決めに失敗しても、ウインドウ自体は出す (出ない方が困る)。
    let arrow_x = anchor_small_window(&app, &win).unwrap_or_else(|e| {
        eprintln!("astragal: failed to anchor the small window: {e}");
        // 位置決めに失敗してもツノは出す。出ないままだと吹き出しに見えない。
        app.state::<AppState>().config.config.small_window().width / 2.0
    });
    if let Ok(mut last) = app.state::<AppState>().last_arrow_x.lock() {
        *last = Some(arrow_x);
    }
    emit_anchor(&app, arrow_x);

    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

fn emit_anchor(app: &AppHandle, arrow_x: f64) {
    let _ = app.emit_to(
        "small",
        "small-window-anchor",
        serde_json::json!({ "arrow_x": arrow_x }),
    );
}

/// 表示中のツノの位置を送り直す。
///
/// アンカーは単発イベントなので、起動直後にフロントがリスナーを登録するより先に
/// 表示されると取りこぼす。フロントは購読の直後にこれを呼ぶ。
#[tauri::command]
fn request_small_anchor(app: AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("small") else {
        return Ok(());
    };
    if !win.is_visible().unwrap_or(false) {
        return Ok(());
    }
    let last = *app
        .state::<AppState>()
        .last_arrow_x
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(arrow_x) = last {
        emit_anchor(&app, arrow_x);
    }
    Ok(())
}

/// blur で隠れたことを記録する。自分から hide() した時の blur は数えない。
fn record_blur_hide(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.suppress_blur_record.swap(false, Ordering::Relaxed) {
        return;
    }
    let Ok(mut hidden_at) = state.blur_hidden_at.lock() else {
        return;
    };
    *hidden_at = Some(Instant::now());
}

/// 自分から隠す。この hide が起こす blur は「フォーカスを失って隠れた」記録に
/// しない (記録するとトレイクリックのガードが誤爆する)。
fn hide_small_window(win: &WebviewWindow) -> Result<(), String> {
    let was_focused = win.is_focused().unwrap_or(false);
    // 印を立てるのは hide が成功してから。失敗して立てっぱなしにすると、
    // 次に本当にフォーカスを失った時の記録を食う。
    win.hide().map_err(|e| e.to_string())?;
    if was_focused {
        win.app_handle()
            .state::<AppState>()
            .suppress_blur_record
            .store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// 直前に blur で隠れたか。記録は 1 回だけ消費するので、次のクリックでは開く。
fn consume_recent_blur_hide(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let Ok(mut hidden_at) = state.blur_hidden_at.lock() else {
        return false;
    };
    hidden_at
        .take()
        .is_some_and(|at| at.elapsed() < BLUR_HIDE_GUARD)
}

/// メニューバーのトレイアイコンの真下にウインドウを置き、ウインドウ左端から
/// アイコン中心までの距離 (論理ピクセル) を返す。
fn anchor_small_window(app: &AppHandle, win: &WebviewWindow) -> Result<f64, String> {
    // outer_size は「今ウインドウが載っているモニタ」の物理値。移動先のスケールが
    // 違うと物理幅も変わるので、論理幅に戻してから使う。
    let current_scale = win.scale_factor().map_err(|e| e.to_string())?;
    let logical_width = win.outer_size().map_err(|e| e.to_string())?.width as f64 / current_scale;

    let stored = *app
        .state::<AppState>()
        .tray_anchor
        .lock()
        .map_err(|e| e.to_string())?;

    let anchor = match stored {
        Some(anchor) => anchor,
        // トレイのイベントを一度も受けていない時のフォールバック。
        None => {
            let primary = app.primary_monitor().ok().flatten();
            TrayAnchor {
                center_x: primary
                    .as_ref()
                    .map(|m| {
                        (m.position().x as f64 + m.size().width as f64 / 2.0) / m.scale_factor()
                    })
                    .unwrap_or(logical_width / 2.0),
                bottom: MENU_BAR_HEIGHT,
            }
        }
    };

    // メニューバーはアクティブなディスプレイに出るので、アイコンが乗っている
    // モニタを基準にする。primary 固定にすると、サブディスプレイから開いた時に
    // x だけプライマリ側へクランプされてウインドウが別画面に飛ぶ。
    let monitor = monitor_containing(app, &anchor);

    let mut x = anchor.center_x - logical_width / 2.0;
    if let Some(monitor) = &monitor {
        let scale = monitor.scale_factor();
        let monitor_left = monitor.position().x as f64 / scale;
        let monitor_width = monitor.size().width as f64 / scale;
        let left = monitor_left + SCREEN_EDGE_MARGIN;
        let right = monitor_left + monitor_width - logical_width - SCREEN_EDGE_MARGIN;
        if right >= left {
            x = x.clamp(left, right);
        }
    }

    // 物理のまま渡すと、tao が「移動元ウインドウの scale」で論理化するため、
    // スケールの違うモニタへ動かす時にずれる。論理座標で渡して換算を挟ませない。
    win.set_position(LogicalPosition::new(x, anchor.bottom))
        .map_err(|e| e.to_string())?;
    Ok(anchor.center_x - x)
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
        let _ = move_to_cursor_monitor(&win);
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// メニューバー用。template 画像はアルファしか使われないので単色 + 透過の専用素材。
/// アプリアイコンを流用すると階調が落ちて黒い塊になる。
#[cfg(target_os = "macos")]
fn tray_icon() -> Result<tauri::image::Image<'static>, tauri::Error> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/tray-mac.png"))
}

/// Windows のトレイに template の概念は無いのでカラーのまま使う。
#[cfg(not(target_os = "macos"))]
fn tray_icon() -> Result<tauri::image::Image<'static>, tauri::Error> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/tray-win.png"))
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
        .icon(tray_icon()?)
        // macOS 以外では無視される
        .icon_as_template(true)
        .menu(&menu)
        // 左クリックは吹き出しを出す。メニューは右クリックに寄せる
        .show_menu_on_left_click(false)
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
            let app = tray.app_handle();
            // クリック以外 (hover 等) でも位置が届くので、来るたびに覚えておく。
            // メニュー経由で開いた時にもツノの位置合わせに使う。
            if let Some(next) = tray_icon_geometry(&event)
                .and_then(|(position, rect)| tray_anchor(app, position, rect))
            {
                if let Ok(mut anchor) = app.state::<AppState>().tray_anchor.lock() {
                    *anchor = Some(next);
                }
            }
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = toggle_small_window(app.clone(), true);
            }
        })
        .build(app)?;

    Ok(())
}

/// 論理ポイントのアンカーが、このモニタの矩形に入るか。
///
/// Monitor の position / size は「CGDisplayBounds の論理値 × そのモニタ自身の
/// scale」なので、比較する前に自分の scale で割って論理ポイントへ戻す。
fn anchor_on_monitor(
    anchor: &TrayAnchor,
    monitor_x: f64,
    monitor_y: f64,
    monitor_width: f64,
    monitor_height: f64,
    scale: f64,
) -> bool {
    let left = monitor_x / scale;
    let top = monitor_y / scale;
    anchor.center_x >= left
        && anchor.center_x < left + monitor_width / scale
        && anchor.bottom >= top
        && anchor.bottom < top + monitor_height / scale
}

/// アンカーを含むモニタ。見つからなければ primary にフォールバックする。
fn monitor_containing(app: &AppHandle, anchor: &TrayAnchor) -> Option<tauri::Monitor> {
    app.available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|monitor| {
                anchor_on_monitor(
                    anchor,
                    monitor.position().x as f64,
                    monitor.position().y as f64,
                    monitor.size().width as f64,
                    monitor.size().height as f64,
                    monitor.scale_factor(),
                )
            })
        })
        .or_else(|| app.primary_monitor().ok().flatten())
}

/// マウスカーソルが載っているモニタ。
///
/// 単位系が揃っていないので物理値のままでは比較できない。`cursor_position` は
/// 「グローバル論理座標 × primary の scale」を返すのに対し、`Monitor` の
/// position / size は「CGDisplayBounds の論理値 × そのモニタ自身の scale」で、
/// スケール混在時に食い違う。どちらも自分の scale で割って論理ポイントに戻す。
fn cursor_logical(app: &AppHandle) -> Option<(f64, f64)> {
    let primary_scale = app.primary_monitor().ok().flatten()?.scale_factor();
    let cursor = app.cursor_position().ok()?;
    Some((cursor.x / primary_scale, cursor.y / primary_scale))
}

/// 論理ポイントの座標を含むモニタ。
fn monitor_at(app: &AppHandle, x: f64, y: f64) -> Option<tauri::Monitor> {
    app.available_monitors().ok()?.into_iter().find(|monitor| {
        let scale = monitor.scale_factor();
        let left = monitor.position().x as f64 / scale;
        let top = monitor.position().y as f64 / scale;
        let right = left + monitor.size().width as f64 / scale;
        let bottom = top + monitor.size().height as f64 / scale;
        x >= left && x < right && y >= top && y < bottom
    })
}

fn monitor_with_cursor(app: &AppHandle) -> Option<tauri::Monitor> {
    let (x, y) = cursor_logical(app)?;
    monitor_at(app, x, y)
}

/// アンカーの記録に使えるイベントから、発生時のカーソル位置と矩形を取る。
/// どちらも同じ scale (トレイの載っているディスプレイのもの) で換算されている。
///
/// `Move` と `Leave` は含めない。Rect は `Enter` と同じ値しか持たず情報が増えない
/// 一方、カーソルが動いている最中のイベントほど、処理までに別ディスプレイへ抜けて
/// `tray_anchor` の scale 推定を外す確率が高い。`Leave` に至ってはカーソルが確実に
/// アイコンから外れている。アイコン上に留まる `Enter` とクリックだけを使う。
fn tray_icon_geometry(
    event: &TrayIconEvent,
) -> Option<(&tauri::PhysicalPosition<f64>, &tauri::Rect)> {
    match event {
        TrayIconEvent::Click { position, rect, .. }
        | TrayIconEvent::DoubleClick { position, rect, .. }
        | TrayIconEvent::Enter { position, rect, .. } => Some((position, rect)),
        _ => None,
    }
}

/// イベント発生時からカーソルが動いていないか。
///
/// `captured` はイベントが記録したカーソル位置 (物理値)。`scale` の推定が当たって
/// いて、かつカーソルが動いていなければ、論理へ戻した値は現在位置と一致する。
/// スケールの違うディスプレイへ抜けていた場合はここでずれるので弾ける。
///
/// 既知の限界: 移動先がちょうど `captured / scale` 付近だと、誤った scale でも
/// 一致してしまう (scale 1 の物理 1612 を scale 2 で戻した 806 に、実カーソルが
/// 来ている場合など)。トレイの scale を確定できる入力が `Rect` にも `position` にも
/// 無いため (どちらも同じ未知の scale の物理値)、この重なりは検算では潰せない。
/// 踏むと吹き出しが 1 回別ディスプレイに出るが、次にアイコンへ触れた時点で直る。
fn cursor_is_stable(captured: (f64, f64), scale: f64, current: (f64, f64)) -> bool {
    (captured.0 / scale - current.0).abs() <= CURSOR_DRIFT_TOLERANCE
        && (captured.1 / scale - current.1).abs() <= CURSOR_DRIFT_TOLERANCE
}

/// macOS の tray-icon は status item のウインドウの backingScaleFactor で物理値に
/// 変換済みの Rect を返すため、ここで渡す scale は実質使われない (他プラットフォーム
/// 用のフォールバック)。
fn tray_anchor(
    app: &AppHandle,
    captured: &tauri::PhysicalPosition<f64>,
    rect: &tauri::Rect,
) -> Option<TrayAnchor> {
    // 物理値がどのディスプレイの scale で換算されたかは Rect から分からない。
    // トレイイベントが飛ぶ時カーソルはアイコン上にあるので、カーソルの載っている
    // モニタ = トレイの載っているモニタとして scale を引く。
    //
    // 候補モニタごとに自分の scale で割って判定する方法では直らない。スケールが
    // 混在すると、割った結果が別モニタの論理矩形にも収まってしまうため。
    let cursor = cursor_logical(app)?;
    let monitor = monitor_at(app, cursor.0, cursor.1)?;
    let scale = monitor.scale_factor();

    // イベントが積まれてから処理されるまでにカーソルが動いていると、上のモニタは
    // トレイの載っているディスプレイとは限らない。イベント自身が記録した位置と
    // 突き合わせて、動いていた場合は記録を捨てる (前回のアンカーを保つ)。
    //
    // 換算後のアンカーがそのモニタに載るかを見るだけでは不十分。scale を取り違えて
    // 縮んだ座標が、別モニタの論理矩形に収まってしまうため。
    if !cursor_is_stable((captured.x, captured.y), scale, cursor) {
        return None;
    }

    let position = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    Some(TrayAnchor {
        center_x: (position.x + size.width / 2.0) / scale,
        bottom: (position.y + size.height) / scale,
    })
}

/// 設定されたグローバルホットキーを登録する。
///
/// 登録に失敗した時は黙って無効にせず警告として残す。ただし macOS の
/// RegisterEventHotKey はプロセス単位の登録で、他アプリやシステムが同じ
/// 組み合わせを握っていても成功を返す。その場合は警告が出ないままキーだけが
/// 届かないので、「警告が無い = 効いている」ではない。
fn setup_hotkeys(app: &AppHandle, hotkeys: &config::HotkeyConfig) {
    register_hotkey(app, hotkeys.window(), toggle_window);
    register_hotkey(app, hotkeys.small_window(), show_small_window);
}

fn register_hotkey(
    app: &AppHandle,
    shortcut: Option<&str>,
    action: fn(AppHandle) -> Result<(), String>,
) {
    let Some(shortcut) = shortcut else {
        return;
    };
    let result = app
        .global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            // 押下と解放の両方が来るので、押下だけを拾わないと 2 回トグルする
            if event.state == ShortcutState::Pressed {
                if let Err(e) = action(app.clone()) {
                    eprintln!("astragal: hotkey action failed: {e}");
                }
            }
        });
    if let Err(e) = result {
        warn(app, format!("failed to register hotkey {shortcut}: {e}"));
    }
}

fn warn(app: &AppHandle, message: String) {
    eprintln!("astragal: {message}");
    if let Ok(mut warnings) = app.state::<AppState>().warnings.lock() {
        warnings.push(message);
    }
}

/// 赤ボタンでウインドウを閉じずに隠す。閉じると webview ごと破棄されるので、
/// トレイから開き直しても復元できず、ターミナルのセッションも失われる。
fn hide_on_close(win: &WebviewWindow) {
    let target = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = target.hide();
        }
    });
}

/// フォーカスを失ったらウインドウを隠す。
///
/// 「一度フォーカスを得た後の blur」だけを対象にする。起動シーケンス中は
/// ウインドウ生成やアプリのアクティベート順で、フォーカスを得ていない
/// ウインドウにも blur が飛んでくる。それで隠すと、表示された直後に消える。
fn hide_on_blur<F: Fn() + Send + 'static>(win: &WebviewWindow, on_hide: F) {
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
            on_hide();
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = move_to_cursor_monitor(&win);
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .manage(AppState {
            sessions: Mutex::new(Vec::new()),
            next_tab_id: Mutex::new(0),
            config: loaded_config.clone(),
            warnings: Mutex::new(Vec::new()),
            tray_anchor: Mutex::new(None),
            blur_hidden_at: Mutex::new(None),
            suppress_blur_record: AtomicBool::new(false),
            last_arrow_x: Mutex::new(None),
        })
        .setup(move |app| {
            // Dock に出さない。メニューバー常駐が主で、Dock アイコンから起動する
            // 導線が無いため。Info.plist の LSUIElement はバンドルにしか効かず、
            // dev 実行では素のバイナリが動くので実行時にも設定する。
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let cfg = &loaded_config.config;
            setup_tray(app.handle())?;
            setup_hotkeys(app.handle(), &cfg.hotkeys);

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
            // 吹き出しのツノの周りを抜くために背景を透過させる
            .transparent(true)
            .visible(false)
            .center()
            .build()?;
            hide_on_close(&small_win);
            if small_spec.hide_on_blur {
                let handle = app.handle().clone();
                hide_on_blur(&small_win, move || {
                    record_blur_hide(&handle);
                });
            }

            // main は tauri.conf.json では非表示で作り、設定を反映してから出す。
            if let Some(win) = app.get_webview_window("main") {
                let main_spec = cfg.main_window();
                let _ = win.set_size(LogicalSize::new(main_spec.width, main_spec.height));
                let _ = win.center();
                let _ = move_to_cursor_monitor(&win);
                hide_on_close(&win);
                if main_spec.hide_on_blur {
                    hide_on_blur(&win, || {});
                }
                win.show()?;
                let _ = win.set_focus();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            request_small_anchor,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

    /// Retina の primary (論理 1512x982, scale 2) の右に FHD の外部ディスプレイ
    /// (1920x1080, scale 1) を並べた構成。Monitor が返す物理値で表す。
    const PRIMARY: (f64, f64, f64, f64, f64) = (0.0, 0.0, 3024.0, 1964.0, 2.0);
    const EXTERNAL: (f64, f64, f64, f64, f64) = (1512.0, 0.0, 1920.0, 1080.0, 1.0);

    fn on(anchor: &TrayAnchor, m: (f64, f64, f64, f64, f64)) -> bool {
        anchor_on_monitor(anchor, m.0, m.1, m.2, m.3, m.4)
    }

    #[test]
    fn anchor_on_external_display_does_not_match_primary() {
        // Arrange
        // 外部ディスプレイの左寄り (論理 x=1612) にトレイがある状態。
        // 物理値のまま比較していた頃は primary の矩形 [0,3024) にも入ってしまい、
        // 先に一致した primary を引いて吹き出しが別画面に出ていた。
        let anchor = TrayAnchor {
            center_x: 1612.0,
            bottom: 24.0,
        };

        // Act / Assert
        assert!(!on(&anchor, PRIMARY));
        assert!(on(&anchor, EXTERNAL));
    }

    #[test]
    fn anchor_on_primary_display_does_not_match_external() {
        // Arrange
        let anchor = TrayAnchor {
            center_x: 1400.0,
            bottom: 24.0,
        };

        // Act / Assert
        assert!(on(&anchor, PRIMARY));
        assert!(!on(&anchor, EXTERNAL));
    }

    #[test]
    fn monitor_right_edge_is_exclusive() {
        // Arrange
        // primary の論理幅は 1512。右端そのものは外部ディスプレイの領域。
        let edge = TrayAnchor {
            center_x: 1512.0,
            bottom: 24.0,
        };
        let inside = TrayAnchor {
            center_x: 1511.0,
            bottom: 24.0,
        };

        // Act / Assert
        assert!(!on(&edge, PRIMARY));
        assert!(on(&edge, EXTERNAL));
        assert!(on(&inside, PRIMARY));
    }

    #[test]
    fn anchor_below_the_primary_display_is_not_on_it() {
        // Arrange
        // primary の論理高さは 1964/2 = 982。物理値のまま比較していた頃は、
        // 論理 y=1000 も 1964 未満なので内側と判定されていた。
        let anchor = TrayAnchor {
            center_x: 700.0,
            bottom: 1000.0,
        };

        // Act / Assert
        assert!(!on(&anchor, PRIMARY));
        // 外部は論理高さ 1080 で y は収まるが、x が左に外れている
        assert!(!on(&anchor, EXTERNAL));
    }

    #[test]
    fn cursor_moved_to_a_display_with_another_scale_is_rejected() {
        // Arrange
        // 外部 (scale 1) のトレイでイベントが起き、処理までにカーソルが primary
        // (scale 2) の (700, 500) へ移った状況。イベントの記録位置は物理 1612。
        // 「換算後が矩形に載るか」だけ見ると 1612/2 = 806 が primary の論理域に
        // 収まって通過してしまうため、記録位置との突き合わせで弾く。
        let captured = (1612.0, 24.0);

        // Act
        let stable = cursor_is_stable(captured, 2.0, (700.0, 500.0));

        // Assert
        assert!(!stable);
    }

    #[test]
    fn cursor_still_on_the_tray_icon_is_accepted() {
        // Arrange
        // 外部 (scale 1) のトレイ上にカーソルが留まっている。記録位置は物理 1612 で、
        // 論理でも 1612。scale 1 で戻せば現在位置と一致する。
        let captured = (1612.0, 12.0);

        // Act / Assert
        assert!(cursor_is_stable(captured, 1.0, (1612.0, 12.0)));
        // 同じ記録を primary の scale で戻すと大きくずれる
        assert!(!cursor_is_stable(captured, 2.0, (1612.0, 12.0)));
    }

    #[test]
    fn small_cursor_drift_while_hovering_is_tolerated() {
        // Arrange
        let captured = (1612.0, 12.0);

        // Act / Assert
        assert!(cursor_is_stable(captured, 1.0, (1616.0, 14.0)));
        assert!(!cursor_is_stable(captured, 1.0, (1640.0, 12.0)));
    }

    #[test]
    fn default_hotkeys_are_parsable() {
        // Arrange
        let hotkeys = config::HotkeyConfig::default();

        // Act
        let window = Shortcut::from_str(hotkeys.window().expect("should be set"))
            .expect("window hotkey should parse");
        let small = Shortcut::from_str(hotkeys.small_window().expect("should be set"))
            .expect("small_window hotkey should parse");

        // Assert
        assert_eq!(window.key, Code::KeyA);
        assert_eq!(
            window.mods,
            Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER
        );
        assert_eq!(
            small.mods,
            Modifiers::CONTROL | Modifiers::SHIFT | Modifiers::ALT | Modifiers::SUPER
        );
    }

    #[test]
    fn empty_hotkey_disables_the_binding() {
        // Arrange
        let hotkeys = config::HotkeyConfig {
            window: Some("  ".to_string()),
            small_window: None,
        };

        // Act & Assert
        assert!(hotkeys.window().is_none());
        assert!(hotkeys.small_window().is_none());
    }
}
