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
