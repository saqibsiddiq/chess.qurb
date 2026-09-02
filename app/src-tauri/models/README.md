# Bundled SLM weights

`tauri build` embeds whatever GGUF file is at `models/chesy-slm-v1-q4_k_m.gguf`
into the app package as a resource, loaded at runtime by the native
llama.cpp binding (see `src/slm.rs`) — no separate runtime or subprocess
needed. This directory is gitignored (the model is ~100MB) — populate it
before building:

```bash
cp ml/models/chesy-slm-v1/gguf/chesy-slm-v1-q4_k_m.gguf app/src-tauri/models/chesy-slm-v1-q4_k_m.gguf
```

That GGUF file itself is produced from the trained LoRA adapter
(`ml/models/chesy-slm-v1/final_adapter/`, produced by
`ml/training/train_sft.py`) via:

1. Merge the adapter into standalone weights with `peft`'s
   `PeftModel.merge_and_unload()`.
2. Convert to GGUF (f16) with llama.cpp's `convert_hf_to_gguf.py`.
3. Quantize to Q4_K_M with `llama-quantize` for a mobile-appropriate size
   (~100MB vs. ~270MB f16).

**Known caveat (2026-08-31):** the `tokenizer_config.json` saved by this
version of `transformers`/`peft` includes an `extra_special_tokens` field
as a list (`["<|im_start|>", "<|im_end|>"]`), which a newer `transformers`
release expects as a dict and fails to load
(`AttributeError: 'list' object has no attribute 'keys'`). The tokens are
already registered as proper special tokens inside `tokenizer.json`, so
this field is redundant — delete it from `tokenizer_config.json` before
running the conversion script if you hit that error.
