# Pipeline

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

`inputMode: "script"` sends the script to Ollama to extract the cast and break it into scenes. By default dialogue
must be copied **verbatim**: every returned line is checked against the script text (case/punctuation-insensitive)
and the model is asked to repair any line that is not found there. Rewriting happens only when explicitly allowed
(`allowRewrite` in the planner input; there is no UI switch for it yet).
