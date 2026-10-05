# The layered animation engine

A camera zoom on a still image is not animation. This engine turns generated artwork into **separate visual elements** and moves
them: characters walk, turn their heads and react; props and doors move; weather and light are alive; the camera follows the
action; sound is driven by the movement. It is local, CPU-only (a Skia canvas via `@napi-rs/canvas` piped to FFmpeg), needs no
video model, and renders a 3 s 1080x1920 shot in about 4-7 s on the M1.

```
AI images (ComfyUI)  ->  cut-outs + rig  ->  shot spec (layers + events)  ->  frames (canvas)  ->  grade/captions (FFmpeg)  ->  mux with audio
```

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

## Cut-outs (`lib/chroma.ts`)

The image model ignores "green screen" and draws a grey studio backdrop, so keying is by **flood fill of low-saturation, mid-brightness
pixels from the border** (`keyGreyBackdrop`): the cast is dressed in saturated colours (white or grey clothing leaks: the prompts say so),
edges are eroded, defringed and feathered. Head variants use the same keyer on a light backdrop with an adaptive brightness floor and
`closeAlpha` to fill notches. (Keying by colour distance deleted white trousers; a flood fill with a continuity test leaked too.)

## Director -> events (`actions.ts`, shared `Shot.animation`)

The director states, per shot, a few physical actions with a coarse `when` (`start early mid late end`) and objects that move. The
compiler turns them into timed events and a camera that responds (follow a walker, shake on a startle, push harder when tense).
The model never writes seconds or pixels. **Status: the schema, director prompt and compiler exist and are tested; the one-command
pipeline (`npm run short`) still renders with the still-image renderer. Wiring rig/prop/background generation into the shot pipeline is the next step.**

## Sound driven by motion

`engine.audioCues()` returns footsteps on every foot contact (from the gait), door sounds on `open`, `sfx` params on events, and an
impact for strong camera shakes. The lab scripts mix them with ambience, rain, a tension bed and ducked voices.

## Try it (lab scripts, assets in `projects/anim-lab`, not committed)

```bash
npx tsx scripts/lab/anim-assets.ts ...            # backgrounds/props/characters via ComfyUI (see the scripts)
npx tsx scripts/lab/anim-prep.ts <char-id> <props...>   # keyed cut-outs + rig analysis + head crop
npx tsx scripts/lab/anim-heads5.ts <char-id>      # expression/look variants (img2img)
npm run anim:test                                  # the five-part animation test -> projects/anim-lab/out/animation-test.mp4
npm run anim:short                                 # "The Last Delivery", 10 shots, ~29 s -> projects/anim-lab/short/
```

## Honest limits

Paper-doll animation: legs scissor and stay straight, arms do not swing, the character always faces the camera (never walks away),
faces are limited to the redrawn variants, the door and phone are flat props, and the "double" is the same face tinted. It reads as
physical action (walking, running, turning, reacting, a door opening, traffic, weather), not as hand-animated film.
