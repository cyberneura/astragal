use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // About に出すビルド日時 (CYBERNEURA-DEV-1214、beckwell の CYBERNEURA-DEV-1143 と同じ)。UTC で埋め込む。
    // SOURCE_DATE_EPOCH があればそれを使う (再現可能なビルドの慣習)
    let epoch = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        });
    println!("cargo:rustc-env=ASTRAGAL_BUILD_DATE={}", format_utc(epoch));
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    // tauri-build は設定ファイルなどにだけ rerun-if-changed を出すので、そのままだとソースだけを
    // 変えたビルドで build.rs が再実行されず、古い日時が残る。存在しないパスを指定して毎回実行させる
    println!("cargo:rerun-if-changed=build-date.always-rerun");

    // panic.log に書く版 (`crash_log.rs`)。version の正本は tauri.conf.json で、Cargo.toml の version は上げていない
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rustc-env=ASTRAGAL_VERSION={}", app_version());

    // `objc_exception.rs` が呼ぶ。target は build script の実行環境ではなく
    // ビルド対象で判定する (universal ビルドは aarch64 / x86_64 をそれぞれ作る)
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/macos/exception_guard.m");
        cc::Build::new()
            .file("src/macos/exception_guard.m")
            .flag("-fobjc-exceptions")
            .compile("astragal_exception_guard");
        println!("cargo:rustc-link-lib=framework=AppKit");
    }
    tauri_build::build()
}

// Unix 時刻を "YYYY-MM-DD HH:MM UTC" にする (日付の計算は Howard Hinnant の civil_from_days)
fn format_utc(epoch: u64) -> String {
    let days = (epoch / 86_400) as i64;
    let seconds = epoch % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02} UTC",
        seconds / 3_600,
        seconds % 3_600 / 60
    )
}

// tauri.conf.json のトップレベルの "version" (build-dependencies に JSON のパーサーを足さずに読む)
fn app_version() -> String {
    let config = std::fs::read_to_string("tauri.conf.json").expect("tauri.conf.json is readable");
    config
        .lines()
        .find_map(|line| {
            let value = line.trim().strip_prefix("\"version\":")?.trim();
            Some(value.trim_end_matches(',').trim_matches('"').to_string())
        })
        .expect("tauri.conf.json has a version")
}
