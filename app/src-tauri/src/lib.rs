use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use tauri::Emitter;

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
fn check_engine(engine_path: Option<String>) -> EngineInfo {
    let path = engine_path.unwrap_or_else(|| "stockfish".to_string());
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
fn analyze_position(fen: String, depth: u32, engine_path: Option<String>) -> Result<AnalysisResult, String> {
    let mut session = EngineSession::start_with_path(engine_path.as_deref())?;
    session.analyze(&fen, depth)
}

/// Analyzes a whole game's worth of positions using a single Stockfish
/// process and emits `review-progress` events per move.
#[tauri::command]
fn analyze_game(
    app: tauri::AppHandle,
    fens: Vec<String>,
    depth: u32,
    engine_path: Option<String>,
) -> Result<Vec<AnalysisResult>, String> {
    let mut session = EngineSession::start_with_path(engine_path.as_deref())?;
    // Always analyze full-game reviews with MultiPV=2: classification needs
    // the runner-up line to detect Great/Brilliant, and this is local,
    // unlimited-use software where the ~2x engine time is an acceptable
    // trade for classification accuracy.
    session.set_multipv(2)?;
    let total = fens.len();
    let mut results = Vec::with_capacity(total);

    for (index, fen) in fens.iter().enumerate() {
        let res = session.analyze(fen, depth)?;
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

    Ok(results)
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
