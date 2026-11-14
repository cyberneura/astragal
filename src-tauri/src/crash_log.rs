//! 落ちた理由を後から読めるようにする。
//!
//! クラッシュレポートには Rust の panic のメッセージが残らない (Finder から起動したアプリの stderr は捨てられ、
//! Windows のリリース版は GUI サブシステムで stderr が無い。release は panic = "abort" で strip もしているので、
//! レポートのスタックも関数名を読めない)。panic hook でメッセージ・場所・バックトレースを `panic.log` に書く。
//! macOS では、AppKit がイベントの処理中に投げた例外を `objc_exception.rs` で受け止めて `exceptions.log` に書く。

use std::backtrace::Backtrace;
use std::fs::OpenOptions;
use std::io::Write;
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};

// これより大きくなったら書き直す (繰り返し panic してもディスクを埋めない)
const LOG_LIMIT_BYTES: u64 = 1024 * 1024;

#[cfg(target_os = "macos")]
fn log_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Library/Logs/Astragal"))
}

#[cfg(not(target_os = "macos"))]
fn log_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|dir| dir.join("Astragal").join("logs"))
}

/// イベントループが回り始める前に main スレッドから呼ぶ
pub fn install() {
    let dir = log_dir();
    if let Some(dir) = &dir {
        install_panic_hook(dir.join("panic.log"));
    }
    // tao が NSApplication を作る前でもよい (差し替えるのはクラスのメソッド)
    #[cfg(target_os = "macos")]
    crate::objc_exception::guard_send_event(dir.map(|d| d.join("exceptions.log")).as_deref());
}

fn install_panic_hook(path: PathBuf) {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let entry = panic_entry(info, &Backtrace::force_capture());
        let _ = append(&path, &entry, LOG_LIMIT_BYTES);
        default_hook(info);
    }));
}

fn panic_entry(info: &PanicHookInfo<'_>, backtrace: &Backtrace) -> String {
    let thread = std::thread::current();
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "unknown location".to_string());
    format!(
        "{} Astragal {} (thread {}): {}\n  at {}\n{}\n\n",
        timestamp(),
        env!("ASTRAGAL_VERSION"),
        thread.name().unwrap_or("<unnamed>"),
        info.payload_as_str().unwrap_or("<non-string panic payload>"),
        location,
        backtrace
    )
}

fn append(path: &Path, entry: &str, limit: u64) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let too_large = std::fs::metadata(path).map(|m| m.len() > limit).unwrap_or(false);
    let mut file = OpenOptions::new()
        .create(true)
        .append(!too_large)
        .write(true)
        .truncate(too_large)
        .open(path)?;
    file.write_all(entry.as_bytes())
}

#[cfg(unix)]
fn timestamp() -> String {
    // SAFETY: localtime_r と strftime には、ここで確保したバッファだけを渡す
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut tm).is_null() {
            return now.to_string();
        }
        let mut buf = [0u8; 64];
        let len = libc::strftime(buf.as_mut_ptr().cast(), buf.len(), c"%Y-%m-%d %H:%M:%S %z".as_ptr(), &tm);
        String::from_utf8_lossy(&buf[..len]).into_owned()
    }
}

#[cfg(not(unix))]
fn timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::append;

    fn temp_log(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("astragal-crash-log-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("nested").join("panic.log")
    }

    #[test]
    fn append_creates_the_directory_and_keeps_earlier_entries() {
        // Arrange
        let path = temp_log("append");

        // Act
        append(&path, "first\n", 1024).unwrap();
        append(&path, "second\n", 1024).unwrap();

        // Assert
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first\nsecond\n");
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn append_starts_over_once_the_file_exceeds_the_limit() {
        // Arrange
        let path = temp_log("limit");
        append(&path, "0123456789\n", 1024).unwrap();

        // Act
        append(&path, "kept\n", 4).unwrap();

        // Assert
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "kept\n");
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    const CHILD_ENV: &str = "ASTRAGAL_CRASH_LOG_CHILD";

    // panic hook はプロセス全体に効くので、別のプロセスで動かす (panic_hook_writes_the_message_and_location から起動する)
    #[test]
    #[ignore]
    fn panicking_child() {
        let Some(path) = std::env::var_os(CHILD_ENV) else {
            return;
        };
        super::install_panic_hook(path.into());
        panic!("boom {}", 42);
    }

    #[test]
    fn panic_hook_writes_the_message_and_location() {
        // Arrange
        let path = temp_log("hook");

        // Act
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash_log::tests::panicking_child", "--ignored", "--nocapture"])
            .env(CHILD_ENV, &path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();

        // Assert
        assert!(!status.success());
        let log = std::fs::read_to_string(&path).unwrap();
        // Windows では panic の場所が `src\crash_log.rs` になる
        let log = log.replace('\\', "/");
        assert!(log.contains(&format!("Astragal {} (thread", env!("ASTRAGAL_VERSION"))), "{log}");
        assert!(log.contains("): boom 42\n  at src/crash_log.rs:"), "{log}");
        assert!(log.contains("panicking_child"), "backtrace is missing: {log}");
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }
}
