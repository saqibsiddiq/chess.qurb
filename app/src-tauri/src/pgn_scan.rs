use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::Manager;

const MAX_DEPTH: usize = 4;
const MAX_DIRS: usize = 4_000;
const MAX_RESULTS: usize = 120;
const MAX_INSPECT_BYTES: u64 = 8 * 1024 * 1024;
const HEADER_PEEK_BYTES: usize = 4096;

const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "build", "dist", "vendor", "venv", ".venv",
    "Library", "Applications", "AppData", "Program Files", "Windows",
    "snap", "flatpak", "Steam", "steamapps", ".cargo", ".rustup", ".npm",
    ".cache", ".git", ".svn", "site-packages", "__pycache__",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgnFile {
    pub path: String,
    pub name: String,
    pub folder: String,
    pub size: u64,
    pub modified: u64,
    pub games: Option<usize>,
    pub white: Option<String>,
    pub black: Option<String>,
    pub date: Option<String>,
}

fn should_skip(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(name))
}

fn is_pgn(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pgn"))
}

fn tag_value(header: &str, tag: &str) -> Option<String> {
    let needle = format!("[{tag} \"");
    let start = header.find(&needle)? + needle.len();
    let rest = &header[start..];
    let end = rest.find('"')?;
    let value = rest[..end].trim();
    if value.is_empty() || value == "?" {
        None
    } else {
        Some(value.to_string())
    }
}

fn count_games(contents: &str) -> usize {
    contents
        .lines()
        .filter(|line| line.trim_start().starts_with("[Event "))
        .count()
}

fn inspect(path: &Path, meta: &fs::Metadata) -> Option<PgnFile> {
    let size = meta.len();
    let modified = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let name = path.file_name()?.to_string_lossy().to_string();
    let folder = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut games = None;
    let mut white = None;
    let mut black = None;
    let mut date = None;

    if size <= MAX_INSPECT_BYTES {
        if let Ok(bytes) = fs::read(path) {
            let contents = String::from_utf8_lossy(&bytes);
            games = Some(count_games(&contents));

            let peek_end = contents
                .char_indices()
                .map(|(i, _)| i)
                .take_while(|i| *i < HEADER_PEEK_BYTES)
                .last()
                .unwrap_or(0);
            let header = &contents[..=peek_end.min(contents.len().saturating_sub(1))];

            white = tag_value(header, "White");
            black = tag_value(header, "Black");
            date = tag_value(header, "Date");
        }
    }

    Some(PgnFile {
        path: path.to_string_lossy().to_string(),
        name,
        folder,
        size,
        modified,
        games,
        white,
        black,
        date,
    })
}

fn walk(root: &Path, depth: usize, dirs_visited: &mut usize, out: &mut Vec<PgnFile>) {
    if depth > MAX_DEPTH || *dirs_visited >= MAX_DIRS || out.len() >= MAX_RESULTS {
        return;
    }
    *dirs_visited += 1;

    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    let mut subdirs = Vec::new();

    for entry in entries.flatten() {
        if out.len() >= MAX_RESULTS {
            return;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };

        if meta.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !should_skip(&name) {
                subdirs.push(path);
            }
        } else if meta.is_file() && is_pgn(&path) {
            if let Some(file) = inspect(&path, &meta) {
                out.push(file);
            }
        }
    }

    for dir in subdirs {
        walk(&dir, depth + 1, dirs_visited, out);
    }
}

#[tauri::command]
pub async fn scan_pgn_files(app: tauri::AppHandle) -> Vec<PgnFile> {
    let resolver = app.path();
    let mut roots: Vec<PathBuf> = Vec::new();
    roots.extend(resolver.download_dir().ok());
    roots.extend(resolver.document_dir().ok());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    roots.extend(resolver.desktop_dir().ok());

    roots.extend(resolver.home_dir().ok());

    let mut seen_roots = HashSet::new();
    let mut results: Vec<PgnFile> = Vec::new();
    let mut dirs_visited = 0usize;

    for root in roots {
        let key = root.canonicalize().unwrap_or_else(|_| root.clone());
        if !seen_roots.insert(key) {
            continue;
        }
        walk(&root, 0, &mut dirs_visited, &mut results);
    }

    let mut seen_paths = HashSet::new();
    results.retain(|f| seen_paths.insert(f.path.clone()));
    results.sort_by(|a, b| b.modified.cmp(&a.modified));
    results
}

#[tauri::command]
pub async fn read_pgn_file(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    if !is_pgn(&path) {
        return Err("That file is not a .pgn".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_one_game_per_event_tag() {
        let pgn = "[Event \"A\"]\n[Site \"x\"]\n\n1. e4 e5\n\n[Event \"B\"]\n\n1. d4 d5\n";
        assert_eq!(count_games(pgn), 2);
    }

    #[test]
    fn ignores_event_text_that_is_not_a_tag() {
        let pgn = "[Event \"A\"]\n\n1. e4 {commentary mentioning [Event \"B\"] inline} e5\n";
        assert_eq!(count_games(pgn), 1);
    }

    #[test]
    fn reads_player_tags_and_treats_question_mark_as_missing() {
        let header = "[Event \"A\"]\n[White \"sihku\"]\n[Black \"?\"]\n[Date \"2026.01.02\"]\n";
        assert_eq!(tag_value(header, "White").as_deref(), Some("sihku"));
        assert_eq!(tag_value(header, "Black"), None);
        assert_eq!(tag_value(header, "Date").as_deref(), Some("2026.01.02"));
    }

    #[test]
    fn skips_hidden_and_known_heavy_directories() {
        assert!(should_skip(".cache"));
        assert!(should_skip("node_modules"));
        assert!(should_skip("Library"));
        assert!(!should_skip("Downloads"));
        assert!(!should_skip("chess games"));
    }

    #[test]
    fn recognises_pgn_extension_case_insensitively() {
        assert!(is_pgn(Path::new("/tmp/game.pgn")));
        assert!(is_pgn(Path::new("/tmp/GAME.PGN")));
        assert!(!is_pgn(Path::new("/tmp/game.txt")));
        assert!(!is_pgn(Path::new("/tmp/pgn")));
    }
}
