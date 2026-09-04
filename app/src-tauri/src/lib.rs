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

#[derive(Default)]
struct ReviewControl {
    current_run: AtomicU64,
}

#[cfg(target_os = "android")]
const ANDROID_ENGINE_LIB: &str = "libstockfish.so";

#[cfg(target_os = "android")]
const ANDROID_SELF_LIB: &str = "libchesy_lib.so";

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn native_library_dir_from_maps(maps: &str, self_lib: &str) -> Option<std::path::PathBuf> {
    let suffix = format!("/{self_lib}");
    for line in maps.lines() {
        let Some(start) = line.find('/') else { continue };
        let path = &line[start..];

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

fn engine_nets(app: &tauri::AppHandle) -> Vec<(String, String)> {
    [("EvalFile", "stockfish-net-big"), ("EvalFileSmall", "stockfish-net-small")]
        .into_iter()
        .filter_map(|(option, asset)| {
            assets::installed_asset_path(app, asset)
                .map(|p| (option.to_string(), p.to_string_lossy().into_owned()))
        })
        .collect()
}

fn engine_budget(cores: usize, mobile: bool) -> (usize, usize) {
    if mobile {
        let threads = (cores / 2).clamp(1, 4);
        (threads, 32)
    } else {
        (cores.clamp(1, 4), 64)
    }
}

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

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub best_move: String,
    pub eval_cp: Option<i32>,
    pub eval_mate: Option<i32>,
    pub pv: Vec<String>,
    pub depth: u32,
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

struct EngineSession {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    engine_name: Option<String>,
}

impl EngineSession {
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
                if cfg!(target_os = "android") {
                    format!(
                        "Couldn't start the bundled Stockfish at '{exe}'. \
                         The engine ships as a native library, so this build \
                         is either missing it or was packaged without \
                         native-library extraction. ({e})"
                    )
                } else {
                    format!(
                        "Couldn't start Stockfish at '{exe}'. Is it installed and accessible? ({e})"
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

#[tauri::command]
async fn analyze_game(
    app: tauri::AppHandle,
    fens: Vec<String>,
    depth: u32,
    engine_path: Option<String>,
    multi_pv: Option<u32>,
    run_id: u64,
) -> Result<(), String> {
    app.state::<ReviewControl>()
        .current_run
        .store(run_id, Ordering::SeqCst);

    let path = resolve_engine_path(&app, engine_path);
    let nets = engine_nets(&app);
    let mut session = tauri::async_runtime::spawn_blocking(move || {
        let mut session = EngineSession::start_with_nets(Some(&path), &nets)?;
        session.set_multipv(multi_pv.unwrap_or(2))?;
        Ok::<EngineSession, String>(session)
    })
    .await
    .map_err(|e| format!("Engine startup failed to run: {e}"))??;

    std::thread::spawn(move || {
        let total = fens.len();
        let control = app.state::<ReviewControl>();

        for (index, fen) in fens.iter().enumerate() {
            if control.current_run.load(Ordering::SeqCst) != run_id {
                return;
            }

            match session.analyze(fen, depth) {
                Ok(res) => {
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

#[tauri::command]
fn cancel_review(control: tauri::State<ReviewControl>) {
    control.current_run.store(0, Ordering::SeqCst);
}

#[derive(Default)]
struct PracticeEngine(std::sync::Mutex<Option<EngineSession>>);

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
            session.set_multipv(1)?;
            *slot = Some(session);
        }

        let result = slot
            .as_mut()
            .expect("session was just ensured")
            .analyze(&fen, depth);

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
        assert_eq!(engine_budget(8, true), (4, 32));
        assert_eq!(engine_budget(4, true), (2, 32));
    }

    #[test]
    fn mobile_never_asks_for_zero_threads() {
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
        let maps = "7f00-7f01 r--p 0 fd:03 9931  /data/app/~~x==/io.github.saqibsiddiq.chesy-y==/base.apk!/lib/arm64/libchesy_lib.so\n";
        assert!(native_library_dir_from_maps(maps, "libchesy_lib.so").is_none());
    }

    #[test]
    fn does_not_match_a_different_library_by_suffix() {
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

    fn still_live(control: &ReviewControl, run_id: u64) -> bool {
        control.current_run.load(Ordering::SeqCst) == run_id
    }

    #[test]
    fn a_newer_run_supersedes_an_older_one() {
        let control = ReviewControl::default();

        control.current_run.store(1, Ordering::SeqCst);
        assert!(still_live(&control, 1), "run 1 should be live once claimed");

        control.current_run.store(2, Ordering::SeqCst);
        assert!(!still_live(&control, 1), "run 1 must stop once superseded");
        assert!(still_live(&control, 2), "run 2 should now be the live one");
    }

    #[test]
    fn cancel_stops_everything_and_zero_is_never_a_real_run_id() {
        let control = ReviewControl::default();
        control.current_run.store(7, Ordering::SeqCst);

        control.current_run.store(0, Ordering::SeqCst);
        assert!(!still_live(&control, 7), "cancel must stop the active run");

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
