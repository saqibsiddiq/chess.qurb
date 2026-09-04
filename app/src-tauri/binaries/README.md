# Bundled Stockfish binary

`tauri build` embeds whatever executable is at `binaries/stockfish` into
the desktop package as a resource, so users do not need Stockfish
installed separately. `resolve_engine_path` in `../src/lib.rs` finds it
again at runtime and falls back to `stockfish` on `$PATH` when it is
absent. This directory is gitignored, so populate it before building:

```bash
bash scripts/build-stockfish-desktop.sh
```

That produces a binary of about 900KB rather than 110MB, because it leaves
the neural networks out. Stockfish embeds two of them with `incbin` and
they are 107MB of the 109MB total. The app downloads them once at runtime
and passes them back through the `EvalFile` and `EvalFileSmall` UCI
options, which is exactly equivalent: `bench 16 1 12` returns 1,364,733
nodes whether the networks are compiled in or supplied at startup.

`EMBED_NETS=1` bundles them after all, for a package that needs no
download.

Two things to know before distributing a build made this way:

- **It is linked against this machine's glibc and libstdc++**, so it is
  not guaranteed to start on a distribution with older versions. For a
  build meant to travel, prefer an official static Linux binary from
  <https://github.com/official-stockfish/Stockfish/releases>, or build in
  a container with an older toolchain.
- **The default `SF_ARCH` is `x86-64-avx2`**, which covers Intel from 2013
  and AMD from 2015. On an older CPU the binary dies with an illegal
  instruction, so build those with `SF_ARCH=x86-64-sse41-popcnt`.

## Android

Android cannot run the binary above, and not because of the architecture.
Since API 29 an app's data directory is mounted no-exec, so the usual
"unpack a helper binary and `chmod +x` it" approach fails on every current
phone. The only directory Android will execute from is the app's native
library directory, which is populated exclusively from `jniLibs` and only
with files named `lib*.so`.

Stockfish therefore ships to Android as `libstockfish.so`, an ordinary ARM
executable wearing a library's name. Nothing about the UCI protocol
changes; it is still spawned as a child process and driven over stdin and
stdout, exactly as on desktop. Only the path differs, and
`resolve_engine_path` finds it by reading which file the running process
was mapped from (`/proc/self/maps`), which avoids a JNI round-trip for
`ApplicationInfo.nativeLibraryDir`.

Build it with:

```bash
source scripts/android-env.sh
bash scripts/build-stockfish-android.sh
```

`scripts/android-env.sh` exports the whole toolchain environment. It is
worth sourcing rather than setting `ANDROID_NDK_HOME` by hand, because the
Android build reads the NDK location from several different variables
depending on which build script is asking, and the failures do not name
the variable that was missing: `llama-cpp-sys-2` panics with "Android NDK
path does not exist:" and no path at all. That script also pins
`ANDROID_API_LEVEL` to the app's own `minSdk`, which those build scripts
otherwise default to 28.

The script cross-compiles Stockfish, installs it into `jniLibs/`, and
patches the generated Gradle project to keep **legacy JNI packaging**
turned on. That last part is not optional: without it the libraries are
mapped straight out of the APK and never written to disk, so there is no
file to execute.

Three things to know before running it:

- **`src-tauri/gen/` is gitignored**, so the script has to be re-run after
  every `tauri android init`. Its changes are not permanent.
- **A cached build can hide a broken one.** `llama-cpp-sys-2` only reads
  the NDK environment when something forces it to recompile, so an APK can
  keep building successfully for a while after the environment has gone
  wrong, and then fail on the first change that triggers a full rebuild.
- **The result is about 1.3MB per ABI**, for the same reason the desktop
  binary is small: the networks are downloaded rather than embedded. The
  script builds `arm64-v8a` only by default.
