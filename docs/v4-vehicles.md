# Vehicle Quality V4: audit, models, effects

Three.js remains the renderer. Every proof clip reports three.js r186 on ANGLE Metal (Apple M1).

## 1. Audit of the V3 clips (before any code change)

I opened `v3-t2-road-traffic.mp4`, `v3-t4-rainy-city.mp4`, `v3-t5-chunked-road-traffic.mp4` and `v3-t5-chunked-road.mp4`.
I read 4 fps overviews, full-resolution crops and consecutive-frame sequences of each vehicle pass.

| seen in the video | cause in the code |
|---|---|
| bus = flat blue slab, black window holes, a tyre ring in front of the body, a gap under it, no doors / lights / mirrors | one side profile extruded at constant width; glass = boxes through the body with metalness 0.9 (a black mirror) |
| car = ochre "doorstop", **no windows at all**, white tail lamp, pale-disc wheels | the glass extrusion (1.62 m) lay entirely inside the body (1.76 m), whose outline also contained the cabin |
| auto-rickshaw = long green van with a solid black slab | the canvas side curtains were opaque boxes closing the cabin |
| motorcycle / scooter = white slab, floating front wheel, no tank / engine / fork; rider = red capsules, a straight tube arm | slab profile; capsule rider with a mis-rotated single-segment arm |
| wheels never visibly turn (motion itself is smooth) | the rim disc (0.5 r) covered the spokes (0.525 r) |
| no headlight glow, beam, spill or reflection at night; no exhaust, dust or spray | 5 cm emissive boxes; no effects existed |
| vehicles look weightless | sun shadow box only ±16 m around the lead actor; no contact shadow |
| movement, lane alignment, heading, spacing | **correct**: smooth IDM motion, steady per-frame displacement; the chunked clips continue across the 149/150 cut |

## 2. What changed

**Models** (`runtime/world/vehicle-models.ts`, original procedural geometry, no downloads).
- **Lofted bodies:** rounded cross-sections swept through stations along the length, with tumblehome.
- **Real glass:** tinted, partly transparent physical glass over an interior with a driver.
- **Details:**
  - wheel-arch liners that frame (not cross) the tyres;
  - bumpers, grille slats, lamp clusters (lens + reflector);
  - mirrors, door seams and handles, a shoulder line;
  - Indian number plates (white private, yellow commercial).
- **Wheels:** tyre with sidewall, recessed rim, proud spokes (alloy / steel / wire / scooter).
- **Jointed riders:** helmet with visor, tapered torso, upper arm + forearm to the grips and thigh + shin to the pegs, by
  two-bone IK. The bicycle rider pedals by IK from the crank angle every frame.
- **Kinds:**

  | kind | model |
  |---|---|
  | car | sedan and hatchback |
  | auto | Bajaj-style auto-rickshaw: CNG green or Mumbai black, yellow canopy, open sides, bench, driver |
  | bus | Indian city bus: framed panes, two kerb-side doors, livery, white roof, "502 नई दिल्ली" destination board, quad headlamps, mirrors |
  | motorcycle | tank, finned engine, fork, exhaust, shocks |
  | scooter | leg shield, floorboard, cowl |
  | bicycle | wire wheels |

- **Merging:** static parts are merged per material (a few draw calls per vehicle). Materials are owned per set
  (`Kit`).

**Traffic** (`runtime/world/vehicles.ts`).
- **IDM unchanged.**
- **Fixed:** wheels mounted mirrored (spokes facing out on the left) spun backwards. Each wheel now carries its spin
  sign.
- **Added:**
  - brake lights from the simulated deceleration;
  - parked vehicles;
  - an optional stop position.

**Effects** (`runtime/world/vehicle-fx.ts`).

Story-aware: the set enables dust only on a dry *dirt* road (the planner reads "dirt road / kachcha / unpaved /
dusty") and spray only when the road is wet. Night lights only at night. Electric vehicles and bicycles make no exhaust.
- **Exhaust:** a faint trace when cruising, a puff when pulling away; the most for a diesel bus, plus idle at a stop.
- **Dust** behind the wheels on dry dirt, by speed.
- **Road spray**, ballistic, from the rear wheels on a wet road.
- **At night:**
  - headlamp and tail glows; tail glows grow when braking;
  - faint headlight beams;
  - wet-road light streaks pointing from each lamp toward the viewer;
  - a fixed pool of two real spotlights given to the vehicles nearest the camera (constant light count).
- **Contact shadow** under every vehicle.
- **Deterministic:** every particle is a pure function of t, from the vehicle's simulated state at its emission time
  (no carried state).

**Bugs found while validating** (all three affected every film, not only vehicles):
1. **Bones left at the rest pose for a frame.** three.js only writes a bone when its blended value changed; the
   character reset every bone to the rest pose before the mixer. Any bone a clip held perfectly still stayed at rest
   for a frame. The low-poly walk's `Body` snapped 27° every half step (91 events → 0). The pose is now restored from
   the mixer's last output.
2. **Face light flooded the ground in wide shots.** It sat "35 % of the way from the camera", so in a wide shot it was
   4 m from the actor (a silhouette) and lit the ground. It is now 1.6 m from the face on the camera side.
3. **Rim-light glare.** The low rim light's mirror glare flooded the pavement with white toward the camera (shown by
   switching it off). It is now high behind the actor (~65°), so the glare lands under the camera.

## 3. Proof clips

All proof clips are in `projects/v4-proof/` (git-ignored).

| clip | content | render (10 s, 1080×1920) | motion trace |
|---|---|---|---|
| `v4-c1-day-road.mp4` | an auto pulls in, brakes, stands, leaves; cars, autos, a motorcycle | 23.0 s | 0 events |
| `v4-c2-rainy-night.mp4` | rainy city, headlights, tail lamps, beams, spill, spray; the red bus with its lit board | 22.6 s | 25 (all background walkers' foot slide) |
| `v4-c3-dirt-road.mp4` | dry dirt road: autos, bicycle, motorcycle, dust | 23.8 s | 0 |
| `v4-same-spec-as-v3-t2.mp4`, `v4-same-spec-as-v3-t4.mp4` | the V3 specs re-rendered | 21.9 s, 25.4 s | 0 / walkers only |
| `before-after-v3-v4.jpg` | V3 (left) vs V4 (right): car, auto, motorcycle, night bus | | |
| `lineup-day-*.png`, `lineup-night-*.png` | every model at 4–9 m (`scripts/lab/three3d/v4/showroom.ts`) | | |

**Chunk boundary.**
- Dirt road (vehicles, dust, exhaust): **300/300 frames byte-identical**.
- Rainy-night city: **168/300**. After the cut, up to 62 pixels per frame differ by at most 4/255, invisible to the eye.
  Every vehicle transform and particle buffer was checked bit-identical in both paths. The residue arises in the GPU
  output; cause not found.

**Tests.**
- `npm test`: 372 + 26 passed; typecheck clean.
- New in `vehicles.test.ts`:
  - every wheel of every kind rolls forward (contact patch sweeps backward), on both sides;
  - tyres touch the road;
  - particles are identical in any frame order;
  - only the allowed effect pools exist (no spray on a dry road, no exhaust from bicycles).

## 4. Limitations

- **Riders** are still mannequin-like (straight-ish arms, box shoes, a ball head under the helmet); fine at 6–10 m,
  weak in close-up.
- **Vehicles are procedural:** no textures (no tyre tread, badges or interior detail); the bus windscreen reads as a
  flat panel; arch liners are a dark ring rather than a cut-out.
- **Effects are subtle by design:** spray at night is faint; dust needs some speed and is lighter than the earth.
- **No vehicle sounds** (engines, horns).
- **Background walkers:** the low-poly female walker still slides her planted foot (~0.4–0.7 m/s).
- **Rainy-night chunks** are not byte-identical (see above).
- **Downloads:** licensed CC0 vehicle packs (for example Kenney or Quaternius) were not downloaded. They would need
  your approval and a size/licence check.
