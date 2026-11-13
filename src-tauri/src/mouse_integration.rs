//! Mouse integration の ON / OFF (CYBERNEURA-DEV-1262)。
//!
//! ON (既定) の時は、vim / tmux 等がマウスレポートを要求すればクリックやドラッグをアプリへ
//! 送る (xterm の既定どおり)。OFF にするとマウスをアプリへ送らず、ドラッグで範囲選択して
//! コピーできる。実際にマウスレポートを止めるのはフロント (`src/mouse-integration.ts`) で、
//! ここはアプリ全体で 1 つの状態と、メニューのチェック表示を持つ。
//!
//! 状態はメモリだけに置く (再起動すると ON に戻る)。範囲選択したい時だけ一時的に切る
//! 使い方を想定しているため。
//!
//! 切り替える経路はタブバーのボタン (`set_mouse_integration`)、トレイメニュー、
//! macOS のアプリメニュー (View) の 3 つで、どれも `set` を通してチェック表示と
//! 全ウインドウ (main / small) への通知を揃える。

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use tauri::{menu::CheckMenuItem, AppHandle, Emitter, Manager, Wry};

/// 状態が変わった時に全ウインドウへ送るイベント。payload は新しい状態 (bool)
pub const CHANGED_EVENT: &str = "mouse-integration-changed";

/// トレイメニューの項目の id
pub const TRAY_MENU_ID: &str = "mouse_integration";

/// アプリメニュー (View) の項目の id。トレイと分けてあるのは、メニューイベントのハンドラが
/// アプリメニューとトレイメニューの両方のイベントを受けるため (同じ id だと 1 回の選択で
/// 2 回切り替わり、元に戻ってしまう)
#[cfg(target_os = "macos")]
pub const APP_MENU_ID: &str = "app_mouse_integration";

pub const MENU_LABEL: &str = "Mouse Integration";

pub struct MouseIntegrationState {
    enabled: AtomicBool,
    /// チェック表示を揃えるメニュー項目 (トレイ)。アプリメニューの項目は `set` が
    /// `AppHandle::menu` から引く (アプリメニューは State より先に作られうるため)
    items: Mutex<Vec<CheckMenuItem<Wry>>>,
}

impl Default for MouseIntegrationState {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(true),
            items: Mutex::new(Vec::new()),
        }
    }
}

pub fn is_enabled(app: &AppHandle) -> bool {
    app.try_state::<MouseIntegrationState>()
        .is_none_or(|state| state.enabled.load(Ordering::SeqCst))
}

/// メニューの項目をチェック表示の同期対象に加える
pub fn register_item(app: &AppHandle, item: CheckMenuItem<Wry>) {
    if let Some(state) = app.try_state::<MouseIntegrationState>() {
        if let Ok(mut items) = state.items.lock() {
            items.push(item);
        }
    }
}

pub fn set(app: &AppHandle, enabled: bool) {
    let Some(state) = app.try_state::<MouseIntegrationState>() else {
        return;
    };
    state.enabled.store(enabled, Ordering::SeqCst);
    // チェック項目はクリックで自分の表示を反転させるので、選ばれた項目も含めて
    // 全部を状態に合わせ直す
    if let Ok(items) = state.items.lock() {
        for item in items.iter() {
            let _ = item.set_checked(enabled);
        }
    }
    #[cfg(target_os = "macos")]
    sync_app_menu(app, enabled);
    if let Err(e) = app.emit(CHANGED_EVENT, enabled) {
        eprintln!("astragal: failed to notify the mouse integration change: {e}");
    }
}

pub fn toggle(app: &AppHandle) {
    set(app, !is_enabled(app));
}

#[cfg(target_os = "macos")]
fn sync_app_menu(app: &AppHandle, enabled: bool) {
    let Some(menu) = app.menu() else {
        return;
    };
    let Ok(items) = menu.items() else {
        return;
    };
    for item in items {
        if let Some(found) = item.as_submenu().and_then(|sub| sub.get(APP_MENU_ID)) {
            if let Some(check) = found.as_check_menuitem() {
                let _ = check.set_checked(enabled);
            }
        }
    }
}

#[tauri::command]
pub fn mouse_integration(app: AppHandle) -> bool {
    is_enabled(&app)
}

#[tauri::command]
pub fn set_mouse_integration(app: AppHandle, enabled: bool) {
    set(&app, enabled);
}
