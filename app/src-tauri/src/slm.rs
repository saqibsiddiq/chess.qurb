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
const N_THREADS: i32 = 2;

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

fn python_style_json(value: &serde_json::Value) -> String {
    let compact = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
    compact.replace(':', ": ").replace(',', ", ")
}

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

pub type SlmHandle = mpsc::Sender<WorkItem>;

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
