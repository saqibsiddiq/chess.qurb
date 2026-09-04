use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

const MANIFEST_URL: &str = "https://saqibsiddiq.github.io/chess.qurb/assets/manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetSpec {
    pub name: String,
    pub version: String,
    pub file: String,
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub assets: Vec<AssetSpec>,
}

const BUILTIN_MANIFEST: &str = include_str!("../assets-manifest.json");

#[derive(Debug, Default, Serialize, Deserialize)]
struct Installed {
    versions: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetState {
    pub name: String,
    pub version: String,
    pub bytes: u64,
    pub required: bool,
    pub installed: bool,
    pub outdated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub name: String,
    pub received: u64,
    pub total: u64,
}

fn https() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let provider = std::sync::Arc::new(rustls::crypto::aws_lc_rs::default_provider());
            let config = rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|e| format!("Could not set up TLS: {e}"))?
                .with_root_certificates(roots)
                .with_no_client_auth();
            reqwest::Client::builder()
                .use_preconfigured_tls(config)
                .build()
                .map_err(|e| format!("Could not set up the network client: {e}"))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

fn asset_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No writable app directory: {e}"))?
        .join("assets");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn installed_path(dir: &Path) -> PathBuf {
    dir.join("installed.json")
}

fn read_installed(dir: &Path) -> Installed {
    std::fs::read_to_string(installed_path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_installed(dir: &Path, state: &Installed) -> Result<(), String> {
    let body = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let tmp = installed_path(dir).with_extension("tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, installed_path(dir)).map_err(|e| e.to_string())
}

fn builtin_manifest() -> Manifest {
    serde_json::from_str(BUILTIN_MANIFEST).expect("bundled manifest is valid JSON")
}

async fn current_manifest() -> Manifest {
    let client = match https() {
        Ok(client) => client,
        Err(e) => {
            eprintln!("chesy: no HTTP client, using bundled manifest: {e}");
            return builtin_manifest();
        }
    };
    match client.get(MANIFEST_URL).send().await {
        Ok(response) if response.status().is_success() => match response.text().await {
            Ok(body) => match serde_json::from_str::<Manifest>(&body) {
                Ok(manifest) => manifest,
                Err(e) => {
                    eprintln!("chesy: published manifest did not parse ({e}); body starts: {:.120}", body);
                    builtin_manifest()
                }
            },
            Err(e) => {
                eprintln!("chesy: could not read the published manifest: {e}");
                builtin_manifest()
            }
        },
        Ok(response) => {
            eprintln!("chesy: manifest fetch returned {}", response.status());
            builtin_manifest()
        }
        Err(e) => {
            eprintln!("chesy: manifest fetch failed: {e}");
            builtin_manifest()
        }
    }
}

pub fn installed_asset_path(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    let dir = asset_dir(app).ok()?;
    let manifest = builtin_manifest();
    let spec = manifest.assets.iter().find(|a| a.name == name)?;
    let state = read_installed(&dir);
    if state.versions.get(name).map(String::as_str) != Some(spec.version.as_str()) {
        return None;
    }
    let path = dir.join(&spec.file);
    path.exists().then_some(path)
}

#[tauri::command]
pub async fn asset_status(app: tauri::AppHandle) -> Result<Vec<AssetState>, String> {
    let dir = asset_dir(&app)?;
    let installed = read_installed(&dir);
    let manifest = current_manifest().await;

    Ok(manifest
        .assets
        .into_iter()
        .map(|spec| {
            let have = installed.versions.get(&spec.name);
            let on_disk = dir.join(&spec.file).exists();
            let current = have.map(String::as_str) == Some(spec.version.as_str()) && on_disk;
            AssetState {
                installed: current,
                outdated: !current && have.is_some(),
                name: spec.name,
                version: spec.version,
                bytes: spec.bytes,
                required: spec.required,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn download_asset(app: tauri::AppHandle, name: String) -> Result<(), String> {
    use futures_util::StreamExt;

    let dir = asset_dir(&app)?;
    let manifest = current_manifest().await;
    let spec = manifest
        .assets
        .into_iter()
        .find(|a| a.name == name)
        .ok_or_else(|| format!("No asset called '{name}'"))?;

    let response = https()?
        .get(&spec.url)
        .send()
        .await
        .map_err(|e| format!("Could not reach {}: {e}", spec.url))?;
    if !response.status().is_success() {
        return Err(format!("{} returned {}", spec.url, response.status()));
    }
    let total = response.content_length().unwrap_or(spec.bytes);

    let tmp = dir.join(format!("{}.part", spec.file));
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;

    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
        received += chunk.len() as u64;

        if received - last_emit > total / 200 + 1 {
            last_emit = received;
            let _ = app.emit(
                "asset-progress",
                DownloadProgress { name: spec.name.clone(), received, total },
            );
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    let digest = hex::encode(hasher.finalize());
    if !spec.sha256.is_empty() && digest != spec.sha256.to_lowercase() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!(
            "{} downloaded but its contents did not match what was expected.",
            spec.name
        ));
    }

    let final_path = dir.join(&spec.file);
    tokio::fs::rename(&tmp, &final_path)
        .await
        .map_err(|e| format!("Could not install {}: {e}", final_path.display()))?;

    let mut state = read_installed(&dir);
    state.versions.insert(spec.name.clone(), spec.version.clone());
    write_installed(&dir, &state)?;

    let _ = app.emit(
        "asset-progress",
        DownloadProgress { name: spec.name, received: total, total },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_manifest_parses_and_names_the_engine_networks() {
        let manifest = builtin_manifest();
        for wanted in ["stockfish-net-big", "stockfish-net-small"] {
            let spec = manifest.assets.iter().find(|a| a.name == wanted);
            assert!(spec.is_some(), "manifest is missing {wanted}");
            let spec = spec.unwrap();
            assert!(spec.required, "{wanted} must be marked required");
            assert!(!spec.sha256.is_empty(), "{wanted} needs a checksum");
            assert!(spec.bytes > 0, "{wanted} needs a size");
        }
    }

    #[test]
    fn installed_state_round_trips() {
        let dir = std::env::temp_dir().join(format!("chesy-assets-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut state = Installed::default();
        state.versions.insert("a".into(), "1".into());
        write_installed(&dir, &state).unwrap();
        assert_eq!(read_installed(&dir).versions.get("a").map(String::as_str), Some("1"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_https_client_builds() {
        assert!(https().is_ok(), "{:?}", https().err());
    }

    #[test]
    fn a_missing_record_reads_as_nothing_installed() {
        let dir = std::env::temp_dir().join("chesy-assets-does-not-exist");
        assert!(read_installed(&dir).versions.is_empty());
    }
}
