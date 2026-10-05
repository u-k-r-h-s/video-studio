# Pipeline

> This page describes the scene pipeline (`motion-comic`). The shot pipeline (`cinematic-animated-short`) uses the same
> stage ids, gates, caching and regeneration; its stages are listed in [shots.md](shots.md). The animated pipeline
> (`animated-short`, the default of `npm run short`) also keeps the stage ids and gates; its stages are in
> [animation.md](animation.md#pipeline-stages-appsserversrcpipelinestagesanimated).

```
User idea / script
      │
      ▼  create_scene_plan          Ollama -> validated Scene Plan   (then Ollama is unloaded and verified)
 Human review / edit               ── nothing heavy runs until the plan is approved ──
      │  approve
      ▼  generate_images            ONE ComfyUI session: backgrounds, characters, props -> cut-outs
      ▼  generate_voice             Piper per dialogue line, silence trimmed
      ▼  render_scene               timeline + subtitle PNGs (stage "subtitles"), then FFmpeg clip per scene
      ▼  assemble_video             concat clips -> final 1080x1920 MP4 + SRT
```

`Studio.produce()` runs the last four tools in this order. Every stage is **idempotent**: it computes what it
needs, skips whatever is already fresh, and does only the rest. That is also how resuming works.

## Stages

| Stage id | Tool | Needs | Produces | Gate |
|---|---|---|---|---|
| `scene_planning` | `create_scene_plan` | idea/script, profile | characters, scenes (validated); status `review` | ComfyUI stopped before; Ollama unloaded + verified after (always) |
| `image_generation` | `generate_images` | approved plan | `images/<asset>.png` (+ `.raw.png` for cut-outs) | Ollama unloaded -> ComfyUI start -> `/free` -> stop -> verified stopped |
| `voice_generation` | `generate_voice` | approved plan | `audio/<dialogue>.wav` (trimmed), `AudioAsset` | ComfyUI stopped |
| `subtitles` | `render_scene` (part 1) | all voices | dialogue start/end, scene duration, subtitle PNGs, `audio/<scene>.wav` | none (CPU/CoreText) |
| `scene_render` | `render_scene` (part 2) | images, timeline | `scenes/<scene>.mp4` | ComfyUI stopped, Ollama unloaded |
| `assembly` | `assemble_video` | all scene clips | `final/final.mp4`, `final/subtitles.srt` | none |

Stage state is stored per stage (`pending`, `running`, `completed`, `failed`, `cancelled`, with `startedAt`,
`completedAt`, `durationMs`, `error`). Project status: `draft -> planning -> review -> approved -> generating ->
completed` (or `failed`).

## Assets needed per project

- **Background**: one per *location* (shared by every scene at that location; id `bg-<location>`). Its prompt
  describes the place only: LCM runs at cfg ~1.5 where negative prompts barely work, so people must never appear
  in a shared background prompt. A scene can get its own background (`bg-<scene>`, via "New background") whose
  prompt may add the people-free parts of the scene description.
- **Character**: one per character (`char-<id>`), shared by every scene. Prompt = style + the character's
  `appearance` text + "isolated on a plain white background, no frame".
- **Prop**: one per prop per scene (`prop-<scene>-<name>`). Scene-scoped so regenerating one scene never changes
  another. (Trade-off: the same prop used in two scenes is generated twice.)

Seeds are deterministic (`project:asset:attempt`). An asset's `inputHash` covers kind, prompt, negative prompt, size,
provider and the recipe version (`IMAGE_RECIPE_VERSION`); bump the version to invalidate cached images after a
workflow/prompt change.

## Voice and timeline

Voices: narrator -> profile narrator voice; character -> its `voiceId` or round-robin from the profile pool.
After Piper, leading/trailing silence is trimmed. The timeline (`render/timeline.ts`) places lines from real audio
durations: lead-in 0.4 s, each line, 0.35 s gaps, 0.7 s tail. For scenes **with dialogue the scene duration is
derived** from the voice (never shorter than the profile minimum, 5 s for `motion-comic`); silent scenes keep the
planned duration. Dialogue `startTime`/`endTime` are written back into the plan; subtitle cues come from them (a very
long line is split at sentence/danda boundaries). Each scene gets one mixed audio track (`mixTimeline`, sample-accurate).

## Motion

Per scene, `planMotion` produces primitives from hints + timeline:

- camera: `zoom_in/out` (1.0x -> 1.18x), `pan_left/right` (with a constant zoom for slack), `static`; `shot` sets a base zoom
- characters: slide in from the `entrance` side (ease-out, walking bob), then "breathing" scale; stronger scale pulse
  while that character speaks; `emphasis: impact` shakes all characters, `surprise` pops the first one
- props: pop in with overshoot (`ease_out_back`)
- subtitles: fade in/out and slide up

## Regeneration and caching

`Studio.regenerateScene(project, scene, {parts, includeBackground, includeCharacters})` re-runs the stages for that
scene only; parts are `assets` (the scene's props, and with `includeBackground` its own background; characters only
with `includeCharacters`, because they are shared), `voice`, `render`. Forced items get a new `attempt`/seed and a new
`createdAt`; the downstream render and assembly hashes include those, so a regenerated image or voice always
invalidates exactly the dependent clip and the final video. Everything else is served from cache. The final video is
re-assembled from cached and new clips. There is no diffing beyond hash equality.

Editing the plan after approval is allowed: only items whose inputs changed are regenerated on the next run.
`PUT /plan` clamps scene durations to the profile range, renumbers dialogue ids by position and keeps assets.

## Failure, cancel and resume

| Situation | Behaviour |
|---|---|
| a stage throws | stage `failed` with a user-readable message, project `failed`, later stages not run; technical detail in `logs/pipeline.jsonl` (`status=diagnostics`) |
| image batch fails midway | finished images stay registered; ComfyUI is still freed/stopped; next run generates only the missing ones |
| cancel | `AbortSignal` reaches the stage; ComfyUI is interrupted and stopped; stage `cancelled` |
| server crash / restart | `running` stages become `failed` ("Interrupted by a server restart"); rerun resumes by hash |
| a gate fails | the stage fails with the gate's message ("Ollama model could not be unloaded.", "ComfyUI could not be stopped.") and nothing further runs |

## Logs

Console and `projects/<id>/logs/pipeline.jsonl`, one record per event, for example:

```
project=abc stage=image_generation scene=scene-02 asset=prop-scene-02-wooden-mousetrap status=started
project=abc stage=image_generation scene=scene-02 asset=prop-scene-02-wooden-mousetrap status=completed durationMs=38122 seed=1234
project=abc stage=image_generation status=memory freePercent=53 swapUsedMb=2532
```

`status=memory` / `warning` lines record macOS free memory and swap before the image stage (a warning is logged when
free memory is below `MEMORY_WARN_FREE_PERCENT`; it never blocks).

## Script mode

`inputMode: "script"` converts an existing script into scenes **without rewriting it**. Two paths:

- **`NAME: line` scripts** (one speaker line per row; `NARRATOR:` maps to the narrator). The script itself defines
  everything about the dialogue, so the model is *not trusted with it*: the cast is dictated from the speakers (the
  outline must contain exactly those ids, otherwise it is sent back for repair), the lines are distributed over scenes
  **deterministically** (contiguous groups in the original order, balanced by word count), and the model only designs
  each scene's visuals (location, description, props, camera, motion) knowing which lines its scene contains. Dialogue
  text, order and speakers always come from the script. Measured reason: on the target machine llama3.2 (3B) renamed the
  cast, reordered lines and duplicated a line when it was asked to regroup them itself, and failed outright after
  three repair attempts.
- **Other scripts** (prose, no `NAME:` form): the model returns dialogue and every line is checked to occur in the script
  (case/punctuation-insensitive); offending lines are sent back for repair. Weaker guarantee: order, speakers and
  punctuation are not enforced.

Rewriting happens only when explicitly allowed (`allowRewrite` in the planner input; there is no UI switch for it yet).

## Measured on the target machine

MacBook Air M1, 8 GB, macOS 26.3.1, with other apps open (Claude desktop, a browser) as in normal use. Raw data:
`results/phase2a/demo_final.txt` (driver output) and `results/mem_demo_final.csv` (memory sampled every 2 s by
`scripts/memmon.py`). Memory here is system-wide (`memory_pressure`, swap) plus macOS `footprint` per process, because
process RSS does not include GPU memory.

**Clean run: idea -> final MP4 (`node scripts/demo.mjs`, a fresh project, 2026-10-04)**

| Stage | Wall time | Notes |
|---|---|---|
| scene planning (Ollama, llama3.2) | 36.5 s | outline ~10 s, scenes ~26 s, 0 repair rounds; Ollama unloaded + verified |
| image generation (ComfyUI, one session) | 248.4 s | 6 images (1 background, 2 characters, 3 props), 28.5-46.3 s each, 0 quality retries |
| voice generation (Piper) | 6.5 s | 6 lines, ~1 s each |
| subtitles + timeline | 0.5 s | CoreText PNGs for 6 cues + 3 scene audio tracks |
| scene render (FFmpeg, VideoToolbox) | 6.4 s | 3 clips of 5.0 s, 2.0-2.2 s each |
| assembly | 0.3 s | concat + SRT |
| **total** | **302 s** (generation after approval: 263 s) | final video 1080x1920, 30 fps, 15.0 s, H.264 + AAC, 15.6 MB |

**Memory per stage (same run)**

| Stage | Min free memory | Swap | Swapped out | Peak process footprint |
|---|---|---|---|---|
| scene planning | 17% | 3.75 GB (flat) | 0.2 GB | llama-server 0.6 GB |
| **image generation** | **5%** | **3.6 -> 7.5 GB** | **32.0 GB** | ComfyUI 4.7 GB |
| voices / subtitles / render / assembly | 70-71% | flat | 0 | Piper 24-28 MB, FFmpeg ~350 MB |

ComfyUI and the Ollama model were never resident in the same sample (0 of 137). After ComfyUI exits, free memory is back
to ~70% within seconds. **The image batch writes about 32 GB to swap per project** while other apps are open, which is a
real cost (time, and SSD wear if done constantly); closing browsers first helps, and reducing it is Phase 2B work.

**Cache and regeneration, measured on real projects**

- A subtitle-style change re-ran only the subtitle PNGs, the 3 clips and the assembly: **8 s**, with no ComfyUI or Piper activity.
- Regenerating one scene's voice from the UI ran Piper for that scene's 2 lines only, rendered only that scene, and re-assembled.
- Re-running a finished project does nothing (no provider calls).

**Image quality control, measured:** with the original wording ("full body character design ... sticker style") both
characters failed the cut-out check three times each (~120 s per character); with the simple wording in
`imagePrompts.ts` the same machine produced usable characters first time (6 of 6 lab images passed across three simple
phrasings). Output art is still crude: see the README limitations.
