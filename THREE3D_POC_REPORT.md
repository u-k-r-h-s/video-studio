# Three.js 3D character proof of concept

**Question:** does a rigged 3D character rendered through Three.js look substantially better than our 2D cut-out puppet?

**Output:** `~/Desktop/three3d-poc.mp4`: 10.0 s, 1080x1920, 30 fps, H.264 + AAC, 300 frames, 17.8 MB.
For comparison: `~/Desktop/animation-quality-test.mp4` (the 2D puppet test) and `~/Desktop/warehouse-puppet-short.mp4`.

## Result: PARTIAL

The character animation is clearly better than the 2D puppet: a real skeleton, real weight shift, a real turn, real shadows.
The overall shot is NOT yet better as a picture. The environment is a grey-box I built from primitives (flat wall, plain
barrels, uniform floor) and reads like a game-engine test scene. The test character is a helmeted sci-fi soldier, so faces
were not tested at all. The open problem is not rendering. It is **getting a rigged, story-specific character for every
short**, which this POC deliberately does not attempt.

## What was built (isolated; nothing in production changed)

| file | role |
|---|---|
| `apps/server/src/anim/three3d/scene.ts` | the scene: GLTFLoader, AnimationMixer (Idle/Walk cross-fades), procedural upper-body layer (look around, aim the torch with world-space bone aiming, flinch), torch parented to the hand bone with a SpotLight and a beam, moon + practical lamp + fill, shadows, fog, rain, follow camera with push-in |
| `scripts/lab/three3d-poc/render.ts` | esbuild bundles the scene -> **headless Google Chrome** (WebGL2 via Metal, temporary profile) renders frame by frame -> PNG -> the SAME FFmpeg post chain as the 2D renderer (`animPostGraph`: grade, bloom, vignette, grain) -> MP4; writes `last-run.json` |
| `assets/3d/characters/test-character/character.glb` | the test character (git-ignored, not committed) |

Run: `npx tsx scripts/lab/three3d-poc/render.ts` (stills: `--frames 0,90,150`).
New dev dependencies: `three` 0.186, `@types/three`, `puppeteer-core` 24 (drives the installed Chrome; no browser download).
`npm run short` and the 2D renderer are unchanged.

**Character:** `Soldier.glb` from the three.js examples (Mixamo origin: skeleton + skinning, clips Idle 1.97 s, Walk 1.03 s,
Run 0.70 s, TPose). Fine for a local test, **not for publishing**. To try another character, put a rigged `.glb` with `Idle`
and `Walk` clips (Mixamo bone names) at `assets/3d/characters/test-character/character.glb`.

## Sequence as rendered

- **0-2 s:** idle, head looks around.
- **~1.6-2.4 s:** turns from three-quarters-to-camera to the door. This is a real 3D rotation, not a mirror flip.
- **2-5 s:** idle cross-fades into the walk. The walk speed is matched to the clip, so the feet don't slide; it eases out into idle at the door.
- **5-7 s:** raises the torch, which is attached to the hand bone. The beam switches on and a hotspot lands on the wall and doorway.
- **7-9 s:** a flinch (spine, head and free arm layered on top), then two steps back with the walk clip reversed. Two eye glints appear inside, plus a camera kick.
- **9-10 s:** the camera pushes in and the lens narrows.

## Comparison with the 2D puppet

| | 2D cut-out puppet | Three.js rigged character |
|---|---|---|
| 1. Character movement | Coordinated parts, but it reads as pieces | Whole-body motion: hips, spine, shoulders and knees move together |
| 2. Walk quality | Legs swing as flat pieces, the near/far leg reads poorly | Mocap-quality walk: heel strike, knee bend, counter-swinging arms, weight shift. Clearly better |
| 3. Turning | Squash-and-flip mirror | Real rotation through three-quarter to back view. Solved |
| 4. Depth | Parallax layers on a flat painting | Real perspective, the character moves into the scene and gets smaller |
| 5. Camera | 2D pan/zoom on a flat plate | A real 3D camera: follow from behind, lens change, push-in, parallax for free |
| 6. Lighting | Tint plus rim gradient, no real light direction | Directional moon, warm practical, a torch spot that lights the wall; the light wraps the body |
| 7. Shadows | A blurred ellipse | Cast shadows from the moon and the lamp, which stretch and move with the walk |
| 8. Consistency | Same picture, but only one view | Identical from every angle by construction (front, side, back) |
| 9. Render time | ~2-7 ms/frame canvas, ~20 s for 10 s | 64 ms/frame median (13.6 fps effective), 22 s render for 10 s, 23 s total |
| 10. Memory | Node + canvas a few hundred MB (ComfyUI dominates the pipeline at ~8.6 GB) | Chrome + Node peak ~1.4 GB during render; no heavy model involved |
| 11. Overall visual quality | Looks like illustrated cut-outs, but the artwork is rich and story-specific | Movement and light look like animation; art direction looks like a grey-box game level with a stock soldier |

### Does Three.js solve our specific problems?

- **Cut-out / paper-doll look:** yes, for the character.
- **Visible joints:** yes. Skinned mesh, no seams.
- **Fake turns:** yes.
- **No profile or back view:** yes, every view comes from the same model.
- **Flat lighting:** yes. This is the most obvious gain in the video.
- **Limited camera:** yes.
- **Close-ups:** not shown. The helmet hides the face, and facial animation needs a rig with face blendshapes or bones, which the test character doesn't have.

## What still looked bad

- The environment: the flat corrugated wall, plain cylinder barrels and a uniform floor look primitive next to our ComfyUI backgrounds.
- The torch beam cone is barely visible. Only the hotspot reads. A real volumetric beam needs post-processing.
- The flinch and the step back are procedural layers on top of a walk clip. They read, but they are not a performed "react" animation. There is no clip for that.
- The look-around is subtle and the idle is generic. Story-specific acting needs a clip library (Mixamo-style), not just Idle/Walk/Run.
- No face. No lip-sync or expressions (out of scope, but it is where close-ups live).

## Performance (MacBook Air M1, 8 GB), from `scripts/lab/three3d-poc/last-run.json`

| measure | value |
|---|---|
| frames | 300 at 1080x1920 |
| scene setup | 2.3 s (first run), 0.2-0.3 s after |
| render | 22.1 s; median 64 ms/frame, p95 70 ms, max 165 ms (13.6 fps effective) |
| total | 23.3 s |
| scene | 35,442 triangles, 68 draw calls, 3 shadow-casting lights |
| final file | 17.8 MB |
| peak memory | ~1.44 GB (headless Chrome processes + Node); the Node process alone peaked at 334 MB RSS |

Most of the per-frame time is the PNG encode and transfer out of Chrome, not the WebGL render. Rendering is cheap compared with
image generation, and it never runs at the same time as ComfyUI or Ollama, so the 8 GB machine is fine for this part.

## Recommendation: **Hybrid 2D + Three.js**

Keep the AI-painted backgrounds, props, story pipeline, audio and captions. Move only **characters** to Three.js: render
them in 3D with real lights and shadows that match the plate, and composite them over (and into) the existing 2.5D layered
scene, with a ground plane for shadows and a camera matched to the plate. This keeps what our 2D system is good at (rich,
story-specific environments) and replaces what it is bad at (cut-out characters, turns, light).

This is NOT "move everything to Three.js": the grey-box environment shows that building every environment in 3D is a large
art problem. It is also NOT "keep 2D only": the gain on character motion, turns and light is too large to ignore.

**Blocking question before any integration:** where do the rigged characters come from? Options to evaluate next:
1. AI image-to-3D (Tripo/Meshy, cloud), plus auto-rigging, plus a Mixamo-style clip library.
2. A small library of rigged base bodies with generated textures/outfits.
3. Parametric characters (e.g. VRM/Ready-Player-Me-like).

Each needs a separate test for identity quality, licensing and the 8 GB limit. Until one passes, the 2D puppet stays the production system.
