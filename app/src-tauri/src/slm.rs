//! On-device move-explanation generation via a small fine-tuned language
//! model (SmolLM2-135M + LoRA, merged and quantized to GGUF — see
//! `models/README.md`), run through llama.cpp's C API directly (no
//! subprocess) so the same code path works on desktop and, eventually,
//! mobile — subprocess spawning is not reliably available on Android,
//! which is exactly why Stockfish needs a separate mobile story too.
//!
//! The model is loaded once at startup on a single dedicated worker
//! thread, which owns one long-lived `LlamaContext` for the app's whole
//! lifetime instead of creating a fresh one per call. That matters: a
//! fresh `LlamaContext` isn't just a cheap KV-cache allocation — creating
//! one does real compute-graph reservation work every time (visible as
//! `sched_reserve`/`graph_reserve` logging on every call) — and repeating
//! that on every move navigation was the main source of UI jitter found
//! when this first shipped as "recreate a context per call." Reusing one
//! context (reset between generations via `clear_kv_cache()`) removes
//! that repeated setup cost entirely.
//!
//! Generation is strictly on-demand: the frontend calls `explain_move`
//! only when the user explicitly asks to "explain this move in depth,"
//! never automatically during review and never eagerly for the whole
//! game. An earlier version fired requests for every move in the
//! background as it was classified, which caused real "app not
//! responding" freezes — the SLM's worker threads competing with
//! Stockfish's own search threads for CPU during the live review (see
//! project memory, 2026-09-01). The always-instant rule-based
//! explanation (`app/src/lib/explanations.ts`) is the default shown for
//! every move; the SLM is an opt-in deep-dive layered on top.

use std::num::NonZeroU32;
use std::path::Path;
use std::sync::mpsc;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use serde::Deserialize;
use tauri::{path::BaseDirectory, Manager};

use crate::correction::correct_explanation;

const SYSTEM_PROMPT: &str = "You are a chess coach explaining one move to a human player. Use only the supplied facts. Do not invent tactical claims or variations. Explain the key chess idea, why the move was good or bad, and what the best move improves when one is supplied. Be concise and instructional.";
const MAX_NEW_TOKENS: usize = 80;
const N_CTX: u32 = 1024;
// A tiny 135M model gets little benefit from many threads, and the
// worker runs concurrently with Stockfish's own 4 search threads during
// a review — kept deliberately low so background generation doesn't
// starve everything else on the machine, midrange phones included.
const N_THREADS: i32 = 2;

/// Every fact the model (and the deterministic correction pass) needs for
/// one move, mirroring the structured `input` rows the model was trained
/// on (see `ml/data/preparation/build_sft_dataset.py`).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MoveFacts {
    pub fen: String,
    pub color: String,
    pub move_number: u32,
    pub played_move: String,
    pub best_move: String,
    pub eval_before_cp: Option<i32>,
    pub eval_before_mate: Option<i32>,
    pub eval_after_cp: Option<i32>,
    pub eval_after_mate: Option<i32>,
    pub loss_cp: Option<f64>,
    pub classification: String,
    pub motif: String,
    pub motif_detail: Option<serde_json::Value>,
}

fn opt_i32(v: Option<i32>) -> String {
    v.map_or_else(|| "None".to_string(), |n| n.to_string())
}

/// Renders a JSON value the way Python's `json.dumps` (default separators)
/// would — serde_json's compact output omits the spaces after `:`/`,`
/// that the training prompts always have. Safe here because motif_detail
/// only ever holds chess square/piece vocabulary, never characters that
/// would collide with this substitution.
fn python_style_json(value: &serde_json::Value) -> String {
    let compact = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
    compact.replace(':', ": ").replace(',', ", ")
}

/// Builds the exact user-turn text the model was trained on.
fn build_user_prompt(facts: &MoveFacts) -> String {
    let motif_detail = facts
        .motif_detail
        .as_ref()
        .map(python_style_json)
        .unwrap_or_else(|| "{}".to_string());

    format!(
        "FEN: {}\nColor: {}\nMove number: {}\nPlayed move: {}\nBest move: {}\nEvaluation before (cp): {}\nEvaluation before (mate): {}\nEvaluation after (cp): {}\nEvaluation after (mate): {}\nLoss (cp): {}\nClassification: {}\nMotif: {}\nMotif detail: {}",
        facts.fen,
        facts.color,
        facts.move_number,
        facts.played_move,
        facts.best_move,
        opt_i32(facts.eval_before_cp),
        opt_i32(facts.eval_before_mate),
        opt_i32(facts.eval_after_cp),
        opt_i32(facts.eval_after_mate),
        facts.loss_cp.map_or_else(|| "None".to_string(), |v| v.to_string()),
        facts.classification,
        facts.motif,
        motif_detail,
    )
}

/// ChatML formatting, matching the tokenizer's own `chat_template.jinja`
/// exactly (built by hand rather than via llama.cpp's template-name
/// heuristics, to guarantee byte-for-byte the same prompt shape used
/// during training and evaluation).
fn build_prompt(facts: &MoveFacts) -> String {
    format!(
        "<|im_start|>system\n{SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n",
        build_user_prompt(facts)
    )
}

fn resolve_model_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    match app
        .path()
        .resolve("models/chesy-slm-v1-q4_k_m.gguf", BaseDirectory::Resource)
    {
        Ok(resolved) if resolved.exists() => resolved,
        _ => Path::new("models/chesy-slm-v1-q4_k_m.gguf").to_path_buf(),
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SlmExplanation {
    pub text: String,
    pub elapsed_ms: u64,
}

pub struct WorkItem {
    facts: MoveFacts,
    reply: mpsc::Sender<Result<SlmExplanation, String>>,
}

/// Explanations are on-demand only (the user explicitly asks to "explain
/// this move in depth") — never fired automatically during review or in
/// the background, since that's exactly what caused real UI freezes when
/// this was tried (see project memory, 2026-09-01): the SLM competing
/// with Stockfish's own search threads for CPU during the live review.
/// With generation strictly opt-in, one at a time, a plain FIFO is all
/// this needs — no priority queue, since there's never background
/// traffic for a request to need to jump ahead of.
pub type SlmHandle = mpsc::Sender<WorkItem>;

/// Spawns the single background worker thread that owns the model and
/// its one long-lived context for the app's lifetime, and returns the
/// handle used to submit requests to it.
fn spawn_worker(backend: LlamaBackend, model: LlamaModel) -> Result<SlmHandle, String> {
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(N_CTX))
        .with_n_threads(N_THREADS)
        .with_n_threads_batch(N_THREADS);
    let (tx, rx) = mpsc::channel::<WorkItem>();

    std::thread::spawn(move || {
        let mut ctx = match model.new_context(&backend, ctx_params) {
            Ok(ctx) => ctx,
            Err(e) => {
                eprintln!("SLM worker: failed to create context: {e}");
                return;
            }
        };

        for item in rx {
            let started = std::time::Instant::now();
            let result = generate(&model, &mut ctx, &item.facts).map(|text| SlmExplanation {
                text,
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
            let _ = item.reply.send(result);
        }
    });

    Ok(tx)
}

pub fn init(app: &tauri::AppHandle) -> Result<SlmHandle, String> {
    let model_path = resolve_model_path(app);
    if !model_path.exists() {
        return Err(format!(
            "SLM model not found at {}. See app/src-tauri/models/README.md",
            model_path.display()
        ));
    }

    let backend = LlamaBackend::init().map_err(|e| e.to_string())?;
    let model_params = LlamaModelParams::default();
    let model = LlamaModel::load_from_file(&backend, &model_path, &model_params)
        .map_err(|e| e.to_string())?;

    spawn_worker(backend, model)
}

#[tauri::command]
pub fn explain_move(
    handle: tauri::State<Result<SlmHandle, String>>,
    facts: MoveFacts,
) -> Result<SlmExplanation, String> {
    let handle = handle.as_ref().map_err(|e| e.clone())?;
    let (tx, rx) = mpsc::channel();
    handle
        .send(WorkItem { facts, reply: tx })
        .map_err(|_| "SLM worker thread is gone".to_string())?;
    rx.recv().map_err(|_| "SLM worker thread is gone".to_string())?
}

/// The actual generation + correction pipeline, kept free of any Tauri
/// types so it can be exercised directly in tests without a running app.
/// Reuses the caller's context across calls — resets its KV cache first,
/// since each call is an independent, unrelated prompt.
fn generate(model: &LlamaModel, ctx: &mut LlamaContext, facts: &MoveFacts) -> Result<String, String> {
    ctx.clear_kv_cache();

    let prompt = build_prompt(facts);
    let tokens = model
        .str_to_token(&prompt, AddBos::Always)
        .map_err(|e| e.to_string())?;

    if tokens.len() as u32 + MAX_NEW_TOKENS as u32 >= N_CTX {
        return Err(format!(
            "Prompt too long: {} tokens leaves no room for generation within n_ctx={N_CTX}",
            tokens.len()
        ));
    }

    let mut batch = LlamaBatch::new(N_CTX as usize, 1);
    let last_idx = tokens.len() - 1;
    for (i, token) in tokens.iter().enumerate() {
        batch
            .add(*token, i as i32, &[0], i == last_idx)
            .map_err(|e| e.to_string())?;
    }
    ctx.decode(&mut batch).map_err(|e| e.to_string())?;

    let mut sampler = LlamaSampler::greedy();
    let mut decoder = encoding_rs::UTF_8.new_decoder();
    let mut generated = String::new();
    let mut n_cur = tokens.len() as i32;

    for _ in 0..MAX_NEW_TOKENS {
        let token = sampler.sample(ctx, batch.n_tokens() - 1);
        sampler.accept(token);
        if model.is_eog_token(token) {
            break;
        }

        let piece = model
            .token_to_piece(token, &mut decoder, false, None)
            .map_err(|e| e.to_string())?;
        generated.push_str(&piece);

        batch.clear();
        batch
            .add(token, n_cur, &[0], true)
            .map_err(|e| e.to_string())?;
        n_cur += 1;
        ctx.decode(&mut batch).map_err(|e| e.to_string())?;
    }

    let (corrected, _was_corrected) = correct_explanation(facts, generated.trim());
    Ok(corrected)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end check against the actual bundled GGUF model: a
    /// mate-involving position where the base model is known (from the
    /// Python evaluation) to invent a wrong pawn figure instead of using
    /// "forced mate" phrasing — confirms both that the native binding
    /// produces the same generation as llama-cli/transformers, and that
    /// the correction layer catches this specific failure mode for real.
    #[test]
    fn mate_case_gets_corrected() {
        let model_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("models/chesy-slm-v1-q4_k_m.gguf");
        if !model_path.exists() {
            eprintln!("skipping: {} not present", model_path.display());
            return;
        }

        let backend = LlamaBackend::init().expect("backend init");
        let model_params = LlamaModelParams::default();
        let model = LlamaModel::load_from_file(&backend, &model_path, &model_params)
            .expect("model load");
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(N_CTX))
            .with_n_threads(N_THREADS)
            .with_n_threads_batch(N_THREADS);
        let mut ctx = model.new_context(&backend, ctx_params).expect("context");

        let facts = MoveFacts {
            fen: "2r3k1/pp3pp1/4p2p/4Pn2/8/P4N2/1P1r1PPP/3R2K1 w - - 0 23".to_string(),
            color: "white".to_string(),
            move_number: 23,
            played_move: "Rxd2".to_string(),
            best_move: "Nxd2".to_string(),
            eval_before_cp: Some(-177),
            eval_before_mate: None,
            eval_after_cp: None,
            eval_after_mate: Some(-3),
            loss_cp: Some(99793.0),
            classification: "blunder".to_string(),
            motif: "allowed_mate".to_string(),
            motif_detail: Some(serde_json::json!({})),
        };

        let explanation = generate(&model, &mut ctx, &facts).expect("generation");
        println!("generated: {explanation}");

        assert!(
            explanation.contains("forced mate in 3"),
            "expected corrected mate phrasing, got: {explanation}"
        );
        assert!(
            !explanation.to_lowercase().contains("pawns"),
            "correction should have replaced the invented pawns figure, got: {explanation}"
        );

        // Reused context, second unrelated position: proves
        // clear_kv_cache() actually resets generation state between
        // calls rather than leaking tokens from the previous prompt —
        // the exact risk introduced by moving from a fresh context per
        // call to one long-lived context reused across many calls.
        let second_facts = MoveFacts {
            fen: "8/5p2/1p4p1/p4k2/P1B3n1/1P3K2/8/8 b - - 4 44".to_string(),
            color: "black".to_string(),
            move_number: 44,
            played_move: "f6".to_string(),
            best_move: "Ne5+".to_string(),
            eval_before_cp: Some(-632),
            eval_before_mate: None,
            eval_after_cp: Some(-470),
            eval_after_mate: None,
            loss_cp: Some(162.0),
            classification: "inaccuracy".to_string(),
            motif: "fork".to_string(),
            motif_detail: Some(serde_json::json!({
                "piece": "knight",
                "targets": [{"piece": "king", "square": "f3"}, {"piece": "bishop", "square": "c4"}],
                "new_targets": ["f3", "c4"],
            })),
        };
        let second = generate(&model, &mut ctx, &second_facts).expect("second generation");
        println!("generated (reused context): {second}");
        assert!(
            second.contains("1.62 pawns") || second.contains("giving up"),
            "reused-context generation looks garbled/unrelated to the new prompt: {second}"
        );
        assert!(
            !second.contains("mate"),
            "reused-context generation looks like it bled state from the previous (mate) prompt: {second}"
        );
    }
}
