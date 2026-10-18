# Indian Village V2: visual quality pass (2026-10-18)

**Baseline.** The eight images named in the brief, all in `projects/v5-audit/`. HEAD was `5541f3f`, with the
uncommitted V5 work on top; nothing was reverted.

## Root causes and fixes

| defect seen | root cause | fix | file |
|---|---|---|---|
| striped green band across the bottom of `after-village-wide.png` | **not the village**: that baseline still is from the old road-kit test spec, whose second crop field lay at z = 10..22, the camera side (cameras stand at z 6..14 looking down at the actors) | both road-kit fields moved behind the action; the field helper now throws if a field would reach z > 3 | `runtime/kits.ts` |
| flat, uniform walls | one blotchy canvas texture, no relief | `limewash()`: hand-applied wash variation, irregular flaked patches showing mud brick, a few rain streaks, ground grime, plus a matching bump map | `world/village.ts` |
| plaster smeared into stripes on gateposts and narrow faces | BoxGeometry's 0..1 UVs per face (a 0.36 m post and a 9 m wall got the same texture) | `wbox()`: UVs in metres, so the texture repeats at one physical size everywhere | `world/village.ts` |
| plain house front | no depth layering | corner pilasters, a cornice, a door surround with jambs and threshold, two steps, window sunshades (chhajja) on brackets | `world/village.ts` |
| empty courtyard, open dirt behind it | no back, props scattered | a store-room outbuilding closes the aangan; a smooth plastered courtyard floor (no grass); clothes line across it; matkas against the wall; charpai framed by the gate; a low 1.0 m wall so the life shows | `world/village.ts` |
| empty veranda | none | charpai with a blanket, a matka on an iron stand by the door, a broom, a hanging lantern (lit at night) | `world/village.ts` |
| lane ground | flat | sparse pebbles off the worn path, damp ground around the pump and tap, fallen leaves under the neem | `world/village.ts` |
| tap = a floating red bar over a tube; bucket water invisible | handle not attached; flat matte water the colour of steel | brass bib-cock on an elbow; a crosshead handle on its spindle turns a quarter turn with the flow; water is dark and clear with a light rim, rings spreading from the impact point, and foam where the stream lands (pure functions of t) | `world/village.ts` |
| mannequin riders | constant-radius capsules, a ball head, sphere hands | tapered limbs with a muscle belly, rounded elbow and knee joints, shoulders, a pelvis on the seat, short sleeves over bare forearms, a closed hand on the grip, shaped shoes; a head with eyes, brows, ears, nose and a hairline; an open-face helmet with a peak and chin strap | `world/vehicle-models.ts` |
| arms locked straight to the grips | a fixed torso lean put the grips 0.8 m from the shoulder | the rider leans forward until the elbows bend (reach ≤ 85 % of the arm) | `world/vehicle-models.ts` |
| uniform lake, ellipse shore, banded water | an elliptical basin, coarse high-distortion normals | `lakeDist()` irregular shoreline used by the terrain, colour, water mesh and placement; a graded beach, mud and depth colours (smoothsteps; hard thresholds drew zigzags on the 2.4 m grid); rocks and reed clumps on the shore; calmer, finer water | `world/nature.ts`, `landscape.ts` |
| flat hills | relief only beyond 90 m, 26 m high | midground rolling hills (40–110 m) in front of the range; hills closer and taller than before | `world/nature.ts` |
| lollipop trees | one blob crown | three broadleaf silhouettes (a spreading shade tree with a forked trunk and flat crown, a tall oval, a young open tree); conifers mixed into broadleaf hills | `world/nature.ts`, `landscape.ts` |

## Checks

- `npm run typecheck`: clean.
- `npm test`: 381 + 26 passed.
- Cuts in `door-tak-saath`: 0 jumps.

## Proof clips

All in `projects/v6-proof/`, 1080×1920, 30 fps, Three.js r186 on ANGLE Metal (M1).

| clip | length | render | motion | inspected |
|---|---|---|---|---|
| `v6-village.mp4` | 8 s | 25.1 s | 0 | crane from over the courtyard (clothes line, tulsi, charpai through the gate, tap and bucket) to the veranda house; the dog walks past; ends on Arjun and Dadaji together |
| `v6-pump.mp4` | 7 s | 20.5 s | 0 | Meera's hand on the grip through the strokes; water on the down-strokes; the bucket level rises (start and end crops) |
| `v6-riders.mp4` | 5 s | 12.5 s | 0 | a parked scooter with its rider in the foreground; a red scooter passes at 1 s, a bicycle at 3 s |
| `v6-landscape.mp4` | 8 s | 26.1 s | 0 | lake with an irregular, graded shore, rocks and reeds, mixed tree silhouettes, a midground hill, birds; Meera's line |

**Chunk equality.** Pump 210/210 and village 240/240 byte-identical. The V5 village had a 1–2 px residue; it no longer
appears in this scene.

**Evidence images** (`projects/v6-proof/`): `baseline-*.png`, `lake-before-after.png`, `rider-heads-after.png`,
`riders-lineup-after.png`, `tap-bucket-water.png`.

## Remaining defects (by impact)

1. **Style mix:** semi-realistic Rocketbox people next to stylised procedural riders, a low-poly dog and a blocky cat.
2. **One-armed pumping:** Meera pumps with one arm and no body motion.
3. **Rider clothing:** no folds; hands are simple fists.
4. **Lake water:** reads as a pale band at grazing angles; the near shore lacks a foreground (the camera stands on flat
   grass).
5. **Trees:** canopies are still faceted icosahedra (stylised); trunks are simple.
6. **Bucket fill:** only visible from above the rim; a side view needs the bucket nearly full.
7. **Not in the story pipeline:** village props and interactions are not yet emitted from a story (hand-written specs
   only).
