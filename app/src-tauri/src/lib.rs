use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use tauri::{path::BaseDirectory, Emitter, Manager};

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

#[derive(Serialize, Clone)]
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReviewProgress {
    pub index: usize,
    pub total: usize,
    pub result: AnalysisResult,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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

#[tauri::command]
fn check_engine(app: tauri::AppHandle, engine_path: Option<String>) -> EngineInfo {
    let path = resolve_engine_path(&app, engine_path);
    match EngineSession::start_with_path(Some(&path)) {
        Ok(session) => EngineInfo {
            available: true,
            name: session.engine_name.clone().or_else(|| Some("Stockfish Engine".to_string())),
            path,
            error: None,
        },
        Err(err) => EngineInfo {
            available: false,
            name: None,
            path,
            error: Some(err),
        },
    }
}

#[tauri::command]
fn analyze_position(
    app: tauri::AppHandle,
    fen: String,
    depth: u32,
    engine_path: Option<String>,
) -> Result<AnalysisResult, String> {
    let path = resolve_engine_path(&app, engine_path);
    let mut session = EngineSession::start_with_path(Some(&path))?;
    session.analyze(&fen, depth)
}

/// Analyzes a whole game's worth of positions using a single Stockfish
/// process and emits `review-progress` events per move.
///
/// The engine session starts synchronously (fast — a UCI handshake, not
/// a real search) so a missing/broken Stockfish still fails immediately
/// with a clear error. The actual position-by-position analysis loop
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
fn analyze_game(
    app: tauri::AppHandle,
    fens: Vec<String>,
    depth: u32,
    engine_path: Option<String>,
    multi_pv: Option<u32>,
) -> Result<(), String> {
    let path = resolve_engine_path(&app, engine_path);
    let mut session = EngineSession::start_with_path(Some(&path))?;
    // MultiPV=2 (the frontend's "Deep" mode) gives classification the
    // runner-up line needed to detect Great/Brilliant, at roughly 2x engine
    // time per position — an acceptable trade on desktop, but not
    // necessarily on weaker hardware. MultiPV=1 ("Fast" mode) skips that
    // cost; Great/Brilliant simply won't be detected in that mode, which is
    // an accepted tradeoff, not a bug.
    session.set_multipv(multi_pv.unwrap_or(2))?;

    std::thread::spawn(move || {
        let total = fens.len();
        let mut results = Vec::with_capacity(total);

        for (index, fen) in fens.iter().enumerate() {
            match session.analyze(fen, depth) {
                Ok(res) => {
                    let _ = app.emit(
                        "review-progress",
                        ReviewProgress {
                            index,
                            total,
                            result: res.clone(),
                        },
                    );
                    results.push(res);
                }
                Err(err) => {
                    let _ = app.emit("review-error", err);
                    return;
                }
            }
        }

        let _ = app.emit("review-complete", results);
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            check_engine,
            analyze_position,
            analyze_game
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
