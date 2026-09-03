# Bundled Stockfish binary

`tauri build` embeds whatever executable is at `binaries/stockfish` into
the app package as a resource, so end users don't need Stockfish
installed separately. This directory is gitignored (the binary is
~110MB and platform-specific) — populate it before building:

```bash
cp "$(which stockfish)" binaries/stockfish
chmod +x binaries/stockfish
```

**Known caveat (2026-08-30):** the binary currently used for local
builds is the Arch/pacman `stockfish` package, which is dynamically
linked against this system's glibc. That's fine for building and
running on this machine, but a binary built this way is not guaranteed
to run on another Linux distro with an older glibc. For a build meant
to be distributed broadly, use an official static Linux binary from
<https://github.com/official-stockfish/Stockfish/releases> instead —
same `cp`/`chmod` steps, just from that binary instead of the system
one.

## Android

Android cannot run the binary above, and not because of the architecture.
Since API 29 an app's data directory is mounted no-exec, so the usual
"unpack a helper binary and `chmod +x` it" approach fails on every current
phone. The only directory Android will execute from is the app's native
library directory, which is populated exclusively from `jniLibs` and only
with files named `lib*.so`.

Stockfish therefore ships to Android as `libstockfish.so` — an ordinary
ARM executable wearing a library's name. Nothing about the UCI protocol
changes; it is still spawned as a child process and driven over stdin and
stdout, exactly as on desktop. Only the path differs, and
`resolve_engine_path` in `../src/lib.rs` finds it by reading which file
the running process was mapped from (`/proc/self/maps`), which avoids a
JNI round-trip for `ApplicationInfo.nativeLibraryDir`.

Build it with:

```bash
source scripts/android-env.sh
scripts/build-stockfish-android.sh
```

`scripts/android-env.sh` exports the whole toolchain environment. It is
worth sourcing rather than setting `ANDROID_NDK_HOME` by hand, because the
Android build reads the NDK location from several different variables
depending on which build script is asking, and the failures do not name
the variable that was missing — `llama-cpp-sys-2` panics with "Android NDK
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
  every `tauri android init` — its changes are not permanent.
- **A cached build can hide a broken one.** `llama-cpp-sys-2` only reads
  the NDK environment when something forces it to recompile, so an APK can
  keep building successfully for a while after the environment has gone
  wrong, and then fail on the first change that triggers a full rebuild.
- **The result is about 113MB per ABI.** Stockfish embeds its two neural
  networks into the executable with `incbin`, and the larger one alone is
  108MB. The script builds `arm64-v8a` only by default for that reason.
  Stockfish also accepts `EvalFile`/`EvalFileSmall` as UCI options, so a
  future build could ship a stub net and load the real one from app
  storage instead — the same download-on-first-launch problem the model
  weights already have.
