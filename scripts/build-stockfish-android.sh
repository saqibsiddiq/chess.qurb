#!/usr/bin/env bash
#
# Cross-compiles Stockfish for Android and installs it into the Tauri
# Android project as a native library.
#
# Why a native library and not a plain binary: since API 29 an app's data
# directory is mounted no-exec, so the usual "unpack a helper binary and
# chmod +x" approach fails on any current phone. The one directory Android
# will execute from is the app's native library directory, and that is
# populated exclusively from `jniLibs` with files named `lib*.so`. The
# engine is therefore shipped as `libstockfish.so`, an ordinary ARM
# executable wearing a library's name. `resolve_engine_path` in
# src-tauri/src/lib.rs finds it again at runtime.
#
# This script has to be re-run after `tauri android init`, because
# `src-tauri/gen/` is gitignored and regenerated from scratch.
#
#   ANDROID_NDK_HOME=~/Android/Sdk/ndk/27.0.12077973 \
#     scripts/build-stockfish-android.sh
#
# Environment:
#   ANDROID_NDK_HOME  NDK location (also accepts ANDROID_NDK_ROOT/NDK_HOME)
#   ABIS              space-separated, default "arm64-v8a"
#   SF_SRC            an existing Stockfish source tree to build instead
#   SF_ZIP            a Stockfish source zip to unpack
#   MIN_SDK           Android API level to target, default 24

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
jni_root="$repo_root/app/src-tauri/gen/android/app/src/main/jniLibs"
gradle_file="$repo_root/app/src-tauri/gen/android/app/build.gradle.kts"
work="${SF_WORK:-$repo_root/.stockfish-android}"

ABIS="${ABIS:-arm64-v8a}"
MIN_SDK="${MIN_SDK:-24}"

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }

# ── The NDK ──────────────────────────────────────────────────────────
ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${NDK_HOME:-}}}"
if [ -z "$ndk" ] && [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk" ]; then
  # Highest installed version, so a machine with several NDKs builds with
  # the newest rather than whichever sorts first.
  ndk="$ANDROID_HOME/ndk/$(ls -1 "$ANDROID_HOME/ndk" | sort -V | tail -1)"
fi
[ -n "$ndk" ] || die "no NDK found. Set ANDROID_NDK_HOME to an Android NDK."
[ -d "$ndk" ] || die "ANDROID_NDK_HOME points at '$ndk', which does not exist."

toolchain="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin"
[ -d "$toolchain" ] || die "no linux-x86_64 toolchain under '$ndk'."
export PATH="$toolchain:$PATH"
note "NDK:      $ndk"

# ── The source ───────────────────────────────────────────────────────
mkdir -p "$work"
if [ -n "${SF_SRC:-}" ]; then
  src_root="$SF_SRC"
else
  zip="${SF_ZIP:-}"
  if [ -z "$zip" ]; then
    # The AUR package leaves a source zip and both NNUE nets behind after
    # a build, which is enough to work entirely offline.
    zip="$(ls -1 "$HOME"/.cache/paru/clone/stockfish/stockfish-*.zip 2>/dev/null | sort -V | tail -1 || true)"
  fi
  [ -n "$zip" ] || die "no Stockfish source. Set SF_SRC or SF_ZIP."
  [ -f "$zip" ] || die "SF_ZIP '$zip' does not exist."

  note "source:   $zip"
  rm -rf "$work/src-tree" && mkdir -p "$work/src-tree"
  unzip -q "$zip" -d "$work/src-tree"
  src_root="$(find "$work/src-tree" -maxdepth 1 -mindepth 1 -type d | head -1)"
fi
[ -f "$src_root/src/Makefile" ] || die "'$src_root' has no src/Makefile."

# ── The neural nets ──────────────────────────────────────────────────
# Stockfish embeds two networks into the binary with `incbin`, and they
# are 107MB of its 109MB. They are shipped as downloadable data instead,
# so what gets built here is placeholder-sized: 1.3MB of engine.
#
# Measured on a Galaxy S23: the stub build, given the real networks at
# runtime through the `EvalFile`/`EvalFileSmall` UCI options, searches
# *bit-identically* to the build that carries them inside it: 1,364,733
# nodes on both for `bench 16 1 12`.
#
# Set EMBED_NETS=1 for a self-contained 109MB binary that needs no
# download; the real networks must then be reachable, either in the
# source tree or over the network.
if [ "${EMBED_NETS:-0}" = "1" ]; then
  shopt -s nullglob
  for net in "$HOME"/.cache/paru/clone/stockfish/*.nnue "$work"/*.nnue; do
    [ -f "$src_root/src/$(basename "$net")" ] || cp "$net" "$src_root/src/"
  done
  shopt -u nullglob
else
  # 1KB placeholders in place of the real files. `incbin` only needs a
  # file to exist; the engine never reads the embedded copy because the
  # app always points it at the downloaded ones.
  for net in nn-c288c895ea92.nnue nn-37f18f62d772.nnue; do
    head -c 1024 /dev/zero > "$src_root/src/$net"
  done
  note "networks stubbed (set EMBED_NETS=1 to bundle them instead)"
fi

# ── Build, per ABI ───────────────────────────────────────────────────
for abi in $ABIS; do
  case "$abi" in
    arm64-v8a)   sf_arch=armv8; triple=aarch64-linux-android ;;
    armeabi-v7a) sf_arch=armv7; triple=armv7a-linux-androideabi ;;
    x86_64)      sf_arch=x86-64-modern; triple=x86_64-linux-android ;;
    *) die "unsupported ABI '$abi'." ;;
  esac

  cxx="$toolchain/${triple}${MIN_SDK}-clang++"
  [ -x "$cxx" ] || die "no compiler at '$cxx'. Is MIN_SDK=$MIN_SDK available in this NDK?"

  printf '\n==> %s (%s)\n' "$abi" "$sf_arch"
  make -C "$src_root/src" clean >/dev/null 2>&1 || true
  # `make all`, not `make build`. The `build` target depends on `net`,
  # which re-downloads the real networks and would silently overwrite the
  # placeholders. The binary came out at 109MB again the first time.
  if [ "${EMBED_NETS:-0}" = "1" ]; then
    make -C "$src_root/src" net ARCH="$sf_arch" COMP=ndk CXX="$cxx"
  fi
  # 16KB page alignment. Android 15 introduced 16KB-page devices and the
  # platform refuses to load, or warns loudly about, ELF objects whose
  # LOAD segments assume 4KB. NDK r27 can produce aligned output but does
  # not do it by default; r28 does. Without this the OS shows the user an
  # "app isn't 16 KB-compatible" dialog on launch.
  make -C "$src_root/src" -j"$(nproc)" all \
    ARCH="$sf_arch" COMP=ndk CXX="$cxx" STRIP="$toolchain/llvm-strip" \
    EXTRALDFLAGS="-Wl,-z,max-page-size=16384"

  out="$jni_root/$abi"
  mkdir -p "$out"
  cp "$src_root/src/stockfish" "$out/libstockfish.so"
  "$toolchain/llvm-strip" "$out/libstockfish.so" || true

  # A wrong-architecture binary installs silently and only fails on the
  # device, so confirm what actually landed.
  note "$(file -b "$out/libstockfish.so" | cut -c1-70)"
  note "size: $(du -h "$out/libstockfish.so" | cut -f1)"
done

# ── Packaging ────────────────────────────────────────────────────────
# Without legacy packaging the .so files are mapped straight out of the
# APK and never written to disk, so there is no file to execute. This is
# the single setting the whole approach depends on.
if [ -f "$gradle_file" ] && ! grep -q "useLegacyPackaging" "$gradle_file"; then
  python3 - "$gradle_file" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); t = p.read_text()
anchor = "    buildFeatures {"
addition = """    packaging {
        jniLibs {
            // Stockfish ships as libstockfish.so and is executed, not
            // loaded. Android only runs files that exist on disk, and
            // without legacy packaging the libraries stay compressed
            // inside the APK with no extracted copy to exec.
            useLegacyPackaging = true
        }
    }
"""
if anchor not in t:
    sys.exit("could not find the android {} block to patch")
p.write_text(t.replace(anchor, addition + anchor, 1))
print("  patched build.gradle.kts: useLegacyPackaging = true")
PY
else
  note "build.gradle.kts already sets useLegacyPackaging (or is absent)"
fi

printf '\ndone. Build the app with:  npm run tauri android build\n'
