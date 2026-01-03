<!-- Version 0.0.2 -->
<div align="center">

# Soprano ONNX Streaming — Instant Text‑to‑Speech in the Browser (WebGPU/WASM)

[![Upstream](https://img.shields.io/badge/Upstream-ekwek1%2Fsoprano-black?logo=github)](https://github.com/ekwek1/soprano)
[![Hugging Face Model](https://img.shields.io/badge/HuggingFace-Model-orange?logo=huggingface)](https://huggingface.co/ekwek/Soprano-80M)
[![Hugging Face Demo](https://img.shields.io/badge/HuggingFace-Demo-yellow?logo=huggingface)](https://huggingface.co/spaces/ekwek/Soprano-TTS)

</div>

A **static, client-side** browser demo that runs the Soprano TTS pipeline using **onnxruntime-web** (WebGPU or WASM).

This is a conversion/port of the original Soprano project:
https://github.com/ekwek1/soprano

---

## Requirements

- A modern browser. **Chrome/Edge + WebGPU** is recommended for best performance.
- You must serve this folder over HTTP (opening `index.html` via `file://` usually breaks `fetch()` / module loading).
- The demo loads `onnxruntime-web` and `@huggingface/transformers` from a CDN by default (network required unless you vendor them).
- The model files are large; plan to use **Git LFS** or GitHub Releases if you publish them.

---

## Folder layout

Place model artifacts under `./models/`:

```text
.
├─ index.html
├─ onnx-streaming.js
├─ PCMPlayerWorklet.js
├─ style.css
└─ models/
   ├─ soprano_backbone_kv.onnx
   ├─ soprano_decoder.onnx
   ├─ soprano_decoder.onnx.data
   └─ soprano-tokenizer/
      ├─ tokenizer.json
      ├─ tokenizer_config.json
      ├─ special_tokens_map.json
      ├─ config.json
      └─ generation_config.json
```

Notes:
- The decoder uses external weights; `soprano_decoder.onnx.data` must be present and served next to `soprano_decoder.onnx`.
- The tokenizer is loaded locally from `models/soprano-tokenizer` (remote model downloads are disabled in the demo).

---

## Run locally

Use any static file server from this directory, for example:

```bash
python -m http.server 8085
```

Then open `http://localhost:8085`.

---

## Configuration

Model paths are defined near the top of `onnx-streaming.js` in the `MODELS` object.

Sampling defaults are set in `onnx-streaming.js` (constructor):
- `temperature`
- `topK`
- `topP`
- `repetitionPenalty`

---

## Troubleshooting

- **“Load failed” / model never becomes Ready**
  - Verify the `models/` filenames match `MODELS` in `onnx-streaming.js`
  - Check DevTools → Network for a missing `soprano_decoder.onnx.data` (404)
  - Confirm `models/soprano-tokenizer/` contains `tokenizer.json` (and related files)
- **Slow performance**
  - Prefer WebGPU and keep other GPU-heavy tabs closed
  - WASM/CPU is a fallback and will be much slower

---

## License & attribution

Soprano is released under **Apache-2.0** in the upstream repository:
https://github.com/ekwek1/soprano
