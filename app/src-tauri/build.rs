fn main() {
    // 16KB page alignment for Android.
    //
    // Android 15 introduced devices with 16KB memory pages, and the
    // platform shows the user an "app isn't 16 KB-compatible" dialog when
    // a shipped native library's LOAD segments are aligned for 4KB pages.
    // NDK r27 can emit aligned objects but does not by default (r28 does),
    // and Rust links through its own driver invocation, so the flag has to
    // be added here.
    //
    // This lives in build.rs rather than `.cargo/config.toml` because the
    // Tauri CLI exports RUSTFLAGS when it builds for Android, and an
    // environment RUSTFLAGS silently replaces the config-file `rustflags`
    // key wholesale — the config version linked and produced a 4KB-aligned
    // library with no warning at all. A `cargo:rustc-link-arg` is applied
    // on top of whatever RUSTFLAGS say instead of competing with them.
    //
    // Stockfish gets the same flag from scripts/build-stockfish-android.sh.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
    }

    tauri_build::build()
}
