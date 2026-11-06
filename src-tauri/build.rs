fn main() {
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
