# Soprano ONNX Streaming — Instant Text‑to‑Speech in the Browser (WASM)

[![Upstream](https://img.shields.io/badge/Upstream-ekwek1%2Fsoprano-black?logo=github)](https://github.com/ekwek1/soprano)
[![Hugging Face Model](https://img.shields.io/badge/HuggingFace-Model-orange?logo=huggingface)](https://huggingface.co/ekwek/Soprano-80M)
[![Hugging Face Demo](https://img.shields.io/badge/HuggingFace-Demo-yellow?logo=huggingface)](https://huggingface.co/spaces/ekwek/Soprano-TTS)


A **static, client-side** browser demo that runs the Soprano TTS pipeline using **onnxruntime-web**.

This is a conversion/port of the original Soprano project:
https://github.com/ekwek1/soprano

---

## Requirements

- A modern browser (Chrome, Edge, Firefox, Safari).
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
├─ onnx/
│  ├─ soprano_backbone_kv.onnx
│  ├─ soprano_decoder.onnx
│  └─ soprano_decoder.onnx.data
├─ tokenizer.json
├─ tokenizer_config.json
├─ special_tokens_map.json
├─ config.json
└─ generation_config.json
```

Notes:
- ONNX models live in `onnx/` following HuggingFace convention.
- The decoder uses external weights (`.onnx.data` file must be present alongside the `.onnx` file).
- Tokenizer files are in the root directory.

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

- **"Load failed" / model never becomes Ready**
  - Verify the `onnx/` filenames match `MODELS` in `onnx-streaming.js`
  - Check DevTools → Network for a missing `.onnx.data` file (404)
  - Confirm `/` contains `tokenizer.json` (and related files)
- **Performance notes**
  - Both backbone and decoder run on WASM/CPU
  - Achieves real-time streaming on modern hardware

---

## License & attribution

Soprano is released under **Apache-2.0** in the upstream repository:
https://github.com/ekwek1/soprano


