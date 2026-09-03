use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{path::BaseDirectory, Emitter, Manager};

mod assets;
mod correction;
mod pgn_scan;
mod slm;
mod storage;

/// Which review run is currently the live one. The frontend generates a
/// monotonically increasing id per run and passes it to `analyze_game`;
/// the analysis thread re-reads this between positions and stops as soon
/// as it no longer matches its own id.
///
/// Starting a review therefore implicitly cancels any earlier one — which
/// is the behaviour we want, since only one review is ever displayed.
/// Without this, a superseded run kept its Stockfish process alive at
/// full thread count until it had ground through every remaining
/// position: pure wasted CPU on desktop, and battery/thermal damage on a
/// phone. `cancel_review` stores 0 (no run ever uses 0) to stop
/// everything without starting a replacement.
#[derive(Default)]
struct ReviewControl {
    current_run: AtomicU64,
}

/// The name Stockfish is shipped under inside an Android package.
///
/// Android will only execute files from an app's native library
/// directory — since API 29 the data directory is mounted W^X, so the
/// usual "unpack a helper binary and chmod +x it" approach fails. The
/// library directory is populated exclusively from `jniLibs`, and only
/// with files matching `lib*.so`, so the engine has to travel under a
/// library's name even though it is an ordinary executable.
#[cfg(target_os = "android")]
const ANDROID_ENGINE_LIB: &str = "libstockfish.so";

/// The Rust library this very process is running from. Used to locate the
/// directory Android extracted it into.
#[cfg(target_os = "android")]
const ANDROID_SELF_LIB: &str = "libchesy_lib.so";

/// Finds the app's native library directory by asking which file the
/// current process was mapped from.
///
/// The alternative is a JNI round-trip for
/// `ApplicationInfo.nativeLibraryDir`, which needs a JavaVM handle and a
/// live Activity. This needs neither: our own code is executing from a
/// `.so` that Android already extracted into exactly that directory, so
/// the mapping tells us where it is.
///
/// Split from the file read so the parsing — the part that actually has
/// edge cases — can be tested on a real `/proc/self/maps` sample. It is
/// compiled on every platform for exactly that reason: the logic is pure
/// string handling, and gating it behind Android would mean it could only
/// ever be tested by building for a phone.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn native_library_dir_from_maps(maps: &str, self_lib: &str) -> Option<std::path::PathBuf> {
    let suffix = format!("/{self_lib}");
    for line in maps.lines() {
        // Every column before the path (address range, permissions,
        // offset, device, inode) is hex, letters, colons or dashes, so
        // the first slash on the line begins the backing file's path.
        let Some(start) = line.find('/') else { continue };
        let path = &line[start..];

        // `…/base.apk!/lib/arm64-v8a/libchesy_lib.so` means the library
        // was mapped straight out of the (uncompressed) APK and was never
        // written to disk as its own file. Nothing there can be executed,
        // and the engine will not have been extracted either — which is
        // why the packaging must keep legacy extraction turned on.
        if path.contains("!/") {
            continue;
        }
        if path.ends_with(&suffix) {
            return std::path::Path::new(path).parent().map(|p| p.to_path_buf());
        }
    }
    None
}

#[cfg(target_os = "android")]
fn android_engine_path() -> Option<String> {
    let maps = std::fs::read_to_string("/proc/self/maps").ok()?;
    let dir = native_library_dir_from_maps(&maps, ANDROID_SELF_LIB)?;
    let engine = dir.join(ANDROID_ENGINE_LIB);
    engine
        .exists()
        .then(|| engine.to_string_lossy().into_owned())
}

/// The engine's networks, as UCI options, if they have been downloaded.
fn engine_nets(app: &tauri::AppHandle) -> Vec<(String, String)> {
    [("EvalFile", "stockfish-net-big"), ("EvalFileSmall", "stockfish-net-small")]
        .into_iter()
        .filter_map(|(option, asset)| {
            assets::installed_asset_path(app, asset)
                .map(|p| (option.to_string(), p.to_string_lossy().into_owned()))
        })
        .collect()
}

/// How many search threads and how much hash to hand Stockfish.
///
/// Kept pure — no engine, no environment — so the policy can be tested
/// directly, since the alternative is only ever discovering it was wrong
/// on someone's phone.
///
/// The desktop numbers preserve the previous hard-coded 4 threads / 64MB
/// on any machine with at least four cores, and merely stop over-
/// subscribing a smaller one.
fn engine_budget(cores: usize, mobile: bool) -> (usize, usize) {
    if mobile {
        // Half the cores, capped at four. Measured on a Galaxy S23
        // (3x2.0GHz + 4x2.8GHz + 1x3.36GHz), running Stockfish 18's own
        // bench back to back to let the package heat up:
        //
        //   threads   first run   sixth run   drop
        //   2           820k nps    763k nps   -7%
        //   4         2,020k nps  1,418k nps  -30%
        //   8         2,525k nps  1,381k nps  -45%
        //
        // Eight threads wins on the first run and loses by the fourth:
        // saturating every core heats the SoC enough that sustained
        // throughput falls below what four threads hold, and a game
        // review is a sustained load, not a single search. Four is also
        // what leaves the WebView enough CPU to stay responsive while a
        // review runs — a review that pins every core is what "app not
        // responding" looked like. Throughput recovers fully after about
        // forty seconds idle, so this is throttling, not damage.
        let threads = (cores / 2).clamp(1, 4);
        // Hash shares a much smaller memory budget with the WebView and
        // the language model, and a transposition table that forces the
        // system to evict them costs far more than it saves.
        (threads, 32)
    } else {
        (cores.clamp(1, 4), 64)
    }
}

/// Picks which Stockfish executable to launch. An explicit `engine_path`
/// (e.g. a future settings UI) always wins. Otherwise, prefer the copy
/// bundled into the app as a resource (see src-tauri/binaries/README.md)
/// so a packaged build works without the user installing Stockfish
/// separately — falling back to a bare `stockfish` lookup on $PATH when
/// no bundled copy is present, which is what happens in `tauri dev`
/// (resources are only laid out on disk by a real `tauri build`).
///
/// Android takes a different route entirely: it has no $PATH worth
/// searching and cannot execute a bundled resource, so the engine ships
/// as a native library and is run from where the installer put it.
fn resolve_engine_path(app: &tauri::AppHandle, engine_path: Option<String>) -> String {
    if let Some(path) = engine_path {
        return path;
    }

    #[cfg(target_os = "android")]
    if let Some(path) = android_engine_path() {
        return path;
    }

    match app.path().resolve("binaries/stockfish", BaseDirectory::Resource) {
        Ok(resolved) if resolved.exists() => resolved.to_string_lossy().into_owned(),
        _ => "stockfish".to_string(),
    }
}

// Deserialize as well as Serialize: reviewed games are persisted (see
// storage.rs) and read back to reopen a review without re-running the
// engine, so this type round-trips rather than only being emitted.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub best_move: String,
    pub eval_cp: Option<i32>,
    pub eval_mate: Option<i32>,
    pub pv: Vec<String>,
    pub depth: u32,
    // Second-best line from a MultiPV=2 search (analyze_game() only). Used
    // to detect "only good move" (Great) / sacrifice (Brilliant) situations
    // client-side. Left None by analyze_position()/check_engine(), which
    // never enable MultiPV.
    pub second_move: Option<String>,
    pub second_eval_cp: Option<i32>,
    pub second_eval_mate: Option<i32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub available: bool,
    pub name: Option<String>,
    pub path: String,
    pub error: Option<String>,
}

/// Every review event carries the id of the run that produced it, so a
/// listener can reject events from a superseded run. Without this, a
/// stale run's `review-complete` would resolve the *current* run's
/// completion promise — silently unsubscribing it and leaving the review
/// frozen half-finished — and its `review-progress` payloads would be
/// written into the current game's analysis array at matching indices,
/// producing confidently wrong classifications for a different game.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReviewProgress {
    pub run_id: u64,
    pub index: usize,
    pub total: usize,
    pub result: AnalysisResult,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComplete {
    pub run_id: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReviewError {
    pub run_id: u64,
    pub message: String,
}

/// A running Stockfish process plus its UCI handshake state. Kept alive
/// across many `analyze()` calls instead of spawning a fresh process
/// per position.
struct EngineSession {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    engine_name: Option<String>,
}

impl EngineSession {
    /// UCI options naming the network files, in the order they should be
    /// sent. Empty when nothing has been downloaded yet, in which case
    /// the engine will start but cannot evaluate — `check_engine` is what
    /// turns that into a message the user sees.
    fn start_with_path(path: Option<&str>) -> Result<Self, String> {
        Self::start_with_nets(path, &[])
    }

    fn start_with_nets(path: Option<&str>, nets: &[(String, String)]) -> Result<Self, String> {
        let exe = path.unwrap_or("stockfish");
        let mut child = Command::new(exe)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| {
                // On Android there is no $PATH to install onto and no way
                // for the user to fix this themselves: either the engine
                // was packaged as a native library or it was not, so the
                // message points at the build rather than the device.
                if cfg!(target_os = "android") {
                    format!(
                        "Couldn't start the bundled Stockfish at '{exe}'. \
                         The engine ships as a native library, so this build \
                         is either missing it or was packaged without \
                         native-library extraction. ({e})"
                    )
                } else {
                    format!(
                        "Couldn't start Stockfish at '{exe}' — is it installed and accessible? ({e})"
                    )
                }
            })?;

        let stdin = child.stdin.take().ok_or("Failed to open Stockfish stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to open Stockfish stdout")?;
        let reader = BufReader::new(stdout);

        let mut session = EngineSession {
            child,
            stdin,
            reader,
            engine_name: None,
        };

        session.send("uci")?;
        let engine_name = session.wait_for_uci_ok()?;
        session.engine_name = engine_name;
        
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);
        let (threads, hash_mb) =
            engine_budget(cores, cfg!(any(target_os = "android", target_os = "ios")));
        let _ = session.send(&format!("setoption name Threads value {threads}"));
        let _ = session.send(&format!("setoption name Hash value {hash_mb}"));

        // The networks are shipped as downloadable data rather than
        // embedded, which is what takes the engine from 109MB to 1.3MB.
        // Measured: with these set, the search is bit-identical to the
        // build that carries them inside it.
        for (option, file) in nets {
            let _ = session.send(&format!("setoption name {option} value {file}"));
        }

        session.send("isready")?;
        session.wait_for("readyok")?;
        Ok(session)
    }

    fn send(&mut self, cmd: &str) -> Result<(), String> {
        writeln!(self.stdin, "{cmd}").map_err(|e| e.to_string())
    }

    /// Enables (or disables, with value 1) MultiPV. Used by analyze_game()
    /// so classification can compare the best line against the runner-up.
    fn set_multipv(&mut self, value: u32) -> Result<(), String> {
        self.send(&format!("setoption name MultiPV value {value}"))?;
        self.send("isready")?;
        self.wait_for("readyok")
    }

    fn wait_for_uci_ok(&mut self) -> Result<Option<String>, String> {
        let mut line = String::new();
        let mut engine_name = None;
        loop {
            line.clear();
            let bytes = self.reader.read_line(&mut line).map_err(|e| e.to_string())?;
            if bytes == 0 {
                return Err("Stockfish closed the connection before sending 'uciok'".to_string());
            }
            let trimmed = line.trim();
            if trimmed.starts_with("id name ") {
                engine_name = Some(trimmed.trim_start_matches("id name ").to_string());
            }
            if trimmed == "uciok" {
                return Ok(engine_name);
            }
        }
    }

    fn wait_for(&mut self, token: &str) -> Result<(), String> {
        let mut line = String::new();
        loop {
            line.clear();
            let bytes = self.reader.read_line(&mut line).map_err(|e| e.to_string())?;
            if bytes == 0 {
                return Err(format!(
                    "Stockfish closed the connection before sending '{token}'"
                ));
            }
            if line.trim() == token {
                return Ok(());
            }
        }
    }

    fn analyze(&mut self, fen: &str, depth: u32) -> Result<AnalysisResult, String> {
        self.send(&format!("position fen {fen}"))?;
        self.send(&format!("go depth {depth}"))?;

        // With MultiPV>1, Stockfish prints one "info ... multipv N ..." line
        // per line per depth. A single `last_info` slot would get silently
        // overwritten by whichever multipv index happens to arrive last —
        // routing by the `multipv` token keeps the best (multipv 1) and
        // runner-up (multipv 2) lines separate.
        let mut last_info_pv1: Option<String> = None;
        let mut last_info_pv2: Option<String> = None;
        let mut best_move = String::new();
        let mut line = String::new();

        loop {
            line.clear();
            let bytes = self.reader.read_line(&mut line).map_err(|e| e.to_string())?;
            if bytes == 0 {
                break;
            }
            let trimmed = line.trim();
            if trimmed.starts_with("info")
                && (trimmed.contains(" score cp ")
                    || trimmed.contains(" score mate ")
                    || trimmed.contains(" pv "))
            {
                let tokens: Vec<&str> = trimmed.split_whitespace().collect();
                match multipv_index(&tokens) {
                    2 => last_info_pv2 = Some(trimmed.to_string()),
                    _ => last_info_pv1 = Some(trimmed.to_string()),
                }
            } else if trimmed.starts_with("bestmove") {
                let raw_best = trimmed.split_whitespace().nth(1).unwrap_or("").to_string();
                if raw_best != "(none)" {
                    best_move = raw_best;
                }
                break;
            }
        }

        let mut result = last_info_pv1
            .map(|info| parse_info_line(&info, best_move.clone(), depth))
            .unwrap_or(AnalysisResult {
                best_move,
                eval_cp: None,
                eval_mate: None,
                pv: Vec::new(),
                depth,
                second_move: None,
                second_eval_cp: None,
                second_eval_mate: None,
            });

        if let Some(info2) = last_info_pv2 {
            let parsed2 = parse_info_line(&info2, String::new(), depth);
            result.second_move = parsed2.pv.first().cloned();
            result.second_eval_cp = parsed2.eval_cp;
            result.second_eval_mate = parsed2.eval_mate;
        }

        // Normalize to "positive = good for White".
        if fen.split_whitespace().nth(1) == Some("b") {
            result.eval_cp = result.eval_cp.map(|v| -v);
            result.eval_mate = result.eval_mate.map(|v| -v);
            result.second_eval_cp = result.second_eval_cp.map(|v| -v);
            result.second_eval_mate = result.second_eval_mate.map(|v| -v);
        }

        Ok(result)
    }
}

impl Drop for EngineSession {
    fn drop(&mut self) {
        let _ = self.send("quit");
        let _ = self.child.wait();
    }
}

/// Reads the `multipv N` token from an already-tokenized UCI `info` line.
/// Defaults to 1 when absent (some engines/modes omit it for single-PV output).
fn multipv_index(tokens: &[&str]) -> u32 {
    let mut i = 0;
    while i < tokens.len() {
        if tokens[i] == "multipv" {
            return tokens.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or(1);
        }
        i += 1;
    }
    1
}

fn parse_info_line(line: &str, best_move: String, depth: u32) -> AnalysisResult {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let mut eval_cp = None;
    let mut eval_mate = None;
    let mut pv = Vec::new();

    let mut i = 0;
    while i < tokens.len() {
        match tokens[i] {
            "score" => {
                if tokens.get(i + 1) == Some(&"cp") {
                    eval_cp = tokens.get(i + 2).and_then(|v| v.parse().ok());
                } else if tokens.get(i + 1) == Some(&"mate") {
                    eval_mate = tokens.get(i + 2).and_then(|v| v.parse().ok());
                }
            }
            "pv" => {
                pv = tokens[i + 1..].iter().map(|s| s.to_string()).collect();
                break;
            }
            _ => {}
        }
        i += 1;
    }

    AnalysisResult {
        best_move,
        eval_cp,
        eval_mate,
        pv,
        depth,
        second_move: None,
        second_eval_cp: None,
        second_eval_mate: None,
    }
}

/// Probes the engine to fill in the status pill. This spawns a real
/// Stockfish process and completes a UCI handshake just to read its name
/// — with a 113 MB binary and embedded NNUE networks that is genuine disk
/// and memory work, and it runs at startup while the user is looking at
/// the import screen.
///
/// It is `async` for that reason: Tauri gives no guarantee that a plain
/// synchronous command is scheduled off the thread servicing window and
/// IPC events, so the blocking handshake could stall first paint. The
/// work goes to `spawn_blocking` so it never occupies an async runtime
/// worker either. Same reasoning that moved the review loop onto its own
/// thread.
#[tauri::command]
async fn check_engine(app: tauri::AppHandle, engine_path: Option<String>) -> EngineInfo {
    let path = resolve_engine_path(&app, engine_path);
    let probe_path = path.clone();

    let probed = tauri::async_runtime::spawn_blocking(move || {
        EngineSession::start_with_path(Some(&probe_path))
            .map(|session| session.engine_name.clone())
    })
    .await;

    match probed {
        Ok(Ok(name)) => EngineInfo {
            available: true,
            name: name.or_else(|| Some("Stockfish Engine".to_string())),
            path,
            error: None,
        },
        Ok(Err(err)) => EngineInfo {
            available: false,
            name: None,
            path,
            error: Some(err),
        },
        Err(join_err) => EngineInfo {
            available: false,
            name: None,
            path,
            error: Some(format!("Engine probe failed to run: {join_err}")),
        },
    }
}

/// Analyzes a whole game's worth of positions using a single Stockfish
/// process and emits `review-progress` events per move.
///
/// The engine session is started (and awaited) before the analysis
/// thread is spawned, so a missing or broken Stockfish fails this command
/// immediately with a clear error rather than surfacing later as an
/// event — but it runs on a blocking-pool thread, since spawning the
/// process and completing the UCI handshake is real work and must not
/// stall the UI every time a review starts. The position-by-position loop
/// (which can easily take minutes for a long game, especially at
/// MultiPV=2) runs on its own dedicated OS thread instead of inside this
/// command handler — a long-running synchronous command previously froze
/// the whole window ("app not responding") for the duration of the
/// review, since nothing guarantees Tauri schedules a plain (non-async)
/// command off whatever thread services window/IPC events. Progress is
/// reported entirely via `review-progress` events plus a final
/// `review-complete` (success) or `review-error` (failure) event; this
/// command itself returns as soon as the thread is spawned.
#[tauri::command]
async fn analyze_game(
    app: tauri::AppHandle,
    fens: Vec<String>,
    depth: u32,
    engine_path: Option<String>,
    multi_pv: Option<u32>,
    run_id: u64,
) -> Result<(), String> {
    // Claiming the run before doing any engine work means an already-
    // running thread notices it has been superseded at its next position
    // boundary, even if this call goes on to fail below.
    app.state::<ReviewControl>()
        .current_run
        .store(run_id, Ordering::SeqCst);

    let path = resolve_engine_path(&app, engine_path);
    // Starting the session means spawning Stockfish and completing a UCI
    // handshake — blocking work that must not run on the thread servicing
    // window events, or the UI stalls every time a review starts. It
    // still happens *before* the analysis thread is spawned, so a
    // missing or broken engine fails this command immediately with a
    // clear error rather than surfacing later as a review-error event.
    // Resolved before the closure: `app` is needed again by the analysis
    // thread below, and the closure would otherwise take ownership of it.
    let nets = engine_nets(&app);
    let mut session = tauri::async_runtime::spawn_blocking(move || {
        let mut session = EngineSession::start_with_nets(Some(&path), &nets)?;
        // MultiPV=2 (the frontend's "Deep" mode) gives classification the
        // runner-up line needed to detect Great/Brilliant, at roughly 2x
        // engine time per position — an acceptable trade on desktop, but
        // not necessarily on weaker hardware. MultiPV=1 ("Fast" mode)
        // skips that cost; Great/Brilliant simply won't be detected in
        // that mode, which is an accepted tradeoff, not a bug.
        session.set_multipv(multi_pv.unwrap_or(2))?;
        Ok::<EngineSession, String>(session)
    })
    .await
    .map_err(|e| format!("Engine startup failed to run: {e}"))??;

    std::thread::spawn(move || {
        let total = fens.len();
        let control = app.state::<ReviewControl>();

        for (index, fen) in fens.iter().enumerate() {
            // Cancellation is checked between positions rather than mid-
            // search: `analyze()` blocks reading the engine's output, and
            // interrupting that would mean sharing stdin across threads.
            // Since every search here is depth-limited (never `go
            // infinite`), the worst-case latency is one position's search
            // — bounded and short — versus the whole remaining game
            // before this check existed. Dropping `session` on the way
            // out sends `quit`, so the process is reclaimed immediately.
            if control.current_run.load(Ordering::SeqCst) != run_id {
                return;
            }

            match session.analyze(fen, depth) {
                Ok(res) => {
                    // Re-check after the search too: a long one gives the
                    // user plenty of time to supersede this run, and
                    // emitting now would race a newer run's listeners.
                    if control.current_run.load(Ordering::SeqCst) != run_id {
                        return;
                    }
                    let _ = app.emit(
                        "review-progress",
                        ReviewProgress {
                            run_id,
                            index,
                            total,
                            result: res,
                        },
                    );
                }
                Err(err) => {
                    let _ = app.emit(
                        "review-error",
                        ReviewError {
                            run_id,
                            message: err,
                        },
                    );
                    return;
                }
            }
        }

        let _ = app.emit("review-complete", ReviewComplete { run_id });
    });

    Ok(())
}

/// Stops the active review without starting a replacement — used when the
/// user leaves the review screen entirely. Run ids are generated by the
/// frontend starting at 1, so 0 matches nothing and reliably invalidates
/// whatever is running.
#[tauri::command]
fn cancel_review(control: tauri::State<ReviewControl>) {
    control.current_run.store(0, Ordering::SeqCst);
}

/// A lazily-started, long-lived engine session used to judge one-off
/// positions in practice mode.
///
/// Kept separate from the review session for two reasons: a practice
/// evaluation must not disturb an in-flight review's MultiPV or search
/// state, and it must not pay a process spawn plus NNUE load on every
/// attempt — the first version of `analyze_position` did exactly that,
/// which is why it was removed rather than left in place.
#[derive(Default)]
struct PracticeEngine(std::sync::Mutex<Option<EngineSession>>);

/// Evaluates a single position — what the player's attempted move led to,
/// so practice mode can say how much it cost rather than only whether it
/// matched the engine's first choice.
#[tauri::command]
async fn evaluate_position(
    app: tauri::AppHandle,
    fen: String,
    depth: u32,
) -> Result<AnalysisResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_engine_path(&app, None);
        let engine = app.state::<PracticeEngine>();
        let mut slot = engine
            .0
            .lock()
            .map_err(|_| "Practice engine lock poisoned".to_string())?;

        if slot.is_none() {
            let mut session = EngineSession::start_with_nets(Some(&path), &engine_nets(&app))?;
            // Practice only ever needs the single best line; leaving
            // MultiPV at the engine default keeps each attempt cheap.
            session.set_multipv(1)?;
            *slot = Some(session);
        }

        let result = slot
            .as_mut()
            .expect("session was just ensured")
            .analyze(&fen, depth);

        // A dead pipe means the process went away (crash, OOM kill on a
        // phone). Drop it so the next attempt transparently starts a
        // fresh one instead of failing forever against a corpse.
        if result.is_err() {
            *slot = None;
        }
        result
    })
    .await
    .map_err(|e| format!("Position evaluation failed to run: {e}"))?
}

#[cfg(test)]
mod engine_budget_tests {
    use super::engine_budget;

    #[test]
    fn desktop_keeps_the_previous_four_threads_and_64mb() {
        // The behaviour this replaced was a hard-coded 4/64. Any machine
        // that could satisfy that before must still get it.
        assert_eq!(engine_budget(8, false), (4, 64));
        assert_eq!(engine_budget(16, false), (4, 64));
        assert_eq!(engine_budget(4, false), (4, 64));
    }

    #[test]
    fn desktop_stops_over_subscribing_a_small_machine() {
        assert_eq!(engine_budget(2, false), (2, 64));
        assert_eq!(engine_budget(1, false), (1, 64));
    }

    #[test]
    fn mobile_leaves_half_the_cores_for_everything_else() {
        // A Galaxy S23 reports 8; a mid-range phone 8 with far weaker
        // little cores; a low-end one 4.
        assert_eq!(engine_budget(8, true), (4, 32));
        assert_eq!(engine_budget(4, true), (2, 32));
    }

    #[test]
    fn mobile_never_asks_for_zero_threads() {
        // `cores / 2` is 0 for a single-core device, and Stockfish
        // rejects `Threads value 0`.
        assert_eq!(engine_budget(1, true), (1, 32));
    }

    #[test]
    fn mobile_is_always_at_most_desktop() {
        for cores in 1..=64 {
            let (m, mh) = engine_budget(cores, true);
            let (d, dh) = engine_budget(cores, false);
            assert!(m <= d, "{cores} cores: mobile {m} > desktop {d}");
            assert!(mh <= dh);
            assert!(m >= 1);
        }
    }
}

#[cfg(test)]
mod android_engine_path_tests {
    use super::native_library_dir_from_maps;

    /// Trimmed from a real `/proc/self/maps` on a Galaxy S23, keeping the
    /// shapes that actually occur: anonymous regions, bracketed pseudo
    /// files, a system library, and our own library in the app's native
    /// library directory.
    const MAPS: &str = "\
12c00000-12c40000 rw-p 00000000 00:00 0                                  [anon:dalvik-main space]
7f8a1c0000-7f8a1c4000 r--p 00000000 fd:03 1442  /apex/com.android.runtime/lib64/bionic/libc.so
7f8a200000-7f8a9c0000 r--p 00000000 fd:03 9931  /data/app/~~kQ3n==/io.github.saqibsiddiq.chesy-Ab9==/lib/arm64/libchesy_lib.so
7ff0a00000-7ff0a21000 rw-p 00000000 00:00 0                              [stack]
";

    #[test]
    fn finds_the_directory_our_own_library_was_mapped_from() {
        let dir = native_library_dir_from_maps(MAPS, "libchesy_lib.so").expect("should resolve");
        assert_eq!(
            dir.to_str().unwrap(),
            "/data/app/~~kQ3n==/io.github.saqibsiddiq.chesy-Ab9==/lib/arm64"
        );
    }

    #[test]
    fn ignores_a_library_mapped_out_of_the_apk() {
        // With native-library extraction disabled the library is mapped
        // from inside the APK and no executable file exists on disk.
        // Returning that path would produce a "not found" failure far from
        // the actual cause, so it must not match.
        let maps = "7f00-7f01 r--p 0 fd:03 9931  /data/app/~~x==/io.github.saqibsiddiq.chesy-y==/base.apk!/lib/arm64/libchesy_lib.so\n";
        assert!(native_library_dir_from_maps(maps, "libchesy_lib.so").is_none());
    }

    #[test]
    fn does_not_match_a_different_library_by_suffix() {
        // `libmychesy_lib.so` ends with our name as a plain substring; only
        // a whole final path segment counts.
        let maps = "7f00-7f01 r--p 0 fd:03 1  /data/app/x/lib/arm64/libmychesy_lib.so\n";
        assert!(native_library_dir_from_maps(maps, "libchesy_lib.so").is_none());
    }

    #[test]
    fn returns_none_when_nothing_matches() {
        let maps = "12c00000-12c40000 rw-p 00000000 00:00 0   [anon:dalvik-main space]\n";
        assert!(native_library_dir_from_maps(maps, "libchesy_lib.so").is_none());
    }
}

#[cfg(test)]
mod review_control_tests {
    use super::*;

    /// The exact check the analysis thread performs between positions.
    fn still_live(control: &ReviewControl, run_id: u64) -> bool {
        control.current_run.load(Ordering::SeqCst) == run_id
    }

    #[test]
    fn a_newer_run_supersedes_an_older_one() {
        let control = ReviewControl::default();

        control.current_run.store(1, Ordering::SeqCst);
        assert!(still_live(&control, 1), "run 1 should be live once claimed");

        // The user imports a different game; run 2 claims the slot.
        control.current_run.store(2, Ordering::SeqCst);
        assert!(!still_live(&control, 1), "run 1 must stop once superseded");
        assert!(still_live(&control, 2), "run 2 should now be the live one");
    }

    #[test]
    fn cancel_stops_everything_and_zero_is_never_a_real_run_id() {
        let control = ReviewControl::default();
        control.current_run.store(7, Ordering::SeqCst);

        control.current_run.store(0, Ordering::SeqCst); // what cancel_review does
        assert!(!still_live(&control, 7), "cancel must stop the active run");

        // 0 is the cancel sentinel precisely because the frontend's ids
        // start at 1 — if a run ever used 0 it would survive its own
        // cancellation. This asserts the sentinel can't collide.
        assert!(
            !still_live(&control, 1),
            "no live run may match after a cancel"
        );
    }

    #[test]
    fn a_fresh_control_has_no_live_run() {
        let control = ReviewControl::default();
        assert!(!still_live(&control, 1), "nothing should be live at startup");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Loaded once at startup (not lazily on first call) so a
            // broken/missing model fails visibly in logs immediately
            // rather than surprising the first user who requests an
            // explanation. A load error is stored, not fatal — move
            // explanations are supplementary, not core functionality,
            // so the rest of the app must keep working without them.
            let slm_state = slm::init(app.handle());
            if let Err(err) = &slm_state {
                eprintln!("SLM not available: {err}");
            }
            app.manage(slm_state);
            app.manage(ReviewControl::default());
            app.manage(storage::StorageLock::default());
            app.manage(PracticeEngine::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_engine,
            analyze_game,
            cancel_review,
            evaluate_position,
            pgn_scan::scan_pgn_files,
            pgn_scan::read_pgn_file,
            slm::explain_move,
            storage::list_reviews,
            storage::load_review,
            storage::save_review,
            storage::delete_review,
            assets::asset_status,
            assets::download_asset
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
