use std::sync::Mutex;
use tauri::{LogicalSize, Manager, WebviewWindow};

#[derive(Default)]
pub struct ChatWindowState(Mutex<Option<f64>>);

#[tauri::command]
pub fn set_chat_open(window: WebviewWindow, open: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Agent chat is only available in the main window".into());
    }
    let state = window.state::<ChatWindowState>();
    let mut expansion = state.0.lock().map_err(|e| e.to_string())?;
    if open == expansion.is_some() {
        return Ok(());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let fixed = window.is_maximized().map_err(|e| e.to_string())?
        || window.is_fullscreen().map_err(|e| e.to_string())?;
    if open {
        let width = if fixed {
            size.width
        } else {
            let max = window
                .current_monitor()
                .map_err(|e| e.to_string())?
                .map(|m| m.size().to_logical::<f64>(m.scale_factor()).width)
                .unwrap_or(size.width * 1.5);
            (size.width * 1.5).min(max).max(size.width)
        };
        if !fixed {
            window
                .set_size(LogicalSize::new(width, size.height))
                .map_err(|e| e.to_string())?;
        }
        *expansion = Some(width / size.width);
    } else {
        if !fixed {
            window
                .set_size(LogicalSize::new(
                    size.width / expansion.unwrap_or(1.0),
                    size.height,
                ))
                .map_err(|e| e.to_string())?;
        }
        *expansion = None;
    }
    Ok(())
}
