# The 3D renderer (Three.js)

`npm run short -- "<idea>" --renderer=3d` renders the shots with rigged 3D characters. `npm run short` without the flag (or with
`--renderer=2d`) is unchanged: the 2D puppet renderer.

```
AI Director (unchanged) -> Shot JSON (unchanged schema: semantic actions, objects, shot size, camera motion, emotion)
   -> renderer selection (profile.animation.renderer: canvas2d | three3d)
        canvas2d: anim/compose.ts  -> AnimEngine (2D puppets)                       ┐
        three3d : renderers/three3d/compile.ts -> Shot3DSpec -> Three.js (Chrome)  ┘-> the same FFmpeg post chain (grade, bloom,
   -> the same timeline, captions, soundtrack (cues), assembly guard, loudness -> MP4      vignette, grain, captions)
```

The Director describes WHAT happens ("walk to the warehouse door", "raise the flashlight", "push the door open", "step back in
fear", shot size, camera motion). The 3D compiler turns that into timed events with fixed rules (shared `placeAction`, no numbers
from the model). The runtime decides HOW: which clips, cross-fades, bone layers, camera path. No bone angles appear in the shot data.

## Files (`apps/server/src/anim/renderers/`)

| file | role |
|---|---|
| `types.ts` | `ShotRenderer` interface (`render(spec, out, opts)`, `close()`), `RendererId` |
| `canvas2d.ts` | the existing 2D engine behind the interface (no behaviour change) |
| `three3d/spec.ts` | `Shot3DSpec`: characters + semantic events, props, set objects, camera intention, lighting preset |
| `three3d/compile.ts` | the 3D animation compiler: Director shot -> `Shot3DSpec` (staging, timing, props, door, camera, lighting) |
| `three3d/library.ts` | local character library (`assets/3d/characters/<key>/character.glb`) and casting (costume colours, courier bag) |
| `three3d/index.ts` | `Three3DRenderer`: bundles the runtime with esbuild, drives headless Google Chrome (WebGL2 on Metal, throwaway profile), streams PNG frames into `animPostGraph` + FFmpeg; `stills()` for previews/tests |
| `three3d/simulate.ts` | runs the characters headless in Node to place footsteps/door sounds BEFORE rendering (same code as the browser) |
| `three3d/runtime/rig.ts` | rig-agnostic bone and clip discovery (Mixamo, Quaternius, Unreal-style names), masked clips, in-place locomotion |
| `three3d/runtime/locomotion.ts` | locomotion state machine IDLE -> WALK -> RUN -> STOP -> IDLE with cross-fades |
| `three3d/runtime/character.ts` | `Character3D`: model, skeleton, mixer, clips, state machine, real 3D orientation (movement / target / camera), look-at, prop holding and aiming, gesture layers, expressions (morph targets when present), footstep cues, clip speed calibrated from the feet |
| `three3d/runtime/props.ts` | generic prop + socket system (rightHand / leftHand / back / hip); flashlight (spot light + light shaft), phone (lit screen), bag, box, keys, tool, weapon-like, generic |
| `three3d/runtime/camera.ts` | cinematic camera: wide / medium / closeup / over_shoulder x static / follow / tracking / push_in / pull_out / pan / tilt / handheld; critically damped springs; side chosen so the camera stays in the open |
| `three3d/runtime/lighting.ts` | presets: day, night, warehouse, street, rain, horror, warm-interior, cold-interior (key + fill + rim + fog + exposure, one shadow-casting key) |
| `three3d/runtime/environment.ts` | set kit: wet asphalt, a facade with a working hinged door, interior with light spill, practical lamp with light shaft, crates/barrels/pallet/dumpster, rain; an AI-painted plate on a far screen (hybrid 2.5D) |
| `three3d/runtime/shot.ts` | one shot in the browser (renderer, environment reflections from the plate, set, characters, camera) |

Pipeline: profile `animated-short-3d` (`profiles/animatedShort3d.ts`); `pipeline/stages/animated/plan3d.ts` (compile per shot);
the asset stage generates only location plates for 3D; the timeline stage uses `simulateCues`; the render stage has a 3D branch;
the assembly guard is the same (`renderer: "anim"`, plus `engine: "three3d"`).

## Character library

`assets/3d/characters/<key>/character.glb` (git-ignored). Needs a skinned mesh with at least `Idle` and `Walk` clips; `Run`, `Wave`,
`Interact`, `HitReceive`-like clips are used when present. The test character is **Quaternius "Casual Character" (CC0)** from
poly.pizza (`assets/3d/characters/casual-man/character.glb`, 1.4 MB, 24 clips). The far plate of the test scene is generated
locally with ComfyUI (`scripts/lab/three3d/make-plates.ts` -> `assets/3d/plates/`).

## Labs

```bash
npx tsx scripts/lab/three3d/production-test.ts            # the integrated test video -> ~/Desktop/three3d-production-test.mp4
npx tsx scripts/lab/three3d/production-test.ts --stills   # 5 PNG stills per shot in /tmp
npx tsx scripts/lab/three3d/pose-lab.ts /tmp/pose.png 0.5,1.5 '[{"at":0.2,"action":"wave"}]'   # one character, side camera
```
