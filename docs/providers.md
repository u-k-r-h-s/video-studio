# Providers

A provider is an implementation behind a small interface. A `FormatProfile` names the providers it uses; the
container (`apps/server/src/container.ts`) is the only place that constructs them. Nothing else imports a concrete
provider, so each can be replaced. Only one implementation of each exists today (no cloud providers, no alternatives).

| Interface | File | Implementation | Runs as |
|---|---|---|---|
| `LLMProvider` | `llm/types.ts` | `OllamaProvider` | HTTP to local Ollama |
| `ImageProvider` | `providers/image/ImageProvider.ts` | `ComfyUIProvider` (+ `ComfyProcess`) | child process + local HTTP |
| `TTSProvider` | `providers/tts/TTSProvider.ts` | `PiperProvider` | separate process per line |
| `SubtitleRenderer` | `providers/subtitle/SubtitleRenderer.ts` | `CoreTextSubtitleRenderer` | native Swift helper |
| `SceneRenderer` | `render/SceneRenderer.ts` | `FFmpegMotionRenderer` | ffmpeg / ffprobe |

## LLMProvider / Ollama

`chat({messages, format, temperature, signal})` returns the model text. `format` is a JSON Schema derived from the
zod schema (Ollama structured output). `generateStructured()` wraps it: parse (with one safe clean-up for fences,
smart quotes and trailing commas), normalise, validate, then up to `PLANNER_MAX_REPAIR_ATTEMPTS` repair rounds that
send the exact problems back. Default model `llama3.2` (3B): output is valid but writing quality is modest; a larger
model improves it (`OLLAMA_MODEL`), at the cost of memory.
`OllamaController` (HTTP `/api/ps`, `/api/generate keep_alive:0`, plus a `pgrep` check for `llama-server` /
`ollama runner`) is what `MemoryGate` uses to unload and verify.

## ImageProvider / ComfyUI

Contract: `generateBatch(requests, hooks)` owns the provider's whole lifecycle for one project batch and releases
everything before returning, also on failure or cancellation.

`ComfyUIProvider` sequence: ensure Ollama unloaded (gate) -> start ComfyUI -> generate every request through the
proven workflow -> `/free` -> stop -> verify stopped (gate). Details:

- **Models** are registered by id (`container.ts`): `sd15` (single checkpoint + LCM-LoRA, the default) and `ds8` (DreamShaper 8 as
  split UNET/CLIP/VAE files + the same LCM-LoRA, used by the cinematic profile; measured 37-44 s per 512x896 image at 6 steps,
  cfg 1.8, and far more cinematic than SD 1.5). A request names its model; img2img (`initImage` + `denoise`) uploads the
  init image through ComfyUI's `/upload/image`. A missing model file fails with a readable "not installed" message.
- Workflow (`comfyWorkflow.ts`, the only file that knows node ids): SD 1.5 fp16 + LCM-LoRA, 5 steps, cfg 1.5, `lcm`
  sampler, `sgm_uniform` scheduler, `ModelSamplingDiscrete(lcm)`, 512x896 (props 512x512), ending in `PreviewImage` so
  results are fetched via `/view` from ComfyUI's temp folder and never accumulate in its output directory.
  Replace the workflow by passing `buildWorkflow`; nothing else changes.
- `ComfyProcess` spawns `python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch --offline` with
  `PYTORCH_ENABLE_MPS_FALLBACK=1`, waits for `/system_stats`, refuses to start if the port is already in use (it never
  hijacks a ComfyUI you started yourself), and stops with SIGTERM -> SIGKILL, verifying process and port.
- Per-image timeout (`COMFYUI_IMAGE_TIMEOUT_MS`) interrupts a stuck job; cancellation calls `/interrupt`.
- `onImage` fires per image so the caller persists it immediately (resumability).
- Seeds are deterministic (`project:asset:attempt`); a forced regeneration increments `attempt`.
- Images are 512x896 and are **upscaled** to 1080x1920 (soft). Character consistency is only
  "same appearance text in every prompt": there is no image-level conditioning.

Characters and props are generated on a plain background and converted to transparent cut-outs by
`lib/png.ts` (border-colour keying, optional panel peeling for characters, crop, soft edge). This depends on the
model actually producing a flat background; when it does not, the cut-out keeps patches of background.

A user-supplied `referenceImage` on a character is used **as the character art** (keyed the same way) instead of
generating one. It does not condition the model.

## TTSProvider / Piper

Piper (GPL-3.0) is run as a separate process: `python -m piper -m <model.onnx> -f <out.wav> [-s <speaker>] -- <text>`.
The text is a literal argument after `--`. Voices come from `config/voices.json` (ids -> model file name, optional
speaker id, language); the model files live in `PIPER_VOICES_DIR` and are **not** bundled. A missing model raises
"Piper voice model was not found." Voice choice per character is deterministic (`resolveVoiceId`): narrator ->
profile narrator voice; character -> its own `voiceId` or round-robin over the profile's pool. The English entries
use arbitrary, un-auditioned speaker ids of one multi-speaker model; the Hindi voice is a single speaker.
After synthesis the pipeline trims leading/trailing silence (`lib/wav.ts`; Piper clips carry ~0.2-0.3 s) so the
timeline is exact.

## SubtitleRenderer / CoreText

The installed FFmpeg may lack libass/drawtext, so subtitles are **pre-rendered PNGs overlaid by FFmpeg**.
`scripts/subpng.swift` (built to `bin/subpng` by `npm run build:native`) renders a cue with macOS CoreText, which
shapes Devanagari conjuncts and vowel signs correctly (measured: Pillow without a text shaper does not). Text, font
family, size, width and outline are passed as arguments. macOS only. A libass-based implementation could be added
behind the same interface.

## SceneRenderer / FFmpeg

`renderScene(plan)` builds one filter graph (`filterGraph.ts`): background through `zoompan` at 2x working size
(camera zoom/pan), then character, prop and subtitle layers as `overlay` filters with time-based position/scale
expressions compiled from the scene's motion primitives. Encoder: `h264_videotoolbox` when available, otherwise
`libx264` (`FFMPEG_ENCODER` can force one; forcing VideoToolbox when missing raises "FFmpeg VideoToolbox encoder is
unavailable."). In `auto` mode a failed VideoToolbox run is retried once with libx264. Every output is probed
(ffprobe) and validated for size, frame rate, audio presence, codec and duration. `assemble` concatenates the scene
clips (video stream-copied, audio re-encoded once) and validates the total.

## Adding a provider

1. Implement the interface (add a `health()` that never loads a heavy model).
2. If it is heavy, route its start/stop through `MemoryGate` and release in `finally`.
3. Register it in `container.ts` under a key and reference that key from a `FormatProfile`.
4. Add a fake of it to the pipeline test harness (`test/harness.ts`) and keep the real-tool test conditional on
   the tool being installed.
