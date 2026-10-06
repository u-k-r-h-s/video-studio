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

## Visual Quality V2

Same architecture (Director → shot schema → `compile.ts` → Three.js runtime in headless Chrome → shared FFmpeg post/captions/audio). No new assets or generators. The comparison test videos are rendered with `npx tsx scripts/lab/three3d/render-scene.ts <night|day>` (scenes in `scripts/lab/three3d/scenes.ts`, Director format). The test videos go to `~/Desktop`, and their measurements go to `scripts/lab/three3d/quality-<name>-v2.json`.

### What changed
- **Character presentation** (`runtime/presentation.ts`, rig-agnostic): faceted low-poly meshes are smoothed (merged vertices + recomputed normals), materials become `MeshPhysicalMaterial` with a response chosen from the material name (skin, hair, eyes, cloth, leather, metal, glass, rubber: roughness, sheen tinted with the base colour, env reflection). The character also gets a soft contact shadow under the feet.
- **Acting** (`runtime/character.ts`, procedural layers over the clips): a slower deceleration into a stop, then a settle, then a beat before any hand action (`press`, `push`, `reach`, `raise`… wait until arrival + 0.38 s). Also added: lean into acceleration, idle breathing and weight shift, head leading body turns, look-at (including the upcoming target while approaching), glances in `look-around`, anticipation before a push, `hesitate` (holds the next action), and a staged reaction (head jerk → torso pulls back → step back, with a defensive free arm).
- **Generic hand/prop system**: two-bone IK for both arms (elbow pole, so a raised torch bends the elbow). Props can aim at a target (the wrist turns the prop toward `aimDir`), and a carried box sits upright in front of the belly. The flashlight beam uses a softer penumbra/decay, a volumetric shaft and a lens halo, and flickers on a startle. None of this is specific to the flashlight: any hand prop uses the same aim/IK path.
- **New semantic actions**: `press` (doorbell), `adjust` (package), `hesitate`; Director/rules/schema accept them.
- **Lighting presets** (`runtime/lighting.ts`): `sunny-day`, `cloudy-day`, `overcast`, `golden-hour`, `sunset`, `rainy-day`, `night`, `cinematic-night`, `rainy-night`, `indoor-daylight`, `warm-interior`, `cold-interior`. Old names (`day`, `warehouse`, `street`, `rain`, `horror`) are aliases. Each preset sets the sun (colour, intensity, elevation, azimuth, shadow softness), the sky (physical `Sky` by day, gradient at night), fill, ground bounce, a camera-relative rim, fog, exposure, the PMREM environment and ground wetness. The sun's shadow box follows the lead character.
- **Daylight from the story**: `Location.timeOfDay` (morning/day/golden_hour/sunset/night) and `Location.weather` (sunny/clear/cloudy/overcast/rain/fog) are optional Director fields. `lightingFor()` uses them first, then the place's words; an everyday story defaults to a sunny day.
- **Environment kits** (`runtime/environment.ts`): `warehouse-exterior` (improved) and a new `neighborhood` kit: sidewalk, curb, lawn, path, house with siding, gable roof, porch, windows, house number, doorbell, neighbours, houses across the street, trees (wind sway), hedges, car, mailbox, streetlamp. The kit is chosen from the place (`kitFor`). Both kits share a doorway with a hinged leaf, a lit room and warm spill light. Rain uses 3 depth layers; daylight gets floating motes.
- **Camera** (`runtime/camera.ts`): the side is chosen automatically so the set never clamps the camera into the subject. `angle` overrides the default, OTS is offset laterally, and `frameWith` gives a two-shot that fits subject + target (door) in the 9:16 width. Push-ins toward the door happen only when it is far away.

### Measurements (M1 / 8 GB, 1080×1920, 30 fps)
| video | length | total time | GL render | host per frame | triangles | draw calls | size |
|---|---|---|---|---|---|---|---|
| V1 `three3d-production-test.mp4` | 14.0 s | 22.8 s | ~2 ms/frame | ~50 ms | 27k | 163 | 21.4 MB |
| `three3d-quality-night-v2.mp4` | 14.4 s | 24.5 s | ~2.4 ms/frame | ~55 ms | 31–38k | 183–216 | 25.1 MB |
| `three3d-quality-day-v2.mp4` | 15.6 s | 39.9 s | ~2.0 ms/frame | ~94 ms | 24–25k | 190–216 | 27.3 MB |

Peak memory ≈ 1.58 GB (Chrome + node), the same as V1. The GPU side is cheap. The time goes into moving each frame out of the browser as a PNG data URL and encoding it. Bright, detailed daylight frames make much bigger PNGs, which is why the day video is ~70 % slower per frame than night. A likely fix (not done in this phase) is to capture JPEG/raw RGBA instead of PNG.

### Remaining weaknesses
- Day render time misses the ~23 s target (see above). Night is within ~2 s of V1.
- The low-poly Quaternius model still limits close-ups: no facial animation and a simple hand (no finger poses), so `press` reads as an arm reach rather than a finger on the button.
- In the two-shot door framings (day shot 4, night shot 3) the character is small on a phone screen. `frameWith` favours keeping the door in frame over the character's size.
- At night the beam's hotspot on a near wall is still hot, and the rain-lit ground can read pale behind a dark silhouette.
- Procedural acting is rule-based: the beats (settle, hesitate, reaction) have fixed timings, so repeated actions look alike.
- The neighbourhood kit is one house layout with palette variation. Interiors still use the old `interior` path; the interior presets exist, but there is no new interior kit.
