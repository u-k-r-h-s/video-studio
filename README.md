# Video Studio

A **local-first, profile-driven AI video studio**. Give it an idea or an existing script; it plans scenes with a local
LLM, lets you review and edit them, then generates images, voices and subtitles and renders a vertical 1080x1920 MP4,
all on your own machine with no paid API. The first format profile is `motion-comic` (still illustrations with camera
moves, sliding cut-out characters, narration and subtitles for YouTube Shorts). The pipeline itself is generic: a
format is a data object (`FormatProfile`), not hard-coded behaviour.

**Status: Phase 2A**, the smallest real end-to-end vertical slice. It works end to end on the target machine, but the
generated art is crude (see [Current limitations](#current-limitations)). This repository also contains the earlier
hardware feasibility harness (`REPORT.md`, `results/`, `test-project/`, most of `scripts/`), preserved unchanged.

## Hardware target

Apple Silicon Mac with **8 GB unified memory** (developed and measured on a MacBook Air M1, 7-core GPU, macOS 26).
The design is driven by what that machine can and cannot do (`REPORT.md`): heavy models run **strictly one at a
time**, and image generation is the bottleneck. macOS is required for the CoreText subtitle renderer and the
VideoToolbox encoder (a software x264 fallback exists for video, none for subtitles).

## Architecture in one picture

```
idea / script -> Ollama -> validated scene plan -> HUMAN REVIEW/EDIT -> approve
   -> ComfyUI (one session) images -> Piper voices -> timeline + CoreText subtitles -> FFmpeg motion render -> final MP4
```

React UI -> Express API (loopback only) -> `Studio` -> one allow-listed `ToolDispatcher` -> pipeline stages ->
providers (Ollama, ComfyUI, Piper, CoreText, FFmpeg) behind interfaces. Details: [docs/architecture.md](docs/architecture.md),
[docs/pipeline.md](docs/pipeline.md), [docs/providers.md](docs/providers.md).

## External dependencies

| Tool | Used for | Notes |
|---|---|---|
| Node.js >= 20.12 | server + UI | |
| [Ollama](https://ollama.com) + `llama3.2` | scene planning | any model that follows JSON schemas; larger = better writing |
| [ComfyUI](https://github.com/comfyanonymous/ComfyUI) (GPL-3.0) | images | cloned into `./comfyui`, run as a separate process on demand |
| [Piper](https://github.com/OHF-voice/piper1-gpl) `piper-tts` (GPL-3.0) | voices | separate process; voices downloaded separately |
| FFmpeg >= 7 | motion render, assembly | needs `h264_videotoolbox` (preferred) or `libx264`; libass is **not** required |
| Xcode command line tools | builds the CoreText subtitle helper | `xcode-select --install` |
| [uv](https://github.com/astral-sh/uv) | creates the Python 3.12 venvs for ComfyUI and Piper | system Python 3.9 is too old |

## Installation

```bash
# 1. tools (Homebrew)
brew install node ffmpeg uv            # Ollama: install the app from https://ollama.com
xcode-select --install                 # if not already installed

# 2. this repo
git clone https://github.com/u-k-r-h-s/video-studio.git && cd video-studio
npm install
npm run build:native                   # builds bin/subpng (CoreText subtitles)

# 3. Ollama model
ollama pull llama3.2

# 4. ComfyUI in its own venv (Python 3.12)
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git comfyui
uv venv --python 3.12 venv-comfy
uv pip install --python venv-comfy/bin/python -r comfyui/requirements.txt

# 5. Piper in its own venv
uv venv --python 3.12 venv-piper
uv pip install --python venv-piper/bin/python piper-tts

# 6. check everything (read-only)
npm run doctor
```

Optional: copy `.env.example` to `.env` to change paths/models. Every variable has a default that matches the layout above.

## Model installation

Model files are **not** in this repository. Download them into the folders the defaults expect.

**Image model (ComfyUI)**, ~2.3 GB total:

```bash
mkdir -p comfyui/models/checkpoints comfyui/models/loras
# SD 1.5 fp16, 2.13 GB, sha256 e9476a13728cd75d8279f6ec8bad753a66a1957ca375a1464dc63b37db6e3916
curl -L -o comfyui/models/checkpoints/v1-5-pruned-emaonly-fp16.safetensors \
  https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors
# LCM-LoRA for SD 1.5, 135 MB, sha256 8f90d840e075ff588a58e22c6586e2ae9a6f7922996ee6649a7f01072333afe4
curl -L -o comfyui/models/loras/lcm-lora-sdv1-5.safetensors \
  https://huggingface.co/latent-consistency/lcm-lora-sdv1-5/resolve/main/pytorch_lora_weights.safetensors
shasum -a 256 comfyui/models/checkpoints/*.safetensors comfyui/models/loras/*.safetensors   # compare with the hashes above
```

**Voices (Piper)**, ~140 MB. **Read the licensing caveats below before using these commercially.**

```bash
mkdir -p piper-voices && cd piper-voices
B=https://huggingface.co/rhasspy/piper-voices/resolve/main
curl -LO $B/en/en_US/libritts_r/medium/en_US-libritts_r-medium.onnx      # tracked .onnx.json configs already exist here
curl -LO $B/hi/hi_IN/rohan/medium/hi_IN-rohan-medium.onnx
cd ..
```

Voice ids map to these files in `config/voices.json`; add voices there (and to a profile's `voices` pool) to use others.

## How to run

```bash
npm run dev            # API on http://127.0.0.1:8787, UI on http://localhost:5173
npm test               # all tests (no real AI models needed; some tests use the real ffmpeg if present)
npm run typecheck
node scripts/demo.mjs  # drives a complete run through the API against the REAL models (about 3-6 minutes on an M1)
```

In the UI: **New project** (Idea or Script) -> scenes are generated -> **review/edit** them -> **Approve plan** ->
**Generate video** -> preview/download MP4 and SRT. Per scene you can regenerate **Images**, a **New background**,
**Voice** or **Animation** without touching the other scenes. Close memory-hungry apps (browsers) before generating.

## How the pipeline works

1. **Plan**: Ollama returns a structured plan (cast + scenes + dialogue + camera/motion hints). Output is validated,
   normalised and repaired; in Script mode dialogue is checked to be verbatim from your script. Then Ollama is
   unloaded and verified gone.
2. **Review**: nothing heavy runs until you approve. You can edit scenes, dialogue, props and characters.
3. **Images**: one ComfyUI session generates all backgrounds (one per location), characters and props; ComfyUI is then
   freed, stopped and verified stopped. Cut-outs are keyed to transparency and quality-checked, with automatic retry.
4. **Voices**: Piper per line, silence trimmed. **Timeline**: real audio durations place every line; subtitle PNGs
   are rendered with CoreText; each scene gets one mixed audio track.
5. **Render**: FFmpeg renders one clip per scene from motion primitives; clips are joined into `final/final.mp4`.

Everything is cached by input hash and persisted in `projects/<id>/project.json`, so a failed or interrupted run
resumes and an edit regenerates only what changed. Full detail: [docs/pipeline.md](docs/pipeline.md).

## Current limitations

- **Art quality is the weak point.** SD 1.5 + LCM at 512x896 (upscaled to 1080x1920) gives soft, inconsistent,
  sometimes strange images. There is **no image-level character consistency** (only the same appearance text in each
  prompt, optionally user-supplied art). Props are often unrecognisable. Cut-out keying depends on the model drawing a
  plain background; failing images are retried (max 3 attempts) and the last one is kept with a warning.
- **Memory pressure.** Image generation drives an 8 GB machine into heavy swapping; measured numbers are in
  `docs/pipeline.md` / the demo notes. Close other apps first. Ollama and ComfyUI never overlap by design.
- **Speed.** About 25-60 s per image; a 3-scene short takes roughly 3-5 minutes to generate.
- **Motion is puppet-style**: whole cut-outs slide, scale, bob and shake; no limb animation, lip-sync or parallax.
- **llama3.2 (3B)** returns valid structure but modest writing (odd names/lines); the planner is constrained, not
  autonomous. No LLM tool-calling loop exists; the tool registry is a deterministic internal surface.
- Prop images are scene-scoped, so the same prop in two scenes is generated twice.
- Scene length is derived from the voice (minimum 5 s); the `Length` field only matters for scenes without dialogue.
- English voice speaker ids are arbitrary and un-auditioned; Hindi voice pronunciation is imperfect and unverified by ear.
- Jobs are in memory; project state (what is done) is persistent. The API has no authentication (loopback only).
- macOS only (CoreText subtitles, VideoToolbox). No production build/deployment setup. No SQLite, cloud, MCP, Blender.

## Licensing caveats

This is engineering notes, not legal advice. Check every licence before publishing monetised content.

- **Voices (unresolved).** Both bundled voice *choices* (`en_US-libritts_r-medium`, `hi_IN-rohan-medium`) are
  **fine-tuned from the Lessac voice**, whose data licence (Lessac Technologies / Blizzard 2013) is registration-based
  and granted to the named licensee only. Whether that restriction carries over to derived weights is unresolved.
  `libritts_r`'s dataset is CC BY 4.0 (attribution needed); `rohan` uses the IIT Madras IndicTTS licence (permissive text,
  retain their notice if you redistribute). Other Piper Hindi voices (`pratham`, `priyamvada`) are CC BY-NC-SA: not for
  commercial use. No voice weights are committed here.
- **Image models.** SD 1.5 is CreativeML OpenRAIL-M and the LCM-LoRA OpenRAIL++: commercial use is permitted with
  use-based restrictions that must be passed on. Not committed here.
- **GPL tools.** ComfyUI and Piper are GPL-3.0; this project only *runs* them as separate processes and uses their
  output files. Do not bundle them into a closed-source redistribution without checking.
- **Content.** Stories and characters must be original; the planner is instructed not to imitate existing franchises,
  but you are responsible for what you publish.
- This repository has no `LICENSE` file yet, so by default no one has rights to reuse its code.

## Repository map

`apps/server` (API, pipeline, providers) · `apps/web` (UI) · `packages/shared` (zod schemas) · `config/voices.json` ·
`docs/` · `scripts/` (demo, native build, doctor, plus the feasibility scripts `comfy_run.py`, `memmon.py`, ...) ·
`REPORT.md` + `results/` + `test-project/` (feasibility measurements, preserved).
