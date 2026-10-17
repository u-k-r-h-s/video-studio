# Video Studio V3: motion reliability and the reusable 3D world

Three.js remains the only 3D renderer. Every validation clip reports `engine: three.js`, r186, on ANGLE Metal (Apple M1).

## 1. Jitter: root causes and fixes (from evidence)

**Tooling.**
- `scripts/lab/three3d/motion/trace.ts` runs the renderer's own `Character3D` headlessly on a shot spec, frame by frame.
  It measures root jumps, turn snaps, per-bone angular steps (a step that stands out from its neighbours), hips-vs-root
  jumps, planted-foot slide, and moving against the facing direction.
- `probe.ts` prints the procedural layer's inputs around a moment.
- With `spec.trace`, the browser renderer records the transforms it actually drew; the same analysis runs on that.

**Baseline.** The film `door-tak-saath-3d.mp4` (39 shots) had **249** discontinuity events, now **5**. Those 5 are in
the old compiled specs, from the anger and surprise rules removed in cause 10.

| # | symptom | root cause (measured) | fix |
|---|---|---|---|
| 1 | whole upper body snapped at 5.16 s (Arjun), 2.92 s (Meera) and 7.68 s (Dadaji) in every talking shot; hands up to 133°/frame | the Talk/Listen clips were trimmed one-shot performances (9.97 s) played as `LoopRepeat`; seams up to 125° on a forearm | `seamlessLoop()` cross-fades a looped clip's tail into its head (30 Hz resampled) when `loopSeam()` > 3° (`rig.ts`) |
| 2 | 17° head snap when a walk or turn starts | the "head leads the turn" term was computed directly from the heading error, which steps with a new target | look yaw/pitch and lead go through critically damped springs (`motion.ts`: `Damp`, `DampAngle`, 0.3 s) |
| 3 | 4° spine/arm step on the first moving frame and again on reaching cruise | the acceleration lean used the instantaneous acceleration, a square pulse | the lean uses a damped acceleration |
| 4 | head dropped to neutral in one frame when a new look began | a new `look` replaced the old one and faded in from 0 | a switch while a look is on crosses over directly; a look present from the start of a shot is on from frame 0 (no head swing at every cut) |
| 5 | arm swung 25–58° into a wave in 3 frames | the layer weight `k/(1-k)` was set against unknown competing weights | weight set against the sum of the base weights, so the layer's share is exactly `k` |
| 6 | 2-frame head jerk and a cliff at the end of startles | hard window cut-offs in `headJerk`/`pullBack`; surprise rise of 2 frames | continuous envelopes; a conversational surprise rises over 5 frames |
| 7 | turns started at full rate | first-order turn-rate gain 10/s | gain 6/s (a turn eases in) |
| 8 | **foot sliding** 0.32 m/s at cruise (Rocketbox) | the walk clip travels 16° off the bind pose's toe axis (a crab walk); speed over-estimated by 15 % | forward axis **and** speed measured from the planted foot of the actual clip (`stance()`); model rotated to it: slip median 0.32 → 0.11 m/s (the CC0 reference model: 0.15) |
| 9 | feet slid while talking and walking | in 3ds Max Biped rigs the thighs hang off `Bip01_Spine`: the "upper body" gesture mask contained both legs | `maskClip(..., exclude)` drops the leg chains |
| 10 | "sudden backward movement" (step-back mid-line), a startle on an angry line | "anger" mapped to `react` + `step-back`; a conversational surprise added a step-back | anger carries no body event (face + angry talk clip); step-back only for fear / react |
| 11 | feet slid when starting and stopping | fixed-time idle↔walk cross-fade: the body glided ahead of feet still in the idle pose | speed-driven 1-D blend (walk share = speed / (0.5 × cruise); rate so share × rate × clip speed = body speed); walks start at the most standing-like phase; **foot locking**: a planted foot is pinned by leg IK, engaged and released eased (no pop), released only at toe-off |
| 12 | walking sideways / backward into a target behind | the body moved along the target direction while the heading still turned | motion limited to ±20° of the facing direction (except the last 0.5 m); speed × cos(heading error): turn first, then walk |
| 13 | `nod` and `shake-head` did nothing | accepted by the spec, never implemented | procedural, eased head gestures |
| 14 | **teleports at cuts**: 144 jumps over 155 cuts in 4 stories (53 in door-tak-saath) | every shot staged around its speaker: when the speaker changed, everyone moved; bodies re-aimed at the new speaker | **scene blocking**: one mark per character for the whole scene (order of first appearance, an arc open to the camera); bodies face the group, heads turn to the speaker; the next shot starts each character where the previous one left them (`endPositions`, time-aware for unfinished walks). Now **3** jumps left (two ~0.3 m, one 76° turn) |
| 15 | a character "ran into the house" | `exit` with no direction defaulted to the doorway point behind the wall | an exit leaves along the set |

**Clock and determinism.**
- The clock is the timeline: `t = i / fps`, a fixed step, each system advanced once per frame.
- The runtime has `advance(i)` (simulate without drawing) and the renderer `renderRange(spec, from, to)`.
- Two causes of output depending on the page's history were fixed:
  - three.js sorted opaque draws by material id (cached materials keep older ids). It now uses a deterministic sort: group, render order, depth, object id.
  - The vehicle material cache now lives per set.
- Rain is computed on the GPU from `t` and the camera (no per-frame upload).

## 2. World system (`apps/server/src/anim/renderers/three3d/runtime/world/`)

| module | what |
|---|---|
| `nature.ts` | terrain (flat, hills, mountains with ridged noise, snow, carved river bed, lake basin, beach); **planar-reflection water** (three.js `Water`) for river, lake and sea with breaking-shore foam; a waterfall (scrolling-streak shader, mist, pool); instanced **broadleaf / conifer / palm** forests; grass and **crop fields** (wheat / mustard / paddy); all swaying in the wind in the vertex shader; drifting **clouds**; **bird flocks** (flap and glide) |
| `vehicles.ts` | original procedural **car, auto-rickshaw, bus, scooter and motorcycle (with riders), bicycle (pedalling rider)**; **IDM traffic** per lane (desired speed, acceleration, braking, safe gap, a bus that stops at its stop and leaves), simulated once, looked up by `t`; pure-yaw heading from the road; wheels turned by distance / radius; two-wheelers lean in curves |
| `city.ts` | Indian city street: the road **behind** the actors (traffic never crosses the camera); buildings with shop fronts and Hindi/English boards, balconies, AC units, water tanks; streetlights; lit windows and wet light streaks at night |
| `landscape.ts` | the open-country kit composing the above from the plan |
| road kit | with traffic, the road moves behind the actors (between them and the tea stall) |
| pedestrians | background walkers on the city's far pavement: the same `Character3D` (same locomotion) |

**Planner** (`visualPlan.ts` `planWorld`). Chooses the kit (adds `nature` and `city`), the landscape, the sky life,
traffic, pedestrians, streetlights and the sun's azimuth, from the location's words and the scene's time and weather.
Each decision is recorded in `world.why`. Rules:
- indoors: nothing from outside;
- night: no sun or birds;
- rain or fog: no birds;
- vehicles only on a city street or a road whose description names traffic or a vehicle;
- open landscapes are lit from the camera side by day, raking at golden hour.

The time of day keeps the preset's sun elevation; the physical sky draws the sun disc there.

## 3. Assets and licences

All new world assets are **original procedural geometry and textures** (no downloads). Characters as before:
- Rocketbox avatars: MIT.
- Quaternius low-poly models: CC0, also used as background pedestrians.

Richer CC0 packs (vehicles, trees, buildings) would need a download approved by you.

## 4. Validation (rendered and inspected)

| test | file | result | render time (1080×1920, 30 fps) |
|---|---|---|---|
| 1 walk, stop, turn, speak | `~/Desktop/v3-test1-walk-stop-turn-speak.mp4` | browser trace: no snaps (4 single-frame heel strikes); 111 lip-sync frames | 9 s clip in 22.6 s |
| 2 road with moving vehicles | `~/Desktop/v3-t2-road-traffic.mp4` | bus brakes into the stop, stands, leaves; auto, scooter and bicycle pass behind the actors; 0 events | 10 s in 21.1 s |
| 3 mountains, river, birds, sunlight | `~/Desktop/v3-t3-nature-river.mp4` | reflections, flock across the sky, clouds, grass sway; 0 events | 10 s in 33.6 s |
| 4 rainy city at night | `~/Desktop/v3-t4-rainy-city.mp4` | traffic on 4 lanes, rain, streetlights, pedestrians built (6); 0 events | 10 s in 22.8 s |
| 5 chunk boundary | `~/Desktop/v3-t5-chunked-*.mp4` | continuous vs two chunks, byte for byte: road **300/300**, nature **300/300**; rainy city **278/300** (see limitations) | two chunks 16–29 s |

**Performance.**
- Nature: ~0.5–0.6 M triangles and ~90 draw calls (instancing). Road and city: 70–85 k triangles, 430–475 draw calls.
- Peak headless-Chrome memory on the heaviest scene: 1.55 GB; system free memory never below 35 %.

**Tests.**
- `npm test`: 369 + 26 passed; typecheck clean.
- New tests:
  - `motion.test.ts`: loop seams, damping, the speed-driven blend, Rocketbox walk / stop / turn / speak with no snaps, look crossover, planted foot, scene blocking at cuts.
  - `vehicles.test.ts`: lane following, no overlaps, wheel spin, the bus stop, purity in `t`, world rules.
  - A Chrome test: a fast-forwarded chunk equals the full render.

## 5. Limitations

- **Chunks with skinned background walkers.** In the rainy city, 22 of 300 frames differ by 1–2 pixels (≤ 18/255).
  Every CPU-side state is bit-identical (camera, characters, every bone matrix of every walker). The residual is in GPU
  skinning, cause not found.
- **Residual foot slide** at heel strike (one frame per step, ~0.5 m/s) and during the first frames of a start.
- **Three continuity residues** across ~155 in-scene cuts.
- **Vehicles and buildings are procedural:** cars and the bus are extruded profiles, not detailed models. Facades are
  textured boxes.
- **Pedestrians** are low-poly CC0 models (a style mismatch, acceptable at distance).
- **Nature:** mountains read pale through the haze and the snow barely shows; conifers are stylised cones; the grass is
  coarse up close.
- **Sound:** vehicles make no sound yet. Footstep cues now also work for Rocketbox characters in the cue simulation.
- **Not yet used in a full story:** these systems are validated by short tests only, as requested.
