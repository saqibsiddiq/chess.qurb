use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{path::BaseDirectory, Emitter, Manager};

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

/// Picks which Stockfish executable to launch. An explicit `engine_path`
/// (e.g. a future settings UI) always wins. Otherwise, prefer the copy
/// bundled into the app as a resource (see src-tauri/binaries/README.md)
/// so a packaged build works without the user installing Stockfish
/// separately — falling back to a bare `stockfish` lookup on $PATH when
/// no bundled copy is present, which is what happens in `tauri dev`
/// (resources are only laid out on disk by a real `tauri build`).
fn resolve_engine_path(app: &tauri::AppHandle, engine_path: Option<String>) -> String {
    if let Some(path) = engine_path {
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
    fn start_with_path(path: Option<&str>) -> Result<Self, String> {
        let exe = path.unwrap_or("stockfish");
        let mut child = Command::new(exe)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!("Couldn't start Stockfish at '{exe}' — is it installed and accessible? ({e})")
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
        
        // Multi-threaded and hash allocation for fast desktop analysis
        let _ = session.send("setoption name Threads value 4");
        let _ = session.send("setoption name Hash value 64");

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
    let mut session = tauri::async_runtime::spawn_blocking(move || {
        let mut session = EngineSession::start_with_path(Some(&path))?;
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
            let mut session = EngineSession::start_with_path(Some(&path))?;
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
            storage::delete_review
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
