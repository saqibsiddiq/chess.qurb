//! Downloadable assets: the engine's neural networks today, the language
//! model's weights and language packs next.
//!
//! Everything here is *data*. Nothing downloaded can ever be executed on
//! Android — the only directory the system will run code from is the one
//! the installer writes, so the Stockfish binary and this Rust library
//! can only change through a new package. Keeping that line clear is why
//! this module deals in files and hashes and never in executables.
//!
//! The split matters for size: Stockfish's two networks are 107MB of the
//! 109MB engine. Built without them embedded the binary is 1.3MB and
//! searches identically once the networks are supplied at runtime, which
//! is what lets the app ship at a tenth of its previous size.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

/// Where the manifest lives. Assets themselves may be hosted anywhere the
/// manifest points; the large networks cannot live in the repository at
/// all, since they are over the 100MB per-file limit.
///
/// The Pages address rather than the chess.qurb.cloud custom domain,
/// which has no DNS record yet: every request to it failed to resolve, so
/// the app fell back to its bundled manifest on every launch and could
/// never have learned about a newer network. Pointing at the origin
/// GitHub serves keeps working once that domain is set up, because Pages
/// then redirects here to it and redirects are followed.
const MANIFEST_URL: &str = "https://saqibsiddiq.github.io/chess.qurb/assets/manifest.json";

/// One downloadable file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetSpec {
    /// Stable identifier the app refers to, e.g. `stockfish-net-big`.
    pub name: String,
    /// Opaque version string. A change here means "download it again".
    pub version: String,
    /// Filename on disk, inside the asset directory.
    pub file: String,
    pub url: String,
    /// Lowercase hex SHA-256 of the file's contents.
    pub sha256: String,
    pub bytes: u64,
    /// Whether the app can do its job without this. The engine cannot
    /// evaluate without its networks; a language pack is optional.
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub assets: Vec<AssetSpec>,
}

/// The manifest the app was built with.
///
/// Bundled so the app knows what it needs before it can reach the
/// network — otherwise a first launch offline could not even explain what
/// is missing. The published manifest overrides it when reachable, which
/// is what allows a newer network or model to arrive without an update.
const BUILTIN_MANIFEST: &str = include_str!("../assets-manifest.json");

/// What the app currently has on disk.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Installed {
    /// asset name -> installed version
    versions: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetState {
    pub name: String,
    pub version: String,
    pub bytes: u64,
    pub required: bool,
    /// Present on disk at the manifest's version.
    pub installed: bool,
    /// Present, but at a different version than the manifest asks for.
    pub outdated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub name: String,
    pub received: u64,
    pub total: u64,
}

/// The HTTPS client, built once and shared.
///
/// The trust roots are Mozilla's, compiled into the binary, rather than
/// the platform's. reqwest's rustls backend otherwise defaults to
/// `rustls-platform-verifier`, which on Android has to be handed a JNI
/// environment during startup or it panics on the first request:
///
///     thread 'tokio-rt-worker' panicked at rustls-platform-verifier:
///     Expect rustls-platform-verifier to be initialized
///
/// The panic killed the task without returning, so the download sat at
/// 0% forever instead of reporting an error. Tauri gives no convenient
/// hook for that initialisation, and bundled roots keep the TLS setup
/// identical on desktop and Android. The cost is that a new root
/// authority needs an app update, which for fetching our own published
/// assets is a fair trade.
fn https() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            // Named explicitly rather than via the process-wide default,
            // which is not installed anywhere in this app.
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
    // Temp-then-rename, so an interrupted write cannot leave a record
    // that disagrees with what is actually on disk.
    let tmp = installed_path(dir).with_extension("tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, installed_path(dir)).map_err(|e| e.to_string())
}

fn builtin_manifest() -> Manifest {
    serde_json::from_str(BUILTIN_MANIFEST).expect("bundled manifest is valid JSON")
}

/// The manifest to work from: the published one when reachable, otherwise
/// the bundled copy. A failed fetch is not an error — it just means the
/// app works from what it shipped knowing.
async fn current_manifest() -> Manifest {
    // A client that cannot even be built is not an error here: the
    // bundled manifest is the honest answer, same as an unreachable host.
    // Every fallback says why. This path is silent by design -- working
    // from the bundled copy is correct when the network is unavailable --
    // but silence also hid a manifest that was being fetched and then
    // discarded, which looked identical from outside to one that was
    // never fetched at all.
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

/// Path to an installed asset, or `None` if it is missing or the wrong
/// version. Used by the engine to decide whether it can start at all.
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
                // "Outdated" and "missing" are different things to a user:
                // one means a download will replace something that works,
                // the other means nothing works yet.
                outdated: !current && have.is_some(),
                name: spec.name,
                version: spec.version,
                bytes: spec.bytes,
                required: spec.required,
            }
        })
        .collect())
}

/// Downloads one asset, verifies it, and installs it.
///
/// Streams to a temporary file rather than buffering: the larger network
/// is over 100MB and holding that in memory on a phone would be its own
/// failure. The hash is checked before the file is put in place, so a
/// truncated or corrupted download can never be mistaken for a good one.
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

        // Roughly every half percent. Emitting per chunk would post
        // thousands of events for a 100MB file and cost more than the
        // download.
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
        // The app reads this before it can reach the network, so a typo
        // here would strand a first launch with nothing to say.
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
        // Guards the TLS setup: a bad crypto provider or protocol-version
        // combination only shows up when the client is constructed, and
        // the failure that motivated bundling roots at all was a runtime
        // panic on the very first request rather than a build error.
        assert!(https().is_ok(), "{:?}", https().err());
    }

    #[test]
    fn a_missing_record_reads_as_nothing_installed() {
        // Rather than failing: a fresh install has no record at all, and
        // that is the most common case this runs in.
        let dir = std::env::temp_dir().join("chesy-assets-does-not-exist");
        assert!(read_installed(&dir).versions.is_empty());
    }
}
