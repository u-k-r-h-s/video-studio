# Architecture

Video Studio is a local-first pipeline that turns an **idea or a script** into a vertical short video. It is
**generic by construction**: nothing in the pipeline assumes "comic". Everything format-specific (resolution, which
providers to use, visual style, timing rules, layout) lives in a data object called a **FormatProfile**. The first
and only profile is `motion-comic`. Adding another (documentary, whiteboard, ...) means adding a profile and, if it
needs different rendering, a new `SceneRenderer`; the stages, store and API do not change.

Status: **Phase 2B-Replacement**. Two formats share the same layers: `motion-comic` (scene pipeline) and
`cinematic-animated-short` (shot pipeline, see [shots.md](shots.md)). See [pipeline.md](pipeline.md) for the stages and
[providers.md](providers.md) for the replaceable components.

## Layers

```
 Web UI (React)  ──HTTP/SSE──►  Express API (loopback only)
                                   │
                                   ▼
                       Studio  (sequences the tools)
                                   │  dispatch(name, input)
                                   ▼
                        ToolDispatcher  ── allow-list of 6 tools ──► PipelineRunner (stage state)
                                                                          │
              ┌────────────┬──────────────┬──────────────┬───────────────┴──────┬──────────────┐
              ▼            ▼              ▼              ▼                      ▼              ▼
        ScenePlanner  ImageProvider   TTSProvider  SubtitleRenderer       SceneRenderer   MemoryGate
        (Ollama)      (ComfyUI)       (Piper)      (CoreText)             (FFmpeg)        (Ollama/ComfyUI)
                                   │
                                   ▼
                  ProjectStore: projects/<id>/project.json (+ images/ audio/ subtitles/ scenes/ final/ logs/)
```

Nothing above talks to a tool directly: the UI never reaches ComfyUI, Blender, FFmpeg or Ollama. Every external
program is started through one `CommandRunner` with an explicit allow-list (see Security).

## Repository layout

```
packages/shared/        zod schemas + types used by server and web (the contract between stages)
apps/server/src/
  profiles/             FormatProfile registry (motion-comic, cinematic-animated-short)
  shots/                shot pipeline: director, story builder, key-visual planner, camera language, 2.5D shot renderer, timeline, captions
  audio/                deterministic SFX/ambience/music synthesis, ducking mixer, soundtrack planner
  planner/              Ollama scene planner (idea + script modes), prompts, normalisation
  llm/                  LLMProvider interface, OllamaProvider, structured-output + repair helper
  providers/{image,tts,subtitle}/   ImageProvider/ComfyUI, TTSProvider/Piper, SubtitleRenderer/CoreText
  render/               motion primitives -> FFmpeg expressions, motion planner, timeline, filter graph, renderer
  pipeline/             stages, PipelineRunner (persistent stage state), Studio (orchestration), plan editing
  tools/                Tool interface, ToolRegistry, ToolDispatcher, the six tools
  services/             MemoryGate, OllamaController, MemoryAdvisor, HealthService
  storage/              ProjectStore (JSON files, atomic, locked, schema-validated)
  jobs/ routes/ lib/    JobManager, HTTP API, command runner, logging, WAV/PNG toolkits
apps/web/               minimal studio UI
config/voices.json      voice catalog (names only; no weights)
scripts/                demo driver, native helper build, environment doctor, and the preserved feasibility harness
REPORT.md results/      hardware feasibility measurements (Phase 1.5), preserved unchanged
```

(The repository root is named `video-studio` on GitHub; a local checkout may have a different folder name.)

## Key decisions

**Data-driven FormatProfile.** `packages/shared/src/profile.ts` defines the schema; `profiles/motionComic.ts` and
`profiles/cinematicAnimatedShort.ts` are the instances. `pipeline: "scenes" | "shots"` selects the stage implementations
(the six allow-listed tools and the stage ids are the same; `PipelineRunner.pipelineOf` routes them). A profile selects components by registry key (`imageProvider: "comfyui"`, `ttsProvider: "piper"`,
`subtitleRenderer: "coretext"`, `sceneRenderer: "ffmpeg-motion"`) and carries video settings, style prompts, image
sizes, timing rules, planning limits, layout fractions and the voice pool.

**Strict contracts.** `Project`, `Scene`, `Dialogue`, `Character`, `Asset`, `AudioAsset` and the `Motion`
primitives are zod schemas. Every save validates; every LLM response is validated, deterministically normalised and,
if still invalid, sent back for repair (the model is never trusted and its output is never executed).

**Deterministic ids and hashes.** Scene, dialogue and asset ids are derived (`scene-02`, `scene-02-d01`,
`bg-<location>`, `char-<id>`, `prop-<scene>-<name>`, ...). Each asset stores an `inputHash` of everything that
determined it. A stage skips an asset whose file exists and whose hash is unchanged; a changed hash means regenerate.
This one mechanism gives caching, resume-after-crash, "edit one line, redo one voice" and scene-level regeneration.

**Constrained orchestration instead of an autonomous agent.** `llama3.2` (3B) is used only to return structured
data. A fixed, deterministic order decides what runs next. The six tools (`create_scene_plan`, `generate_images`,
`generate_voice`, `render_scene`, `assemble_video`, `get_job_status`) are the allow-list; `ToolDispatcher` is the
single entry point. The LLM is **not** wired to call tools in this version. The interface (name, description, zod
input schema, `execute`) and `GET /api/tools` (JSON Schema) are shaped so an LLM director could later be given an
allow-listed subset.

**Motion as data.** The planner emits a few enum hints per scene (camera movement, entrance side, emphasis). A
deterministic `MotionPlanner` turns them, plus the voice timeline, into `Motion` primitives (`pan`, `zoom`,
`translate`, `scale`, `shake`, `fade`, `pulse` with easings). `motionExpr.ts` compiles primitives into FFmpeg
expressions (translate/shake additive, scale multiplicative, so independent primitives compose). The model never
writes an FFmpeg expression.

## Memory gates (8 GB machine)

Heavy models never overlap. `MemoryGate` enforces the sequence and verifies state instead of trusting calls:

| Moment | Gate |
|---|---|
| before Ollama loads | `assertSafeToLoadOllama()` -> ComfyUI process gone **and** port closed |
| after planning (in `finally`) | `unloadOllama()` (`keep_alive:0`) then wait until `/api/ps` is empty **and** no `llama-server` process exists |
| before ComfyUI starts | `ensureOllamaUnloaded()` (inside `ComfyUIProvider`) |
| after image batch (in `finally`) | `/free`, stop (SIGTERM then SIGKILL), then `assertComfyUIStopped()` (process gone, port closed) |
| before Piper | `assertComfyUIStopped()` |
| before FFmpeg | `assertComfyUIStopped()` and `assertOllamaUnloaded()` |

A failed gate throws a user-readable error (e.g. "Ollama model could not be unloaded.") and the stage fails
instead of continuing. The tests deliberately remove each gate and confirm they fail.

## Security model

- The API binds to `127.0.0.1`, rejects non-loopback `Host` headers (DNS rebinding) and unlisted `Origin`s, and
  requires JSON bodies. There is **no authentication**: do not expose it.
- **No arbitrary command execution exists.** `CommandRunner` never uses a shell (arguments are arrays) and refuses any
  executable not on an allow-list derived from configuration (ffmpeg, ffprobe, the ComfyUI and Piper Python
  interpreters, the subtitle helper, `pgrep`, `memory_pressure`, `sysctl`). Text from users or the LLM (dialogue,
  prompts) is passed as a literal argument or inside image files, never interpolated into a command line or a filter
  graph.
- Project ids are validated and every path goes through `safeJoin`; the media endpoint serves only `.png/.mp4/.wav/.srt`
  from inside a project folder (project state, logs and dotfiles are refused). Symlinks inside `projects/` are not
  resolved.
- Model output is parsed, normalised and schema-validated before use.

## Persistence and recovery

`project.json` is the single source of truth: stage states (`pending/running/completed/failed/cancelled` with
timestamps, duration, error), the scene plan, the asset registry with hashes, errors and timestamps. Writes are
atomic (temp file + rename) and serialised per project. After a crash, `recoverInterrupted()` turns stages left
`running` into `failed` ("Interrupted by a server restart"); re-running the pipeline then skips everything already
fresh. Each image is registered the moment it is saved, so a crash mid-batch loses at most the image in flight.
Jobs themselves (the in-memory progress objects) are not persisted; the project state is.

## Observability

Every unit of work logs `project= stage= scene= asset= status=started|completed|failed durationMs=` to the console and
to `projects/<id>/logs/pipeline.jsonl` (plus `logs/comfyui.log` for ComfyUI's own output). Failures also write a
`status=diagnostics` record with the technical detail; the project and API only carry the user-readable message.
