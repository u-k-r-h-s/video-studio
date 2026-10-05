# Video Studio

A **local-first, profile-driven AI video studio**. Give it an idea; a local LLM directs it as a shot list, ComfyUI
paints a handful of key images, Piper speaks the lines, a small synthesizer makes the sound, and FFmpeg renders a
vertical 1080x1920 MP4 with 2.5D camera moves, depth of field, grade, grain and word-timed captions, all on your own
machine with no paid API. A format is a data object (`FormatProfile`), not hard-coded behaviour. Three formats exist:

* **`animated-short`** (default): the director's shot list with semantic physical actions -> asset manifest ->
  ComfyUI locations, character views, faces and props (cut out with a BiRefNet matte) -> animation compiler -> layered 2D/2.5D
  renderer (walks, turns, doors, weather, camera) -> voices + sound locked to the motion -> MP4. See
  [docs/animation.md](docs/animation.md).
* **`cinematic-animated-short`** (Phase 2B, `--profile cinematic-animated-short`): story -> beats -> shots -> ~6-8 key images -> parallax camera ->
  SFX/music -> edit. Still images with a moving camera, not animation. See [docs/shots.md](docs/shots.md).
* **`motion-comic`** (Phase 2A): still illustrations with sliding cut-out characters. Kept working; visibly cruder.

```bash
npm run short -- "Create a 25 second animated mystery short about a delivery rider."
```

That one command starts the local API if needed, plans with Ollama, approves, generates and writes the MP4 to your
Desktop (`--out`, `--seconds`, `--review` to stop after planning, `--resume <project-id>` to continue a failed run).

**Animation engine:** `npm run short` now runs the layered 2D/2.5D engine (characters walk, turn, look and react; doors open; weather and camera move) and never falls back to the still-image renderer: see [docs/animation.md](docs/animation.md). `npm run anim:test` / `npm run anim:short` remain as the hand-authored regression/demo. It is a paper-doll style of animation with visible weaknesses; the honest list is in docs/animation.md.

**Status: Phase 2B-Replacement.** The visual system is a large step up from the comic MVP and the pipeline is real end
to end, but the *story writing* is limited by the 3B local model: see [Current limitations](#current-limitations) for an
honest account. This repository also contains the earlier hardware feasibility harness (`REPORT.md`, `results/`,
`test-project/`, most of `scripts/`), preserved unchanged.

## Hardware target

Apple Silicon Mac with **8 GB unified memory** (developed and measured on a MacBook Air M1, 7-core GPU, macOS 26).
The design is driven by what that machine can and cannot do (`REPORT.md`): heavy models run **strictly one at a
time**, and image generation is the bottleneck. macOS is required for the CoreText subtitle renderer and the
VideoToolbox encoder (a software x264 fallback exists for video, none for subtitles).

## Architecture in one picture

```
idea -> Ollama director -> validated Story (shots) -> HUMAN REVIEW -> approve
   -> ComfyUI (one session) key images -> Piper voices -> timeline + captions + soundtrack -> FFmpeg 2.5D render -> final MP4
(motion-comic: idea/script -> scene plan -> backgrounds + cut-outs -> ... -> scene clips; same gates, store and API)
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

**Image models (ComfyUI)**. The cinematic format uses **DreamShaper 8** (about 2.1 GB, below); the motion comic uses SD 1.5 (about 2.3 GB, further below).

```bash
# DreamShaper 8 (Lykon, CreativeML OpenRAIL-M), split components, fp16. Needed for `cinematic-animated-short`.
mkdir -p comfyui/models/diffusion_models comfyui/models/text_encoders comfyui/models/vae comfyui/models/loras
H=https://huggingface.co/Lykon/dreamshaper-8/resolve/main
curl -L -o comfyui/models/diffusion_models/dreamshaper8_unet_fp16.safetensors $H/unet/diffusion_pytorch_model.fp16.safetensors   # 1.72 GB, sha256 ac0a7f11...28f3
curl -L -o comfyui/models/text_encoders/dreamshaper8_clip_fp16.safetensors     $H/text_encoder/model.fp16.safetensors             # 246 MB,  sha256 fda1f312...d0a7
curl -L -o comfyui/models/vae/dreamshaper8_vae_fp16.safetensors               $H/vae/diffusion_pytorch_model.fp16.safetensors    # 167 MB,  sha256 ff38c7ec...a33d
# the same LCM-LoRA as below (comfyui/models/loras/lcm-lora-sdv1-5.safetensors) is required too
```

**Background-removal model (needed by `animated-short`)**: BiRefNet (MIT, 444 MB) cuts characters and props out of their backdrop; it is loaded in the same ComfyUI session as the image model.

Download the BiRefNet file from the `Comfy-Org/BiRefNet` repository on Hugging Face into `comfyui/models/background_removal/` and name it `birefnet.safetensors` (or set `COMFYUI_MATTE_MODEL` to its file name). The folder is git-ignored like all model weights.

SD 1.5 + LCM-LoRA (motion comic, and the LoRA is shared), ~2.3 GB:

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
npm run short -- "<idea>"   # idea -> finished MP4 in one command (see above)
npm run dev            # API on http://127.0.0.1:8787, UI on http://localhost:5173
npm test               # all tests (no real AI models needed; some tests use the real ffmpeg if present)
npm run typecheck
node scripts/demo.mjs  # drives a complete run through the API against the REAL models (about 3-6 minutes on an M1)
```

In the UI: **New project** (Idea or Script) -> scenes are generated -> **review/edit** them -> **Approve plan** ->
**Generate video** -> preview/download MP4 and SRT. Per scene you can regenerate **Images**, a **New background**,
**Voice** or **Animation** without touching the other scenes. Close memory-hungry apps (browsers) before generating.

## How the pipeline works

The cinematic pipeline is described in [docs/shots.md](docs/shots.md). The scene pipeline of the motion comic works like this:

1. **Plan**: Ollama returns a structured plan (cast + scenes + dialogue + camera/motion hints). Output is validated,
   normalised and repaired. In Script mode with `NAME: line` scripts the dialogue, order and cast come from your
   script, and the model only designs each scene's visuals. Then Ollama is unloaded and verified gone.
2. **Review**: nothing heavy runs until you approve. You can edit scenes, dialogue, props and characters.
3. **Images**: one ComfyUI session generates all backgrounds (one per location), characters and props; ComfyUI is then
   freed, stopped and verified stopped. Cut-outs are keyed to transparency and quality-checked, with automatic retry.
4. **Voices**: Piper per line, silence trimmed. **Timeline**: real audio durations place every line; subtitle PNGs
   are rendered with CoreText; each scene gets one mixed audio track.
5. **Render**: FFmpeg renders one clip per scene from motion primitives; clips are joined into `final/final.mp4`.

Everything is cached by input hash and persisted in `projects/<id>/project.json`, so a failed or interrupted run
resumes and an edit regenerates only what changed. Full detail: [docs/pipeline.md](docs/pipeline.md).

## Current limitations

Measured on the target machine (MacBook Air M1, 8 GB). Details and numbers: [docs/shots.md](docs/shots.md).

* **The story writing is only as good as the 3B model.** `llama3.2` returns valid structure, but its mysteries are
  generic, its dialogue repeats ("What's going on?") and it drifts from the idea (a "delivery rider" story may forget the
  bike). The director therefore works beat by beat, repairs ids deterministically, drops junk/repeated lines and
  varies the framing, but it cannot make a 3B model a screenwriter. A larger model helps (`OLLAMA_MODEL=qwen2.5:7b` was
  measured: better premise and dialogue, planning takes about 7 minutes instead of 2; see docs/shots.md). The hand-authored prototype in `scripts/lab/prototype-story.ts` shows what
  the renderer does with a good script.
* **Images are 512x896 upscaled to 1080x1920**, so close-ups are soft; grain, sharpening and depth of field hide this but
  do not fix it. There is no IP-Adapter/LoRA, so character identity relies on a costume-coded prompt plus img2img from the
  character's first portrait: faces stay recognisable in close-ups, less so across very different framings.
* **Not real animation.** The camera (zoom/pan/tilt/roll/shake), parallax between a defocused background and a sharp
  subject layer, and small character motions (breathing, a pop, a tremble) make still images feel alive; limbs, mouths
  and eyes do not move. Parallax is a soft elliptical mask, not segmentation, so busy edges can ghost slightly.
* **Sound is synthesized**: functional (whoosh, hit, ping, ding, door, footsteps, heartbeat, riser, glitch, ambience, a
  tension bed that follows the story) but not rich. Nobody has *listened* to the Piper voices or the mix during
  development (only measured: pitch, loudness, timing); judge them by ear before publishing.
* **Caption word timing is estimated** (Piper has no word timestamps). Captions are English only (Impact font).
* **Memory pressure.** Image generation drives an 8 GB machine into heavy swapping (see the measurements in
  `docs/pipeline.md`); close other apps first. Ollama and ComfyUI never overlap by design.
* **Speed**: about 40 s per key image; a 25 s short takes roughly 8-12 minutes end to end (planning about 2 minutes
  because the director makes ~8 small LLM calls, images 4-6 minutes, render about 40 s).
* **Shot projects are not editable in the review screen yet** (read-only shot list; use a re-plan note instead).
* Jobs are in memory; project state (what is done) is persistent. The API has no authentication (loopback only).
* macOS only (CoreText captions, VideoToolbox). No production build/deployment setup. No SQLite, cloud, MCP, Blender.
* Motion comic limitations (crude art, puppet-style motion, no image-level consistency, voice un-auditioned) are as in Phase 2A.

## Licensing caveats

This is engineering notes, not legal advice. Check every licence before publishing monetised content.

- **Voices (unresolved).** Both bundled voice *choices* (`en_US-libritts_r-medium`, `hi_IN-rohan-medium`) are
  **fine-tuned from the Lessac voice**, whose data licence (Lessac Technologies / Blizzard 2013) is registration-based
  and granted to the named licensee only. Whether that restriction carries over to derived weights is unresolved.
  `libritts_r`'s dataset is CC BY 4.0 (attribution needed); `rohan` uses the IIT Madras IndicTTS licence (permissive text,
  retain their notice if you redistribute). Other Piper Hindi voices (`pratham`, `priyamvada`) are CC BY-NC-SA: not for
  commercial use. No voice weights are committed here.
- **Image models.** SD 1.5 and DreamShaper 8 are CreativeML OpenRAIL-M and the LCM-LoRA OpenRAIL++: commercial use is
  permitted with use-based restrictions that must be passed on. Not committed here. Check the DreamShaper 8 model card
  (`Lykon/dreamshaper-8`) yourself before publishing monetised content.
- **GPL tools.** ComfyUI and Piper are GPL-3.0; this project only *runs* them as separate processes and uses their
  output files. Do not bundle them into a closed-source redistribution without checking.
- **Content.** Stories and characters must be original; the planner is instructed not to imitate existing franchises,
  but you are responsible for what you publish.
- This repository has no `LICENSE` file yet, so by default no one has rights to reuse its code.

## Repository map

`apps/server` (API, pipeline, providers, `src/shots` director/camera/renderer, `src/audio` synth/mixer) · `apps/web` (UI) · `packages/shared` (zod schemas) · `config/voices.json` ·
`docs/` · `scripts/` (demo, native build, doctor, plus the feasibility scripts `comfy_run.py`, `memmon.py`, ...) ·
`REPORT.md` + `results/` + `test-project/` (feasibility measurements, preserved).
