# Hardware feasibility report: MacBook Air M1 / 8 GB

Measured 2026-10-04 on the target machine. Nothing in the Phase 1 app was changed. All experiment files live in this folder (`ai-studio-feasibility/`); raw data is in `results/` (CSV memory samples, JSON run logs, outputs).

**Conditions you should know about.** The Mac was *not* idle: Claude, Chrome and Postman were running, and **before any AI work** it already showed ~7.5 GB used, 2.2 GB in the compressor and 2.6–3.4 GB of swap in use (free memory 50–65%). All memory numbers below are under those real-world conditions, not a lean machine. Memory was sampled every 2 s (`scripts/memmon.py`).

**What I could not do.** I cannot listen to audio or watch video play. Audio quality was checked with a speech-recognition round trip (a proxy for intelligibility, not naturalness). Video was checked by decoding, probing, extracting still frames and PSNR/SSIM, not by watching motion. **Please listen to `results/audio/*.wav` and watch `results/video/test_vt_v2.mp4` yourself.**

## 1. Environment

| Item | Value |
|---|---|
| Machine | MacBookAir10,1, Apple M1, 8 GB unified RAM, macOS 26.3.1 |
| Python (experiment) | CPython 3.12.13 via `uv` (isolated; system Python 3.9.6 untouched) |
| ComfyUI | 0.38.0 (commit f1072eb), PyTorch 2.14.1, device `mps` |
| Piper | piper-tts 1.8.0 (+ onnxruntime 1.30.0) |
| FFmpeg | 9.0.2 (Homebrew), `--enable-videotoolbox`, **no libass / libfreetype / fontconfig** (no `subtitles`, `ass`, `drawtext`) |
| Ollama | 0.32.5, llama3.2:latest (2.0 GB; resident 1.95 GB RSS / 2.5 GB per `api/ps`) |
| Image model | SD 1.5 `v1-5-pruned-emaonly-fp16.safetensors`, 2.13 GB (+ LCM-LoRA 0.135 GB) |
| Voices | `en_US-libritts_r-medium` 78.6 MB, `hi_IN-rohan-medium` 63.0 MB |
| Test-only tool | Whisper-small via faster-whisper (484 MB), used only to check TTS intelligibility |
| Disk used by experiment | 5.0 GB (+140 MB uv Python); 28 GB free afterwards |

## 2. ComfyUI results (512×896, 9:16)

| Metric | Result |
|---|---|
| Model | SD 1.5 fp16, Comfy-Org mirror (SHA-256 verified against HF's published hash) |
| Model size / download | 2.13 GB in 68 s (~31 MB/s); LoRA 0.135 GB in 6 s |
| Resolution | 512×896 |
| Generation time, standard (Euler, 20 steps) | **102.7 s (cold), 104.9 s, 109.8 s** |
| Generation time, LCM-LoRA (5 steps) | **36.6, 36.3, 37.8, 38.4, 37.5, 35.7 s** (6 runs, ~36–38 s) |
| Model load | 4.0 s disk→CPU weights (standalone, OS cache warm). Cold-vs-warm generation differed by ≈0 s; a true first load from SSD after reboot was not isolated. ComfyUI server start: 12.6 s (64.7 s the very first time). |
| Ollama loaded vs unloaded (same LCM job) | **188.5 s and 129.0 s with llama3.2 resident, vs ~37 s unloaded: 3.5–5× slower** |
| Memory, unloaded run | Process RSS peak only 0.6 GB (misleading: Metal buffers aren't in RSS). `footprint` (GPU-inclusive) peak **4.5 GB**. System reclaimable memory fell from ~2.7–4.2 GB to ~0.4–0.6 GB; free memory minimum **3%** (standard run) / **12–14%** (LCM); swap grew +2.7 GB per run (3.8→6.5 GB); ~3.1–3.7 GB written to swap per LCM image. |
| Memory, with Ollama resident | free memory 3–4%, swap up to **9.4 GB**, ~23–38 GB written to swap per image |
| Heavy macOS memory pressure? | **Yes** during every generation, under the baseline apps. It completed, but the system was thrashing. |
| Recovery | After ComfyUI exits: free memory 66–76%, ~3.2–4.9 GB reclaimable within seconds |
| Success | Yes, 11/11 generations completed |
| Quality | Standard sampler: usable flat-colour comic scene (good as a background). LCM: softer/blurrier but usable. Character on plain background: crude (glasses became a black bar; ignored "white background", made it orange) but cut out cleanly. SD 1.5 at 512×896 shows no duplicated-subject artefacts in these samples (small sample). |
| Commercial license | CreativeML OpenRAIL-M (HF API): commercial use permitted with use-based restrictions that must be passed on. LCM-LoRA: OpenRAIL++. Not legal advice. |

Rejected before download: sd-turbo (Stability AI Community License: commercial only under US$1M revenue, with registration terms) and SDXL-class models (too large for 8 GB).

## 3. Piper results

| Metric | English | Hindi |
|---|---|---|
| Voice/model | `en_US-libritts_r-medium` (speaker 0 of 904; chosen arbitrarily) | `hi_IN-rohan-medium` |
| Model size | 78.6 MB | 63.0 MB |
| Model load time | 0.63 s | 0.47 s |
| Generation time | 0.47 s first / 0.15 s steady for 4.46 s of audio (**RTF 0.034**) | 0.25 s / 0.22 s for 6.95 s of audio (**RTF 0.032**) |
| End-to-end CLI call (what a backend would spawn) | 1.1 s | 0.9 s (pipeline run) |
| RAM | 191 MB footprint (220 MB RSS) | 269 MB footprint (298 MB RSS) |
| Quality (proxy only) | Whisper-small transcribed it **word for word** | Readable; char similarity 0.91, 26% word mismatch. Errors cluster on ट/ड/ढ/घ (राद, गूस, बूडे, पकर); cannot tell whether voice or recognizer is at fault. **Needs a human listen.** |
| Hindi works? | n/a | Yes, intelligible but imperfect pronunciation |
| Commercial license | See §8 | See §8 |

Also observed: Piper clips carry leading/trailing silence (Hindi clip ~0.29 s of leading silence), so subtitle timing derived from clip duration alone can be ~0.3 s early; trim silence before timing.

## 4. FFmpeg results (FFmpeg only for visuals; no Blender)

| Test | Result |
|---|---|
| Resolution / FPS / length | 1080×1920, 30 fps, 300 frames, exactly 10.000 s, H.264 High, yuv420p, AAC 44.1 kHz |
| Inputs | 1 background PNG (SD output upscaled 2×), 1 character PNG (SD image, background keyed out), 1 prop PNG, 3 subtitle PNGs, 1 audio track, SRT |
| Encoder | `h264_videotoolbox` (10 Mb/s) and `libx264` (CRF 20, medium) |
| Render time | **VideoToolbox 3.7–4.3 s** (5 runs, ≈2.7× real time); libx264 6.7 s (2 runs) |
| CPU | VT: ~10.3 s user (~2.5 cores); libx264: ~38.9 s user (~5.8 cores). Filter graph alone (no encoder): 3.6 s real / 9.8 s user, so the animation filters are almost the whole VT cost: the hardware encoder is effectively free |
| Output size | VT 10.1 MB; libx264 6.7 MB |
| Quality vs lossless reference | VT: PSNR(Y) 37.3 dB, SSIM 0.988. libx264: PSNR(Y) 42.5 dB, SSIM 0.994 |
| Peak memory (max RSS) | VT 446 MB; libx264 1.0 GB |
| VideoToolbox | Works reliably (5/5 renders, no errors); full decode clean; macOS QuickLook rendered a thumbnail (native AVFoundation decode OK) |
| Audio / sync | Audio and video both 10.000 s. Speech onsets measured in the muxed MP4: 0.41 s and 2.86 s vs planned 0.40/2.85 s. Third clip onset 5.81 s vs planned 5.52 s (Piper leading silence; needs trimming) |
| Subtitles | **Cannot use FFmpeg's own** (no libass). Worked via pre-rendered PNG overlays with fade + slide-in. Hindi must be rendered by a real text shaper: **Pillow without raqm mangles conjuncts and the short-i vowel** (विज्ञान, प्रश्न, क्षत्रिय); **macOS CoreText renders them correctly** |
| Motion effects (all in one filter graph) | Slow background zoom (1.0→1.2×), horizontal pan, character slide-in with ease-out + walking bob, idle "breathing" scale, impact shake, scale-up approach toward camera, walk across scene, prop pop-in with overshoot, subtitle fade/slide |
| Overall | **Works.** Frames at 8 timestamps show the intended motion, correct subtitle on/off timing, correct Hindi shaping. Smoothness of motion (e.g. zoompan stepping) was **not** verified by eye. Motion is "puppet-style": sliding/scaling cut-outs, no limb animation |

Not tested: articulated limbs / head turns (rotating separate body-part layers), lip-sync, multi-layer parallax, longer clips, sustained thermal load on a fanless Air.

## 5. Hardware verdict: **YELLOW**

Feasible with compromises.

- **GREEN parts:** Piper (~1 s per line, <300 MB), FFmpeg rendering (~4 s for 10 s of 1080×1920 with VideoToolbox), Ollama alone (a few GB, ~40 s for a full story as measured in Phase 1).
- **The compromise is image generation.** It works, but: (a) 36 s/image with LCM-LoRA or ~105 s at standard quality; (b) it drives the machine to 3–14% free memory and ~3 GB through swap *per image* while other apps are open; (c) native 512×896 must be upscaled to 1080×1920 (soft); (d) SD 1.5 characters are crude and character consistency was **not** tested.
- **Hard constraint:** Ollama must be unloaded before ComfyUI starts (3.5–5× slowdown and up to 9.4 GB swap otherwise).
- Not RED, because the whole chain completed in 67 s for a 10 s demo and everything recovers fully between stages. Not GREEN, because of the memory pressure and image speed. Arithmetic from measured per-image times (an extrapolation, **not** a measurement): 20 images ≈ 12 min with LCM, ≈ 35 min at standard quality.

## 6. Test 4: sequential pipeline (one scripted run, 67 s total)

| Stage | Wall time | Memory during stage (base apps open) |
|---|---|---|
| 1. Ollama scene-plan call (tiny output: 1 scene, 82 tokens; a full story took ~40 s in Phase 1) | 6.2 s (2.3 s load + 3.4 s generate) | free 18% min; llama-server resident |
| 2. Ollama unload + verify | 3.1 s | `api/ps` empty, `llama-server` process gone; free 55% |
| 3a. ComfyUI start | 12.6 s | free 55% |
| 3b. ComfyUI generate, LCM 512×896 (cold model load included) | 35.7 s | free **13%** min; swap 3.8→6.5 GB; footprint 4.5 GB |
| 3c. ComfyUI free + stop | 2.1 s | process gone, port closed; free **74%**, 4.9 GB reclaimable |
| 4. Piper, 3 clips (separate CLI each) | 3.2 s (1.2/1.1/0.9 s) | footprint 139 MB; free 74% |
| 5. FFmpeg render (VideoToolbox) | 3.9 s | ffmpeg footprint 394 MB; free 73% |

**The sequential architecture is practical.** Only stage 3b stresses the machine, and it releases everything on exit. Ollama and ComfyUI must never overlap.

## 7. Recommended architecture (from measurements only)

```text
Ollama (llama3.2) ──► validated Scene JSON
        │  GATE: keep_alive:0, verify /api/ps empty and no llama-server process
        ▼
ComfyUI, started on demand (~13 s), ONE session batching all images for the project
   (SD 1.5 fp16 + LCM-LoRA, 512×896, ~36 s/image), then stopped
        │  GATE: process gone, port closed
        ▼
Asset prep: background upscale; character on flat colour → global colour-key → alpha PNG
        ▼
Piper CLI per dialogue line (~1 s each) → trim leading/trailing silence → timeline + SRT
        ▼
Subtitle PNGs (CoreText on macOS, or a libass-enabled FFmpeg) 
        ▼
FFmpeg filter graph (zoompan / overlay with time expressions) → h264_videotoolbox → 1080×1920 MP4
```

Changes from the chain you proposed: (1) batch every image in one ComfyUI session instead of starting it per scene; (2) explicit verified memory gates between stages; (3) subtitles are a separate rendering step, because this FFmpeg has no libass (alternatively install a libass-enabled FFmpeg build, which I did not do); (4) check free memory/swap before the image stage and warn the user to close heavy apps (browsers); (5) LCM as the default image mode, standard sampler as an optional "quality" mode.

## 8. Blender decision

**NO: FFmpeg is sufficient for the first version.** The test produced slow camera zoom and pan, character entrance, walking motion, scaling, impact shake, a pop-in prop, timed and animated subtitles and synchronised audio in a 3.8 s render. Blender would add a large install and a second runtime for effects FFmpeg already did. Caveat: this was puppet-style motion of whole cut-outs. If you later want articulated limbs or head turns, the options are rotating separate body-part layers in FFmpeg (untested) or adding Blender; that can wait.

## 9. Model / license notes

| Item | Source | License | Commercial YouTube use | Notes / restrictions |
|---|---|---|---|---|
| SD 1.5 fp16 checkpoint | `Comfy-Org/stable-diffusion-v1-5-archive` (HF), SHA-256 matches HF's published hash | CreativeML OpenRAIL-M (per HF API) | Appears permitted | Use-based restrictions (Attachment A) must be passed to downstream users; must include license copy when redistributing the model. I did not compare against the original, now-removed RunwayML hash. |
| LCM-LoRA SD1.5 | `latent-consistency/lcm-lora-sdv1-5` (HF) | OpenRAIL++ (per HF API) | Appears permitted | Use-based restrictions apply |
| `en_US-libritts_r-medium` | `rhasspy/piper-voices` (HF) | Model card: dataset LibriTTS-R, **CC BY 4.0** | Dataset license permits it **with attribution** | **Model card says "fine-tuned from English lessac medium."** The Lessac data licence (Edinburgh/Lessac Blizzard 2013) is registration-based and granted to the named licensee only, so whether it passes obligations to derived weights is **unresolved**. **I earlier called this voice "trained from scratch"; that was wrong.** |
| `hi_IN-rohan-medium` | `rhasspy/piper-voices` (HF) | IIT Madras IndicTTS EULA | Text I read (Internet Archive copy; IIT's site was unreachable) grants a perpetual, worldwide, royalty-free license, with derivative works owned by the licensee, and has no non-commercial clause; redistributors must keep IITM's copyright notice | **Also fine-tuned from the Lessac voice**, same unresolved question. Other Piper Hindi voices (`pratham`, `priyamvada`) are **CC BY-NC-SA: not usable commercially**. Get legal review before monetizing. |
| Piper software (`piper-tts`) | PyPI / OHF-voice/piper1-gpl | GPL-3.0-or-later | Running it as a separate process and using its audio output is not restricted by the GPL; do not link/ship it inside a closed app without checking | |
| ComfyUI | github.com/comfyanonymous/ComfyUI | GPL-3.0 | Same as above (separate process; outputs are yours) | |
| Whisper-small (`Systran/faster-whisper-small`) | HF | MIT | n/a: test-only tool, not part of the product | Can be deleted: `models-asr-testonly/`, `venv-asr-testonly/` |

I did not verify any license beyond the sources named. Treat all "appears permitted" entries as needing legal confirmation before publishing monetized content.

## 10. Open items I did not test

- Character consistency (IP-Adapter / reference-image conditioning): would add models and RAM; needs its own feasibility test.
- Whether results improve with other apps closed (never measured; the user's real conditions were used).
- Long sustained runs (thermal throttling on a fanless MacBook Air).
- Playback smoothness by eye; Hindi voice naturalness by ear.
- A libass-enabled FFmpeg (would simplify subtitles).
