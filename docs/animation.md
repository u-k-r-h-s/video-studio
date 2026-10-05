# The layered animation engine

A camera zoom on a still image is not animation. This engine turns generated artwork into **separate visual elements** and moves
them: characters walk, turn their heads and react; props and doors move; weather and light are alive; the camera follows the
action; sound is driven by the movement. It is local, CPU-only (a Skia canvas via `@napi-rs/canvas` piped to FFmpeg), needs no
video model, and renders a 3 s 1080x1920 shot in about 4-7 s on the M1.

```
idea -> Ollama director -> story / scenes / shots (semantic actions)
     -> asset manifest (what to generate, what exists)  -> ComfyUI: locations, character views, faces, props (+ BiRefNet matte)
     -> animation compiler (shot -> layers + timed events + camera)  -> layered renderer (canvas, 30 fps)  -> grade/captions (FFmpeg)
     -> voices + footsteps/doors/impacts locked to the motion + music -> 1080x1920 H.264/AAC MP4
```

**This is the pipeline behind `npm run short`** (profile `animated-short`, `pipeline: "animated"`). The still-image pipeline
(`cinematic-animated-short`) is still there as `--profile cinematic-animated-short`, but the animated pipeline never falls back to it:
the render stage marks every clip `renderer: "anim"` and assembly refuses a project with any clip that lacks the mark
(`test/anim-pipeline.test.ts` fails if that ever regresses).

## Pipeline stages (`apps/server/src/pipeline/stages/animated/`)

| stage id | file | what it does |
|---|---|---|
| `scene_planning` | `planAnimStory.ts` | director (small structured Ollama calls) -> story; `shots/animationRules.ts` reads the physical verbs of each sentence and guarantees that a quarter of the character shots travel; then the **asset manifest** is saved as `manifest.json` |
| `image_generation` | `generateAnimAssets.ts` | one ComfyUI session: locations, the character's front view, other camera views, face variants, props; each cut out with BiRefNet and checked (`lib/matte.ts`); cached by content hash |
| `voice_generation` | (shared) `generateShotVoices.ts` | Piper; digits are spelled out first (`lib/spoken.ts`: "13" -> "thirteen") |
| `subtitles` | `buildAnimTimeline.ts` | timeline = real voice durations + time each action needs; word-timed captions; soundtrack incl. cues from the animation (`anim/cues.ts`) |
| `scene_render` | `renderAnimShots.ts` | `anim/compose.ts` (compiler) -> `AnimEngine` -> FFmpeg; clips cached by hash of composed shot + art used |
| `assembly` | `assembleAnimShots.ts` | guard (every clip is `renderer: anim`), join, mux, loudnorm |

### The director states intent, the compiler decides numbers

The model writes coarse semantic actions: `walk toward the building`, `turn toward the sound`, `look-down toward the phone`,
`run away`, object `door: open`. It never writes pixels, coordinates, frame numbers or transforms. `anim/semantics.ts` resolves the
words ("toward the door" -> direction `object`, "the sound" -> screen right, "away" -> into the depth), `anim/compose.ts` places the
action in time (`when` -> seconds), picks the camera view of the character (walking right = side view, towards the camera = front),
moves the layers and the camera, and `anim/cues.ts` derives the sounds. Same input -> byte-identical output (tested).

### Asset manifest (`anim/manifest.ts`)

`planAssets(story, characters, settings)` lists exactly what the shots need and nothing else: one wide background per location,
per character the **views** its actions need (front always; side for a walk, three-quarter for a turn, back for walking away), the
**face variants** its close shots need (look left/right, surprised, worried, smile, angry), and props from the objects that move
(door, phone, car, package, generic). Every asset has a stable id (`loc-*`, `char-<id>-<view>`, `head-<id>-<variant>`, `prop-*`)
and a hash of everything that defines it (prompt, size, steps, cfg, model, recipe version). Generation compares hashes with what the
project has and with a content-addressed cache shared by all projects (`projects/.asset-cache`), so an unchanged asset is never
generated twice. Other camera views are **text-to-image** with the same costume text and the same seed as the front view
(measured: img2img from the front view returns the front view again, even at denoise 0.85).

### Characters are puppets, not moving pictures (`anim/mannequin.ts`, `anim/puppet.ts`)

Each character is ONE generated picture, drawn img2img over a procedural grey **mannequin** in a relaxed A-pose (denoise 0.78).
The image model keeps the start picture's composition (measured), so every character comes out with the arms held clear of the
body and the legs apart, and the mannequin's joint positions are known in advance. Prompting for an A-pose or for a two-view
character sheet did not work with DreamShaper (arms stay against the body; the "sheet" gave two different front views).

`segmentFigure` labels the cut-out (head, torso, near/far arm, near/far leg) row by row from the mannequin's bone priors and the
gaps between limbs; where an arm touches the body, its real width is measured where it hangs free. `buildPuppet` cuts:

| part | pivot | notes |
|---|---|---|
| coat / hips | waist | lags 80 ms behind the body, swings with the stride |
| torso | hips | leans (more when running), rocks with the steps |
| head (hair, cap) | neck | lags 120 ms (hair bounce); the face area underneath is plain skin |
| face | neck | slides over the head for looks/turns; expressions replace only this ellipse |
| upper arm / lower arm + hand | shoulder / elbow | hand frame drives held props |
| thigh / shin + foot | hip / knee | the lowest foot is kept on the floor (grounding), so the body drops when the legs spread |

There is no second view: the same picture is mirrored when the character faces the other way, so face, hair, costume and
proportions never change between shots (consistency over view variety). A turn is a quick squash-and-flip hidden by the hair and
coat swing. Expressions (smile, surprised, worried, angry) are img2img redraws of the head crop at denoise <= 0.56 and only their face
ellipse is used, so the cap and the hair never pop.

**Motion** (`CharacterTimeline.puppetPose`): a walk/run cycle derived from distance (legs alternate, arms counter-swing, knees bend
on the swing, torso leans and rocks, coat and hair lag); gestures as shoulder/elbow targets (`point`, `raise-hand`, `wave`, `reach`,
`push`, `pull`, `hold`, `raise-object`, `lower-object`, `hold-phone`, `react`/`surprise`, `fear`, `hand-gesture`); looks turn the head
and slide the face (no picture swap).

**Held props** (`VisualLayer.parent = { layerId, hand }`): drawn in the hand's frame right after that arm, so they move and are
occluded with it. A torch is procedural (`makeFlashlight`) and casts a beam along the forearm while its `glow` event is on; a phone
is procedural too. Doors are pushed (`push`) when they open.

**Director**: action-first slots per shot (`move`, `gesture`, `reaction`, a few plain words each, e.g. "walk to the door" / "raise the
flashlight" / "stop and listen"), turned into semantic actions by fixed verb rules (`shots/animationRules.ts`).

**Backgrounds** are prompted empty (beings are removed from the place text; a strong negative list), and each one is matted once as a
check: an upright compact figure in the matte rejects the picture and it is regenerated (`figureInBackground`).

**Quality test**: `npx tsx scripts/lab/anim-quality-test.ts` (walk 4 steps, stop and listen, raise an arm, raise a torch and aim it,
react, run away; rain, fog, flickering lamp) -> `~/Desktop/animation-quality-test.mp4`. `scripts/lab/puppet-debug.ts` shows the
segmentation and a row of poses.

### Cut-outs: matte, not colour heuristics (`lib/matte.ts`, `anim/assets.ts`)

BiRefNet runs in the same ComfyUI session (`LoadBackgroundRemovalModel` -> `RemoveBackground`), and its foreground matte is the
alpha channel directly. White, black, grey, skin, pastel and glossy things stay exactly where the model says foreground is.
A quality gate rejects an empty matte, a full-frame matte, a figure split into pieces, and a figure whose head or feet are cut off
by the frame; a rejected asset is regenerated with a new seed (up to 3 rounds). A hand + phone gets a second matte pass on the
residual. If ComfyUI crashes natively (seen once in the matting model under memory pressure) the provider restarts it and retries.


## Model (`apps/server/src/anim/types.ts`)

* `VisualLayer { id, type: background|midground|character|prop|foreground|effect, source, x, y, scale, opacity, zIndex, parallax, ... }`
  Parallax: 1 = locked to the world, < 1 distant (moves less), > 1 foreground (moves more, also zooms more).
* `AnimationEvent { start, duration, targetId, type, params }`. Types:
  character: `idle walk run enter exit turn look-left look-right look-up look-down look-center head-turn nod shake-head lean step-forward
  step-back hand-gesture point react surprise fear anger smile`; object: `move scale rotate fade appear disappear shake flicker open close
  glow drive`; `camera` with `params.mode` = `pan push roll follow shake flash`.
* `EffectSpec`: `rain fog dust snow smoke leaves lightFlicker sparks streaks` (procedural, deterministic).
* `AnimShotSpec = { duration, layers, events, effects, camera }`: a shot is data. `AnimEngine` evaluates it as a pure function of time.

## Characters (`rig.ts`, `character.ts`)

A keyed full-body figure is cut into a **puppet**: head (above the neck), torso, left leg, right leg. Cut lines come from analysing the
silhouette (the narrowest row under the head, the row where the legs separate). Parts overlap with feathered seams and rotate about
their joints; the rig is padded above the head so a taller hairline is never clipped.

* **Walking is derived from distance travelled**: leg phase = distance / stride (distance in character heights), so feet never skate,
  any horizontal move walks or runs, and a stop stops the legs. Per step: body bob, torso sway, opposed leg swing and lift. Running
  swings further, leans forward and has a longer stride. Walking toward the camera (`y` + `scale` params) also covers ground.
* **Head and face**: looks and expressions cross-fade between redrawn heads (`front lookL lookR surprised smile worried angry`),
  made by img2img on a 512 px head crop (sharper than the body), plus head rotation/offset/squash. Mirrored correctly when the body
  turns; without variant art the head transform alone still moves.
* `turn` flips the facing through a squash; `nod`, `shake-head`, `lean`, `step-*`, `react`/`surprise` (pop, hop, head back),
  `fear` (tremble), `anger`, `smile`, fade/appear/flicker (glitch) are transient or held states.
* Lighting match: scene tint, a thin rim light on the upper body, a contact shadow, event-driven glow (a phone lighting the face).

## Cut-outs, heuristic fallback (`lib/chroma.ts`)

Kept for the lab scripts. The pipeline uses the matte above. The image model ignores "green screen" and draws a grey studio backdrop, so keying is by **flood fill of low-saturation, mid-brightness
pixels from the border** (`keyGreyBackdrop`): the cast is dressed in saturated colours (white or grey clothing leaks: the prompts say so),
edges are eroded, defringed and feathered. Head variants use the same keyer on a light backdrop with an adaptive brightness floor and
`closeAlpha` to fill notches. (Keying by colour distance deleted white trousers; a flood fill with a continuity test leaked too.)

## Director -> events (`actions.ts`, shared `Shot.animation`)

The director states, per shot, a few physical actions with a coarse `when` (`start early mid late end`) and objects that move. The
compiler turns them into timed events and a camera that responds (follow a walker, shake on a startle, push harder when tense).
The model never writes seconds or pixels.

## Sound driven by motion

`audioCuesFor(spec)` (`anim/cues.ts`; `engine.audioCues()` is the same) returns footsteps on every foot contact (from the gait), door sounds on `open`, `sfx` params on events, and an
impact for strong camera shakes. The lab scripts mix them with ambience, rain, a tension bed and ducked voices.

## Checking a finished short

```bash
npx tsx scripts/audio-plan.ts <project-id>                    # what the soundtrack should contain (voice slots, cue times)
venv-asr-testonly/bin/python scripts/audio_check.py ~/Desktop/<video>.mp4 /tmp/audio-plan-<project-id>.json
```

Reports loudness (LUFS/true peak/clipping), silent stretches, per-line Whisper intelligibility and start error against the timeline,
and whether each footstep/door/ping/impact has a transient within 60 ms of its planned time. Nobody can *listen* here; these are
measurements, not a verdict on how it sounds.

## Try it (lab scripts, assets in `projects/anim-lab`, not committed)

```bash
npx tsx scripts/lab/anim-assets.ts ...            # backgrounds/props/characters via ComfyUI (see the scripts)
npx tsx scripts/lab/anim-prep.ts <char-id> <props...>   # keyed cut-outs + rig analysis + head crop
npx tsx scripts/lab/anim-heads5.ts <char-id>      # expression/look variants (img2img)
npm run anim:test                                  # the five-part animation test -> projects/anim-lab/out/animation-test.mp4
npm run anim:short                                 # "The Last Delivery", 10 shots, ~29 s -> projects/anim-lab/short/
```

## Honest limits (measured on real runs, 2026-10-06)

Two complete runs of `npm run short` from an idea (7B director): a night guard in a museum and a lighthouse keeper. Both give a 1080x1920,
30 fps, H.264/AAC video of 23-28 s in 12-21 minutes on the 8 GB M1. What is real and what is weak:

* **Real**: characters walk in profile with alternating legs, turn through a three-quarter view, change expression (face variants),
  a door opens with light spilling out, rain/fog/dust move, the camera follows, footsteps and door sounds land within 60 ms of the
  visible event, speech is intelligible (Whisper recovers every line).
* **Identity drifts between camera views.** Each view is a separate text-to-image render (img2img from the front view only returns the
  front view). The front view and the side view of the same character can look like different people (hair length, coat). This is the
  most visible flaw.
* **Paper-doll look.** Cut-out puppets: arms swing only in non-profile views, a long coat is rigid, faces are swapped variants (the
  expression pops rather than morphs), the "double"/ghost is a tinted copy. Close-ups of a standing character are still close to a slideshow.
* **The director is the ceiling.** The 7B model often writes few physical actions, so the pipeline reads verbs from the sentence and
  forces a quarter of the character shots to walk. Stories are generic.
* **Props are generated art, not 3D.** Doors get a frame, perspective leaf, dark interior and light spill; a "drawing" or "flashlight"
  is a flat generated sprite and sometimes the wrong object. A location image may contain things nobody asked for (a fox, a ghost at the end of a hall).
* **Memory.** ComfyUI + BiRefNet reached an 8.3 GB footprint and 9 GB swap on the 8 GB machine (free memory 2 %); it finished, and one
  native ComfyUI crash in the matting model was recovered by the restart logic. Close other apps.
* **Audio**: loudness -16 LUFS, true peak -1.4 dBTP, no clipping. Nobody has listened to it; voice start alignment against the plan could
  only be bounded to about 0.3 s by measurement.
