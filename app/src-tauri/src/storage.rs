use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::AnalysisResult;

const MAX_STORED_REVIEWS: usize = 500;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSummary {
    pub id: String,
    pub saved_at: i64,
    pub white: String,
    pub black: String,
    pub result: String,
    pub date: String,
    pub move_count: usize,
    pub white_accuracy: f64,
    pub black_accuracy: f64,
    #[serde(default)]
    pub white_counts: HashMap<String, u32>,
    #[serde(default)]
    pub black_counts: HashMap<String, u32>,
    #[serde(default)]
    pub white_motifs: HashMap<String, u32>,
    #[serde(default)]
    pub black_motifs: HashMap<String, u32>,
    #[serde(default)]
    pub opening: Option<String>,
    #[serde(default)]
    pub eco: Option<String>,
    #[serde(default)]
    pub book_exit_ply: Option<usize>,
    #[serde(default)]
    pub termination: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StoredReview {
    pub summary: ReviewSummary,
    pub pgn: String,
    pub analysis: Vec<AnalysisResult>,
    pub depth: u32,
    pub multi_pv: u32,
}

#[derive(Default)]
pub struct StorageLock(Mutex<()>);

fn reviews_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Couldn't locate the app data directory: {e}"))?
        .join("reviews");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(reviews_dir(app)?.join("index.json"))
}

fn is_valid_review_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn game_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if !is_valid_review_id(id) {
        return Err(format!("Refusing to use {id:?} as a review id"));
    }
    Ok(reviews_dir(app)?.join(format!("{id}.json")))
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("Couldn't finalize {}: {e}", path.display()))?;
    Ok(())
}

fn read_index(app: &tauri::AppHandle) -> Vec<ReviewSummary> {
    let Ok(path) = index_path(app) else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

#[tauri::command]
pub fn list_reviews(app: tauri::AppHandle) -> Vec<ReviewSummary> {
    let mut index = read_index(&app);
    index.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    index
}

#[tauri::command]
pub fn load_review(app: tauri::AppHandle, id: String) -> Result<StoredReview, String> {
    let path = game_path(&app, &id)?;
    let raw = fs::read_to_string(&path)
        .map_err(|_| "That saved review is no longer available.".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("That saved review couldn't be read: {e}"))
}

#[tauri::command]
pub fn save_review(
    app: tauri::AppHandle,
    lock: tauri::State<StorageLock>,
    review: StoredReview,
) -> Result<(), String> {
    let _guard = lock.0.lock().map_err(|_| "Storage lock poisoned".to_string())?;

    let path = game_path(&app, &review.summary.id)?;
    let body = serde_json::to_string(&review).map_err(|e| e.to_string())?;
    write_atomic(&path, &body)?;

    let mut index = read_index(&app);
    index.retain(|s| s.id != review.summary.id);
    index.push(review.summary);
    index.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));

    if index.len() > MAX_STORED_REVIEWS {
        for pruned in index.split_off(MAX_STORED_REVIEWS) {
            if let Ok(p) = game_path(&app, &pruned.id) {
                let _ = fs::remove_file(p);
            }
        }
    }

    let index_body = serde_json::to_string(&index).map_err(|e| e.to_string())?;
    write_atomic(&index_path(&app)?, &index_body)
}

#[tauri::command]
pub fn delete_review(
    app: tauri::AppHandle,
    lock: tauri::State<StorageLock>,
    id: String,
) -> Result<(), String> {
    let _guard = lock.0.lock().map_err(|_| "Storage lock poisoned".to_string())?;

    let path = game_path(&app, &id)?;
    let _ = fs::remove_file(path);

    let mut index = read_index(&app);
    index.retain(|s| s.id != id);
    let index_body = serde_json::to_string(&index).map_err(|e| e.to_string())?;
    write_atomic(&index_path(&app)?, &index_body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ids_that_could_escape_the_reviews_directory() {
        for id in [
            "../secret",
            "a/b",
            "..",
            "",
            "with space",
            "semi;colon",
            "back\\slash",
            "null\0byte",
            "dot.dot",
        ] {
            assert!(
                !is_valid_review_id(id),
                "{id:?} should be rejected as a review id"
            );
        }
    }

    #[test]
    fn accepts_content_hash_ids() {
        for id in ["a1b2c3d4", "0", "abc-123", "deadbeefcafe0123"] {
            assert!(
                is_valid_review_id(id),
                "{id:?} should be accepted as a review id"
            );
        }
    }
}
