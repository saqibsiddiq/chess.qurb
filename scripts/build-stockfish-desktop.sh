#!/usr/bin/env bash
#
# Builds Stockfish for this machine and installs it as the bundled desktop
# engine at app/src-tauri/binaries/stockfish.
#
# The networks are left out, exactly as the Android build leaves them out.
# Stockfish embeds two NNUE networks that are 107MB of a 109MB binary; the
# app downloads them once at runtime and hands them to the engine through
# the EvalFile and EvalFileSmall UCI options. The engine searches
# identically either way, so the desktop package drops by roughly 110MB.
#
#   bash scripts/build-stockfish-desktop.sh
#
# Environment:
#   SF_ARCH   Stockfish ARCH, default x86-64-avx2. AVX2 covers Intel from
#             2013 and AMD from 2015. On an older CPU the binary dies with
#             an illegal instruction, so build x86-64-sse41-popcnt there.
#   SF_SRC    an existing Stockfish source tree to build instead
#   EMBED_NETS=1  bundle the networks after all, for a build that needs no
#                 download and is about 110MB larger
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="${SF_WORK:-$repo_root/.stockfish-android}"
out="$repo_root/app/src-tauri/binaries/stockfish"

SF_ARCH="${SF_ARCH:-x86-64-avx2}"

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }

src_root="${SF_SRC:-}"
if [ -z "$src_root" ]; then
  src_root="$(find "$work/src-tree" -maxdepth 1 -type d -name 'Stockfish-*' 2>/dev/null | head -1)"
fi
[ -n "$src_root" ] && [ -d "$src_root/src" ] || die "no Stockfish source tree; set SF_SRC, or run scripts/build-stockfish-android.sh first to fetch one"
note "source: $src_root"

if [ "${EMBED_NETS:-0}" = "1" ]; then
  make -C "$src_root/src" net ARCH="$SF_ARCH"
else
  # `incbin` only needs the files to exist. The engine never reads these
  # copies, because the app always points it at the downloaded ones.
  for net in nn-c288c895ea92.nnue nn-37f18f62d772.nnue; do
    head -c 1024 /dev/zero > "$src_root/src/$net"
  done
  note "networks stubbed (set EMBED_NETS=1 to bundle them instead)"
fi

make -C "$src_root/src" clean >/dev/null 2>&1 || true
# `all`, not `build`: the build target depends on `net`, which re-downloads
# the real networks over the placeholders and quietly restores the 109MB
# binary.
make -C "$src_root/src" -j"$(nproc)" all ARCH="$SF_ARCH" >/dev/null

mkdir -p "$(dirname "$out")"
install -m 0755 "$src_root/src/stockfish" "$out"
note "installed $(du -h "$out" | cut -f1) at binaries/stockfish"
file "$out" | cut -c1-100 | sed 's/^/  /'

printf '\ndone. Build the desktop app with:  cd app && npm run tauri build\n'
