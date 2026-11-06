//! AppKit がイベントの処理中に投げた Objective-C 例外で落ちないようにする (macOS、CYBERNEURA-DEV-1204)。
//!
//! tao は `-[TaoApp sendEvent:]` を Rust の `extern "C"` 関数で上書きし、その中から
//! `[super sendEvent:]` を呼ぶ。AppKit が投げた NSException がこのフレームを越えようと
//! すると、Rust は「panic in a function that cannot unwind」で abort する (v0.14.0 の
//! クラッシュレポートがこれだった)。普通の Cocoa アプリなら `-[NSApplication run]` が
//! 受け止めて報告するだけの例外である。
//!
//! 受け止めるのは `macos/exception_guard.m` (Objective-C の `@try`)。理由はそちらの冒頭。
//! 受け止めた例外は `~/Library/Logs/Astragal/exceptions.log` と Console.app に残る。

extern "C" {
    fn astragal_guard_send_event() -> bool;
}

/// NSApplication の `-sendEvent:` を例外を受け止める実装に差し替える。
/// イベントループが回り始める前に main スレッドから呼ぶ。
pub fn guard_send_event() {
    // SAFETY: 起動直後の main スレッドから呼ぶ。2 回目以降は何もしない。
    if !unsafe { astragal_guard_send_event() } {
        eprintln!("astragal: could not install the Objective-C exception guard");
    }
}
