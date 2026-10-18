# V5 Phase 0 audit (2026-10-18)

## Repository state

- **Git state:** branch `main`, HEAD `5541f3f` (V4 vehicles), working tree clean, equal to `origin/main`.
- **Baseline:** the requested baseline `c8bd43e` is one commit behind (V3). The V4 work is already on `main`.

## Videos inspected

All files are in `projects/v4-proof/`; nothing was missing.

| file | metadata | how inspected |
|---|---|---|
| `v4-c2-rainy-night.mp4` | 10.0 s, 1080×1920, 30 fps, H.264 High, 8.8 Mb/s, AAC voice | 8 timestamps full + chunked; full-res crops at 0.3 / 2.6 / 4.8 / 5.6 s; 6-frame sequences at 0.0–0.4 s and 5.2–5.6 s |
| `chunked-v4-c2-rainy-night.mp4` | 10.0 s, 1080×1920, 30 fps, 8.1 Mb/s, **no audio** | same 8 timestamps; per-frame numeric diff against the full render |
| `chunked-v4-c3-dirt-road.mp4` | 10.0 s, 1080×1920, 30 fps, 7.2 Mb/s, no audio | 8-frame strip, numeric diff, side-by-side with `v4-c3-dirt-road.mp4` at 4.0 s |
| `v4-c3-dirt-road.mp4` | 10.0 s, 1080×1920, 30 fps | 8-frame strip; full-res crops at 0.4 / 3.2 / 7.4 / 8.6 s |
| `before-after-v3-v4.jpg` | 1080×1240 | viewed (this is my own composite from V4) |

**No landscape video exists from V4.** The V3 nature clip was deleted from the Desktop. For terrain, water and the village I
rendered **new stills from the current code** (`projects/v5-audit/*.png`, 540×960, 14 s total). These are stills, not
motion.

## Defects

O = observed in the frames; H = hypothesis.

| sev | where (time / file) | defect | O/H | code path | correction | verifying test |
|---|---|---|---|---|---|---|
| **high** | dirt road 0.4, 3.2, 7.4, 8.6 s | dust reads as a flat yellow-orange **band across the whole frame** with straight edges, lingering where no vehicle is; not puffs | O | `vehicle-fx.ts` dust: up to 4 m particles, 1.8 s life, placed at the wheels of vehicles 4–9 m away; warm post grade tints it | small low puffs (≤1.5 m), short life (≤1 s), fade by height, kept below 1.2 m, alpha scaled by distance from the vehicle | frame: no dust pixels above the vehicle roofs; unit: particle height ≤ 1.3 m, life ≤ 1 s |
| **high** | village kit stills; road kit (dirt road all frames: blue/grey towers behind the tea stall) | **city skyline boxes behind a village and a country road** | O | `kits.ts` `far()` grey boxes 4–18 m tall at z −40 / −45 | rural kits use a tree line + low hills, not boxes | still: no box silhouettes on the horizon; unit: rural kits build no `far()` boxes |
| **high** | village stills | the village is **two boxes on an empty dirt plane**: no lane edges, no courtyard walls, sparse props, a striped green carpet (the "field") in the foreground, a tiny box hand pump | O | `villageKit` | a composed lane: house row with courtyards and boundary walls, gates, verandas, a proper hand pump with a basin, charpai, pots, buckets, trees placed to frame | village proof render inspected |
| high | rainy night 0.0–0.4 s, 5.6 s; day line-up | car **roof reads as glass with thin rods** (a roll cage / convertible look); the roof skin is too narrow | O | `vehicle-models.ts` `car()` roof loft `wb: W-0.19` over a glass cabin whose top is `W-0.2` | wider opaque roof panel covering the glass top, thicker pillars, darker glass at the roofline | line-up still |
| med | rainy night 4.8–5.6 s | bus body almost black at night; only lamps read | O | night lighting; body paint has no fill | paint `envMapIntensity`, interior lights in the bus windows | still |
| med | rainy night all | headlight beam cones visible as soft triangles; acceptable. Wet road reads as wet near lamps only | O | `vehicle-fx.ts` | keep | — |
| med | nature stills | **river** = a thin mirrored green ribbon with white streaks; banks flat; no depth cue | O | `nature.ts` river (Water) over a carved bed of 1.6 m | wider river, shallow-to-deep colour (a coloured water bed under a semi-transparent surface), bank slope + wet-mud band, lower distortion | still |
| med | nature stills | **waterfall cliff = a grey cube**; sheet a flat white plane; pool reflects a strange mirrored cliff | O | `waterfall()` BoxGeometry cliff | rock formation from displaced, stacked rock forms; narrower falling sheet with ledge; no planar mirror for the pool (foam + mist) | still |
| med | nature stills | conifers identical cones in a uniform carpet; broadleaf trees all the same lollipop in a row by the lake | O | `forest()` one geometry per species; even random scatter | 3 variants per species, scale/lean/tint variation, clustered placement (noise mask), clearings | still |
| med | nature stills | mountains pale and mostly hidden; uniform ridges | O | `terrain()` H = 75, fog 160–720 m | fewer trees on the far ridge, rock bands by slope, snow by altitude and slope, less haze on clear days | still |
| low | nature stills | grass blades huge near the camera | O | `grass()` area includes camera foreground | thin out near the camera | still |
| low | sea still | sea is a flat plane, palms missing from frame | O | `sea()` / `forest(palm)` placement | out of scope this round | — |
| info | full vs chunked, both clips | the chunked MP4s differ from the full renders by a constant 12–25/255 per frame | O | `chunk-test.ts` writes raw PNG frames, **without the FFmpeg post chain** (grade, vignette, grain) and without the voice | **not a renderer defect.** The tool compares frames before the post chain (where they are byte-identical / ≤4/255). Fix the tool to run the same post chain so the MP4s are comparable | numeric diff of the two MP4s ≈ 0 |
| info | chunked, frame 149→150 | no seam at the cut: frame-to-frame change at the cut equals its neighbours (rain 1.43 vs 1.44 / 1.62) | O | — | — | — |
| H | — | lip-sync differs between full and chunked (the chunk tool drops `_voice`) | H | `chunk-test.ts` | include speech in chunk tests | — |

## Code audit

**Rendering and time.**
- `runtime/shot.ts` uses one clock, `t = i/fps`. `simulate(i)` and `advance(i)` run in order.
- `index.ts` `render()` streams PNG frames into the FFmpeg post chain.
- `renderRange()` exists, but the production pipeline does not chunk.

**World.**
- `runtime/environment.ts` `buildSet` selects the kit by `spec.kind` (village / market / interior / road / city / nature / street / warehouse).
- `spec.world` is built by `visualPlan.ts planWorld`, which decides the landscape, sky, traffic, pedestrians and streetlights.
- Kits live in `runtime/kits.ts` (village, market, interior, road), `world/city.ts`, `world/landscape.ts` and `world/nature.ts`.

**Vehicles.**
- `world/vehicle-models.ts` holds the procedural models; `world/vehicles.ts` runs the IDM table simulation.
- `world/vehicle-fx.ts` holds the effects; each is a pure function of t.

**Characters.**
- `runtime/character.ts` (Character3D) handles skeletal clips, locomotion, IK, the face and gestures.
- GLBs come from `assets/3d/characters/<key>/character.glb` (git-ignored) via `library.ts`.
- Casting is in `casting.ts` with `config/characters3d.json`.
- Available clips:
  - Rocketbox: Idle, Walk, Run, Wave, Look_Around, Talk×4, Listen×3.
  - Quaternius: idle/walk/run/interact/react.
  - **No sit clip.**

**Gaps.**
- **No asset registry** for props, houses or animals: everything except the characters is procedural code.
- **No animals.**
- **No interaction system:** props only attach to hands.

**Tests.** 25 + 1 files (372 + 26 tests): motion, vehicles, visual direction, renderer (Chrome) and others.

## Asset candidates (not downloaded; download needs approval)

| asset | source | licence | format | note |
|---|---|---|---|---|
| Shiba Inu / Husky (dog), 12+ clips | Quaternius Ultimate Animated Animal Pack ([poly.pizza](https://poly.pizza/bundle/Animated-Animal-Pack-ILAPXeUYiS)) | CC0 | glTF | low-poly stylised; each model ~1–2 MB (to verify) |
| Pug (dog) | Quaternius Farm Animal Pack ([poly.pizza](https://poly.pizza/bundle/Farm-Animal-Pack-1kUvRTPLzT)) | CC0 | glTF | |
| Cat | Quaternius Ultimate Monsters Bundle ([poly.pizza](https://poly.pizza/bundle/Ultimate-Monsters-Bundle-5oyGWAmOB6)) | CC0 | glTF | a cartoon "monster" cat; style to check |
| Dog + Cat (2017) | Quaternius Animal Pack Vol.2 ([OpenGameArt](https://opengameart.org/content/animated-animales-low-poly)) | CC0 | FBX/Blend | needs conversion; one reported broken dog animation |

These were found by web search; the licences are stated on the listing pages. I could not open quaternius.com itself
(the fetch tool failed), so file sizes are unverified.

---

# V5 results (implemented, rendered, inspected)

## Changes by phase

**Phase 1: vehicles** (`world/vehicle-models.ts`, `world/vehicle-fx.ts`)
- **Car greenhouse.** The glass is tinted and mostly opaque, a solid crowned roof panel overhangs it, the pillars are
  thick round members flush with the glass, and there is a black belt seal. The "roll-cage" look is gone, by day and
  night.
- **City bus at night.** The saloon is lit (ceiling strip plus window glow).
- **Dust.** Low, short-lived puffs (≤ 0.95 m, ≤ 0.9 s, ≤ 1.3 m across). The band across the frame is gone.

**Phase 2: landscape** (`world/nature.ts`, `world/landscape.ts`)
- **Mountains.**
  - Domain-warped ridges under a range-scale profile (peaks, saddles, spurs).
  - Rock on steep faces and above the tree line, with strata bands.
  - Snow by altitude and slope.
  - No trees on steep or high ground.
- **River.** A deeper channel with sloping banks, a dark bed and wet-mud band, wider (17 m), calmer, partly
  transparent water.
- **Waterfall.** The grey cube cliff is replaced by a formation of displaced rock blocks with a notch, and the planar
  mirror pool by a churned foam pool.
- **Trees.** Three variants per species, non-uniform scale and lean, grove/clearing clustering.
- **Grass.** No grass right in front of the camera.
- **Rural horizon.** Village and road kits get hills and a varied tree line (`farRural`) instead of grey city boxes.

**Bug found and fixed while validating.** The two-shot camera chose its side with ground-level probes that the terrain
clamp lifted, so the camera flipped sides whenever the terrain changed (`runtime/camera.ts`). The probes now sit at
camera height.

**Phase 3: the village foundation**
- **Asset registry.**
  - `config/assets3d.json` plus `assets.ts`: stable ids, categories, file or procedural, source, licence and
    attribution, height, forward axis, clip map.
  - `resolveAsset` returns diagnostics, never throws.
  - `auditAssets` checks for a source and licence, a missing file and a size change.
  - The renderer delivers registered animals; a missing file is reported and skipped.
- **Animals.** `runtime/animal.ts`: a rigged animal as a pure function of t.
  - Eased path, heading blended over 0.9 s.
  - Walk/run phase from the distance travelled divided by a stride measured from the planted paws (no sliding).
  - Idle and actions (eat, rest, react) cross-faded.
- **Village lane.** `world/village.ts` replaces the old two-box village. Named points used by existing staging are
  unchanged.
  - **The lane:** a worn path, a stone drain, grass verges.
  - **The main house:** plinth, dado, barred and shuttered windows with sill pots, parapet with coping and jali, a
    clay-tile veranda on posts.
  - **The courtyard** behind a boundary wall with a gate: charpai, chulha, matkas, tulsi planter, bucket, clothes line
    in the wind.
  - **Neighbours:** a double-pitched clay-tile house with a bench, a thatched round hut.
  - **Trees and fields:** a neem, banana plants, shrubs, fields beyond.
  - **Water:** an India Mark II hand pump on a drained concrete platform, a standpipe tap, steel buckets.
- **Interactions.** `world/interactions.ts`, pure functions of t.
  - **Hand pump:** handle stroke, flow on the down-stroke (0.18 s lag), bucket level = the integral of the flow
    (optionally already part-full).
  - **Tap:** opens and closes with eased flow.
  - **Visuals:** the stream is a scrolling tube to the water surface, with splash drops.
  - **Characters:** the set runs `pre(t)` before the characters, so a hand follows the moving grip by IK
    (`reach` → `pump-handle`).
- **Camera.** `fixed.to`: an eased camera move between two framings (for establishing pans), a pure function of t.

## Assets

| id | source | licence | size | use |
|---|---|---|---|---|
| dog-shiba | poly.pizza/m/y4wdQpg767 (Quaternius) | CC0 1.0 | 851 KB | used: village dog, 12 clips |
| cat | poly.pizza/m/qKICY6xla2 (Quaternius) | CC0 1.0 | 239 KB | used: village cat (idle, walk, run, eat) |
| cat-blob | poly.pizza/m/2f54vbV0In (Quaternius, Monsters) | CC0 1.0 | 112 KB | downloaded, **rejected** (a legless cartoon blob) |

- **Everything else** is original procedural geometry. Human characters are the existing Rocketbox (MIT) trio.
- **Storage:** all files are under `assets/3d/animals/` (git-ignored).

## Validation

**Checks.**
- `npm run typecheck`: clean.
- `npm test`: 381 + 26 passed.
- New `village.test.ts` (9 tests):
  - handle and flow purity, flow only on the down-stroke, the bucket never empties or overflows;
  - the tap stops filling once closed;
  - registry diagnostics;
  - the dog is a pure function of t, with continuous path and heading;
  - the stride is measured.
- **Regressions:**
  - the old film's motion trace is unchanged (23 events: feet and old specs);
  - cuts in `door-tak-saath` still show 0 jumps;
  - vehicle tests pass.

**Renders.** All clips are in `projects/v5-proof/`, 1080×1920, 30 fps, Three.js r186 on ANGLE Metal (M1).

| clip | length | render | motion trace (drawn transforms) | inspected |
|---|---|---|---|---|
| `v5-vehicles.mp4` | 8 s | 19.3 s | 0 | a green bus, an auto stopping, cars, a motorcycle (the stopping auto is partly hidden by the actors in this V3 framing) |
| `v5-landscape.mp4` | 8 s | 28.2 s | 0 | varied ridges, conifer groves, a broad river with banks and reflections, birds |
| `v5-village.mp4` | 8 s | 21.7 s | 0 | an eased pan: courtyard gate and tap, the dog, Arjun and Dadaji, the veranda house, Meera at the hand pump with the cat |
| `v5-pump.mp4` | 7 s | 15.1 s | 0 | the hand stays on the grip through every stroke (8 sampled), water on down-strokes, the bucket fills 4 → ~7 L (visible from above) |
| `v5-rainy-night.mp4`, `v5-dirt-road.mp4` | 10 s | 21.6 s, 23.2 s | 25 (walkers' feet) / 0 | no dust band; tree line instead of towers |

**Chunk equality.**
- Pump clip: 210/210 byte-identical.
- Village clip: 175/240. The differing frames differ in ≤ 36 px by ≤ 13/255. Camera, characters and bones are
  bit-identical in both paths; this is the known GPU-side residue.

**Evidence images** (`projects/v5-proof/`): `landscape-before.png`, `landscape-after-establishing.png`,
`village-before.png`, `village-after-pan-strip.png`, `pump-strokes.png`, `bucket-fill-start-end.png`,
`car-roof-after.png`, `compare-v4-v5-night-dirt.png`.

## Remaining defects (by impact)

1. **Style mix:** semi-realistic Rocketbox people next to a smooth low-poly dog and a blocky low-poly cat.
2. **One-handed pumping:** a child would use both hands and her body; there is no lean or knee bend. Pumping, sitting
   and handing objects over have no body clips.
3. **Courtyard hidden:** its interior is behind its wall in street-level shots; it needs its own camera angle.
4. **Water:** still reads as a mirror strip at grazing angles; the sea and lake were not reworked; the waterfall rock
   reads as stacked boulders.
5. **Vehicles:** no textures (tread, badges); round pillars; the arch liners show a small hook at the ends.
6. **Rainy-night chunks:** the same GPU residue (≤ 13/255 on a few pixels).
7. **Chunk tool output:** the chunk-test MP4s skip the FFmpeg post chain and the voice, so they look ungraded next to the
   full renders. Their PNG comparison is the valid one.
8. **Not in production:** the village features (animals, interactions, the camera move) are not yet emitted by the story
   compiler; they are used only through hand-written shot specs.
