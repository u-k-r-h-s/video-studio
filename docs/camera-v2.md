# Camera Cinematography V2: smooth moves and intentional cuts

Baseline: `fee305d` plus the uncommitted Camera V1 work (docs/camera-v1.md). Three.js remains the only renderer, and the camera runtime was refactored, not rewritten.

## Audit and root cause

I measured the camera rather than reading code alone. `scripts/lab/camera/cam-trace.ts` renders specs with the browser trace and reports the camera's motion frame by frame inside each shot and across every cut.

**Inside shots, the V1 proofs never snapped.** No frame moved more than about twice the shot's median.

**The jumps were cuts between nearly identical camera axes.** Two cuts inside a scene changed only the distance:

| Cut | Camera moves | View turns |
|---|---|---|
| Establishing → two-shot | 7.8 m | 23° |
| Pump master → pump medium | 3.7 m | 14° |

Both are under the 30° minimum for a cut, so they read as the camera jumping (jump cuts).

**Cause 1: every composition change was a hard cut.** The compiler never generated a move inside a shot. `keys` existed in the spec and the runtime but were never emitted.

**Cause 2: keys could not make a designed move anyway.** A probe test (`CinematicCamera` stepped in Node) showed:
- A key blended only distance, height, look height and FOV.
- `target`, `frameWith` and `behind` switched instantly.
- A critically damped spring then chased the jumping goal:
  - a "1.2 s" key took about 3.6–3.8 s more to settle;
  - a `frameWith` change hit full acceleration on its first frame (0 → 0.2 → 0.57 m/s);
  - a target change only began halfway through the blend.

**Cause 3: designed moves went through the spring as well.** Push-in, pull-out, pan and tilt all followed the spring, so the real camera lagged its designed curve. A pull-out ended about 0.9 m short, which made "start the next shot where this one ended" impossible.

**Latent issue 1: two-shot side.** The side of a two-shot was re-decided every frame, so the camera could flip across a pair when someone turned.

**Latent issue 2: determinism.**
- A chunk check with its boundary *inside* the new move failed on frames 40 and 44–57.
- Camera and character states were bit-identical between the two runs. The 12–126 differing pixels were all daylight dust motes.
- Their CPU-side buffer was rewritten every frame, so the drawn result depended on how many GPU uploads had happened. A chunk fast-forwards with no draws and one upload.
- With the motes disabled, all frames matched.
- One earlier failure on the closing establishing shot (shot-11) could not be reproduced in three reruns.

## What changed

- **`runtime/camera.ts`**
  - The framing code became `compose(t, state)`: one composition, with its own side and two-shot side decided once.
  - The camera follows a timeline of compositions:
    - the spec's own;
    - optionally an entry composition;
    - then each key.
  - **A key or an entry is a designed move:**
    - It starts from where the camera actually is, or for an entry, from the previous shot's composition.
    - It travels to the new composition over `blend` / `duration` seconds.
    - The easing has zero velocity and acceleration at both ends, so there is no jolt and no overshoot.
    - The path arcs around the look point and does not pass through the subject.
    - The look leads the travel (it reaches its target at 65 % of the move).
    - The lens is interpolated along with it.
  - **Spring use:**
    - Designed moves and static holds take their composition exactly.
    - Only follow, tracking and handheld shots use the spring.
    - A follow camera picks up at rest after a move.
  - **Lens and two-shot side:**
    - The lens time constant no longer depends on frame rate.
    - The first frame starts exactly on the composition.
    - A two-shot's side is decided once per composition.
- **`spec.ts`:**
  - New `CameraState3D` / `CameraKey3D` types. Keys can now change angle, side, height, lens, `toward` and `move` as well.
  - New `CameraSpec3D.enter = { from, at?, duration }`: open on another composition, then move to the shot's own.
- **`cinematography.ts`:** each coverage gets a `transition` ("cut" or "move") and a reason.
  - **Move:**
    - from the place down into the scene;
    - a wider shot to closer on the same subject or action;
    - the same speaker continuing in the same framing (seamless).
  - **Cut:**
    - a new scene;
    - a new speaker;
    - a reaction;
    - into or out of an insert;
    - a shock, fear or anger beat;
    - tracked travel;
    - any other new composition.
- **`compile.ts`:** `prevCamera` input and `entryFrom()`.
  - A planned move opens on the previous shot's camera, taking a push-in or pull-out at its end point.
  - The move is 3.2 s from an establishing shot, otherwise 1.8 s, and at most 75 % of the shot.
  - It falls back to a cut if the previous camera framed a character who isn't in this shot.
- **`pipeline/stages/animated/plan3d.ts`:** passes the previous shot's camera (same scene, cached) in production.
- **`runtime/environment.ts`:** the dust-mote drift is computed in the vertex shader from time and camera uniforms, so the buffer never changes after set-up. The other atmosphere layers already worked this way.
- **`scripts/lab/camera/proof.ts`:** passes `prevCamera` and prints each shot's transition. Outputs are named after the output directory.
- **New tool:** `scripts/lab/camera/cam-trace.ts`.

## Transitions in the previews

| Boundary | V1 | V2 |
|---|---|---|
| Establishing → two-shot (dialogue) | jump cut (7.8 m, 23°) | **move**: crane down into the scene, 3.2 s; cut invisible (0.01 m, 0°) |
| Two-shot → OTS (new speaker) | cut | cut |
| OTS → single (new speaker) | cut | cut |
| Single → reaction | cut | cut |
| Pump master → medium on the hands | jump cut (3.7 m, 14°) | **move**: closer on the action, 1.8 s; cut invisible (0.01 m, 0°) |
| Medium → water insert | cut | cut |
| Insert → reaction | cut | cut |
| New scene, tracking, closing wide | cut | cut |

**Move smoothness** (largest frame-to-frame change in speed as a share of the move's peak speed):

| Shot | Travel | Peak speed | Largest speed change |
|---|---|---|---|
| Crane | 8.2 m | 6.1 m/s | 5 % |
| Pump move | 3.7 m | 3.8 m/s | 6 % |
| Pull-outs | 2.3 m | 1.3 m/s | 5 % |
| Tracking | 4.6 m | 1.1 m/s | 3 % |

## Validation

- **Previews** (`projects/camera-v2/`, 1080×1920, 30 fps, real compiler and characters, Piper voices):

  | Clip | Length | Render |
  |---|---|---|
  | dialogue | 14.9 s | 42.3 s |
  | pump | 9.6 s | 24.8 s |
  | walk | 8.1 s | 18.6 s |

- **Inspection:** frames extracted from the MP4s at the same timestamps as V1 and compared side by side, plus the camera trace. I did not watch the clips in a player.
- **Chunk checks** (`chunk-test.ts`), all byte-identical:
  - crane, boundary at frame 12: 128/128;
  - crane, boundary at frame 40: 128/128;
  - OTS: 86/86;
  - pump move: 78/78;
  - insert: 72/72;
  - tracking: 165/165;
  - closing wide: 78/78;
  - V6 riders clip (CPU-updated vehicle particles): 150/150.
- **Tests:** `npm test` passes 404 server and 26 shared tests (11 new in `cinematography.test.ts`). `npm run typecheck` is clean.

## Remaining issues

- **Dadaji's line over the reveal:** his line starts 0.35 s into the crane shot, and the pair is fully framed only after about 1.1 s. It reads as a voice over the reveal. A stricter option is to delay the first line of a shot until the entry move has framed the speaker.
- **Brisk moves:** the crane peaks at 6 m/s over 8 m, and the pump move at 3.8 m/s. The pump move is limited by its 2.6 s shot. A longer shot, or a cap on speed instead of on duration, would make them gentler.
- **Moves only at cuts:** in-shot keys (for example, a reframe as a second character joins) are supported and tested but not yet planned by the coverage planner.
- **Other per-frame buffers:** other particle systems that rewrite buffers on the CPU (rain, vehicle effects) passed the chunk checks run here, but they follow the same pattern as the motes and are a residual risk.
