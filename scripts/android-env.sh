# Environment for building Chesy's Android app. Source it, do not run it:
#
#   source scripts/android-env.sh
#   cd app && npm run tauri android build -- --apk --target aarch64
#
# Every variable here was needed to get a build through, and most of them
# fail in ways that do not name the missing variable:
#
#   * `llama-cpp-sys-2` looks for the NDK under ANDROID_NDK, then
#     ANDROID_NDK_ROOT, then NDK_ROOT. If none is usable its build script
#     panics with "Android NDK path does not exist:" and no path, and it
#     only runs when something forces it to rebuild, so a stale build
#     directory can hide the problem for several builds in a row.
#   * It defaults to API level 28 when ANDROID_API_LEVEL is unset, which
#     silently disagrees with the app's own minSdk of 24.
#   * The Tauri CLI wants NDK_HOME; Gradle wants ANDROID_HOME and a JDK.
#
# Iterating without reinstalling the APK
# -------------------------------------
# `npm run tauri android dev` installs once and then serves the frontend
# from Vite, so frontend edits hot-reload on the device and only Rust
# changes need a reinstall. Two things about it are not obvious:
#
#   * It takes no `--target`; that flag is `android build` only. The
#     device's architecture is detected. Passing it fails with an
#     unhelpful "unexpected argument" from npm's own parser.
#   * It serves on the machine's LAN address, not localhost, and
#     overrides TAURI_DEV_HOST to do so. The phone therefore reaches the
#     dev server over WiFi, which means the port has to be open:
#
#         sudo ufw allow 1420/tcp comment 'Chesy dev server'
#
#     Without that the WebView sits at about:blank and the app shows a
#     black screen, with nothing in the logs to say why.
#
# With no device connected it silently falls back to opening Android
# Studio, which is not installed here, so check `adb devices` first.

# Adjust these three paths if the toolchains live elsewhere.

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export JAVA_HOME="${JAVA_HOME:-$HOME/Android/jdk-17.0.20.1+1}"
_ndk="${ANDROID_NDK_HOME:-$HOME/Android/android-ndk-r27c}"

export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$_ndk"
export ANDROID_NDK="$_ndk"
export ANDROID_NDK_HOME="$_ndk"
export ANDROID_NDK_ROOT="$_ndk"
export NDK_ROOT="$_ndk"

# Match the app's minSdk (see gen/android/app/build.gradle.kts) rather
# than letting each build script pick its own default.
export ANDROID_API_LEVEL=24

export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

for _v in ANDROID_HOME JAVA_HOME ANDROID_NDK; do
  eval "_p=\$$_v"
  [ -d "$_p" ] || echo "warning: $_v='$_p' is not a directory" >&2
done
unset _ndk _v _p
