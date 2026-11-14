//! AppKit がイベントの処理中に投げた Objective-C 例外で落ちないようにする (macOS)。
//!
//! tao は `-[TaoApp sendEvent:]` と `-[TaoWindow sendEvent:]` を Rust の `extern "C"` 関数で上書きし、
//! その中から `[super sendEvent:]` を呼ぶ。AppKit が投げた NSException がこのフレームを越えようと
//! すると、Rust は「panic in a function that cannot unwind」で abort する。普通の Cocoa アプリなら
//! `-[NSApplication run]` が受け止めて報告するだけの例外である。
//!
//! 受け止めるのは `macos/exception_guard.m` (Objective-C の `@try`)。理由はそちらの冒頭。
//! 受け止めた例外は `crash_log.rs` が決めたファイル (`~/Library/Logs/Astragal/exceptions.log`) と Console.app に残る。

use std::path::Path;

extern "C" {
    fn astragal_guard_send_event(log_file: *const std::ffi::c_char) -> bool;
}

/// NSApplication と NSWindow の `-sendEvent:` を例外を受け止める実装に差し替える。
/// イベントループが回り始める前に main スレッドから呼ぶ。log_file が None なら Console.app にだけ出す
pub fn guard_send_event(log_file: Option<&Path>) {
    use std::os::unix::ffi::OsStrExt;
    let path = log_file.and_then(|p| std::ffi::CString::new(p.as_os_str().as_bytes()).ok());
    // SAFETY: 起動直後の main スレッドから呼ぶ。2 回目以降は何もしない。文字列は中で複製する
    let installed = unsafe { astragal_guard_send_event(path.as_ref().map_or(std::ptr::null(), |p| p.as_ptr())) };
    if !installed {
        eprintln!("astragal: could not install the Objective-C exception guard");
    }
}

#[cfg(test)]
mod tests {
    // 例外を受け止めることは Rust からは確かめられない (イベントを流す NSApplication が要る)。
    // ここでは .m がリンクされ、差し替え先のメソッドが見つかることだけを見る
    #[test]
    fn guard_send_event_installs_on_nsapplication_and_nswindow() {
        // Arrange / Act
        let installed = unsafe { super::astragal_guard_send_event(std::ptr::null()) };

        // Assert
        assert!(installed);
    }
}
