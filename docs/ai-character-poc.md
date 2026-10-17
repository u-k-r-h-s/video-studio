# AI 3D character POC (Quaternius vs Tripo vs Meshy)

**Status: PREPARED — waiting for the provider assets.** Only the Quaternius baseline has been rendered. The Tripo and Meshy
sections below are empty on purpose: nothing about them is filled in until their real exported GLBs exist in
`~/Downloads/ai-courier/tripo/` and `~/Downloads/ai-courier/meshy/`.

The single question: can an AI-generated character replace the generic Quaternius test character, visibly improve the rendered
video, and still run on the existing Three.js runtime (Character3D, rig discovery, locomotion, props/IK, camera, lighting)?

## How the comparison runs

Same scene for all three, only the character asset changes. The scene is in `scripts/lab/three3d/ai-character-poc/render.ts`:
1080×1920, 30 fps, 12 s, `sunny-day` lighting, neighbourhood set, one continuous camera with timed framings.

| time | action | camera |
|---|---|---|
| 0–2 s | idle, glance up the street | wide follow |
| 2–5 s | walk along the sidewalk, slow down, settle | wide follow |
| 5–7 s | turn to the parcel crate | medium two-shot (character + crate) |
| 7–9 s | lean in, reach, pick the parcel up (it lies on the crate until then) | medium two-shot |
| 9–10.5 s | hold it in both hands | blend to close-up |
| 10.5–12 s | raise it to read the label, then look to camera | **close-up** (kept on purpose) |

```bash
npx tsx scripts/lab/three3d/ai-character-poc/inspect.ts casual-man   # technical report (also: tripo, meshy, a file or a folder)
npx tsx scripts/lab/three3d/ai-character-poc/inspect.ts tripo        # shows what discovery found in ~/Downloads/ai-courier/tripo/
npx tsx scripts/lab/three3d/ai-character-poc/render.ts --asset casual-man   # -> ~/Desktop/three3d-ai-character-poc-casual-man.mp4
npx tsx scripts/lab/three3d/ai-character-poc/render.ts --asset tripo        # -> ~/Desktop/three3d-ai-character-poc-tripo.mp4
npx tsx scripts/lab/three3d/ai-character-poc/render.ts --asset meshy        # -> ~/Desktop/three3d-ai-character-poc-meshy.mp4
npm run short -- "<idea>" --renderer=3d --asset=tripo                       # the full pipeline with that character
```

The Quaternius model is dressed for the brief by colour overrides on its material names (blue jacket, dark trousers) and gets
the courier bag prop. A generated character wears its own modelled clothes, so it gets no overrides and no extra bag.

### Asset discovery (`apps/server/src/anim/renderers/three3d/discover.ts`)

An asset key resolves in this order (`library.ts characterFile`):
1. a library model `assets/3d/characters/<key>/character.glb` (casual-man, test-character: unchanged);
2. for an external source (`tripo`, `meshy`): a derived GLB `assets/3d/characters/ai-courier/<key>/character.glb`, if one was made;
3. otherwise the provider export folder (`~/Downloads/ai-courier/<key>/`, override with `STUDIO_3D_SOURCE_<KEY>=<dir>`).

Discovery reads only the glTF JSON of every file in the folder (recursive) and never changes anything. It sorts the files:
- **character**: a skinned GLB. If there are several, it picks the obvious one: it already has Idle + Walk, then its name says
  character/model/rig, then most clips, then most triangles. The others are listed as alternatives.
- **animation sources**: GLBs with clips and no mesh;
- **textures**: png/jpg/webp/ktx2;
- **supporting**: bin/json/txt;
- **unusable**: FBX/OBJ/USDZ etc. These must be exported as GLB.

It fails with a clear message and **never falls back to Quaternius** when:
- the folder is missing or empty: `Tripo character assets not found: ~/Downloads/ai-courier/tripo/ Please place the generated GLB files there.`
- there is no skinned mesh: the model needs rigging first;
- Idle/Walk exist only in other files: a merged GLB has to be derived first (see below);
- the file is a .gltf with external buffers/images: the browser runtime receives one self-contained file.

### Derived assets (only if needed)

If a provider ships animations as separate GLBs, they are first inspected (skeleton, bone names, clip names). They are merged
only when the runtime needs it, with the clips retargeted by bone name onto the character's skeleton. The result is written to
`assets/3d/characters/ai-courier/<provider>/character.glb` (git-ignored like all GLBs). The downloaded originals are never
modified. The exact merge procedure will be recorded here if it happens. *(Not done: no assets yet.)*

### Generic compatibility work done before the assets arrived

- **Rig discovery** (`runtime/rig.ts`): bone matching silently failed on three common auto-rig naming styles:
  - `Spine01`/`Spine02` (no chest found);
  - `L_`/`R_` prefixes (no arms or legs found);
  - side-first names like `RightLowerArm`/`RightUpperLeg` (no forearms or legs found).

  All six common styles now resolve every role: Mixamo, Mixamo without prefix, `L_`/`R_`, side-first, Unreal, and Blender `.L/.R`. Quaternius and the
  Soldier test model map exactly as before. Tests in `test/renderer3d.test.ts` and `test/discover3d.test.ts`.
- Prop pickup from the world (`PropSpec3D.restAt`), upper body bending toward a low reach target, the other hand steadying a picked-up box, a raised prop
  never pushed further out than its target, camera keys that switch a two-shot on/off, GLB load time in the render info.
  None of these change `npm run short` output.

## 1. Executive conclusion

*Pending — needs the rendered Tripo and Meshy videos.*

## 2. Quaternius baseline (measured)

`~/Desktop/three3d-ai-character-poc-casual-man.mp4`. A re-render after the rig/discovery changes is bit-identical (PSNR ∞).

| | Quaternius "Casual Character" |
|---|---|
| source / licence | poly.pizza, **CC0** (public domain): SAFE FOR COMMERCIAL USE, no attribution required |
| GLB | 1.43 MB, GLB, generator FBX2glTF |
| geometry | 4 skinned meshes, 5,776 triangles |
| materials / textures | 9 flat-colour materials, 0 textures |
| skeleton | 62 bones; every runtime role found; no toe bones; 38 finger bones; no face bones; no morph targets (no expressions) |
| clips | 24 (Idle, Walk, Run, Wave, Interact, HitRecieve, ...): all runtime roles present |
| GLB load (parse + skinned clone) | 77 ms |
| drawing | ~1.5 ms/frame (scene 23.5k triangles, 182 draw calls) |
| total render (12 s) | 28.2 s (78 ms/frame host side: PNG frame transfer, unrelated to the character) |
| peak memory | 1.60 GB (node + headless Chrome) |
| output | 20.8 MB |

Review of the baseline video:
- the low-poly game look and the weak face/hands are what the close-up exposes;
- clothing is basic geometry with flat materials, and there are no facial expressions;
- body weight looks robotic;
- the package interaction works technically but doesn't convince.

The renderer, camera, lighting and set were judged acceptable for the POC.

## 3. Tripo analysis
*Pending — no assets in `~/Downloads/ai-courier/tripo/`.*

## 4. Meshy analysis
*Pending — no assets in `~/Downloads/ai-courier/meshy/`.*

## 5. Visual comparison
*Pending.* Each character will be scored 1–10 on: overall appearance, face, hair, eyes, hands, fingers, clothing, shoes, body
proportions, silhouette, materials, textures, uniqueness, close-up quality, animation appearance, package interaction, and
overall cinematic quality. Scores come from the rendered videos (wide, medium and close-up), not from a model viewer.

## 6. Animation comparison
*Pending.* Will cover walking, stopping, turning, reaching, package pickup, holding, weight transfer, hand contact and close-up behaviour.

## 7. Technical comparison
*Pending.* Will cover GLB size, triangles, materials, texture count, resolution and GPU memory, bones, finger/face bones, morph targets, clips,
and rig roles found. Source: `inspect.ts`.

## 8. Performance comparison
*Pending.* Will cover load time, total render, drawing ms/frame and peak memory against the baseline above. Source: `result-<asset>.json`.

## 9. Licensing

Read from the providers' own terms on 2026-10-06. **The plan used for each generation is not known yet, so both are marked
LICENSE NEEDS VERIFICATION.** The plan decides the answer:

| | Tripo (Holymolly Ltd, terms updated 2025-07-11, §5.2) | Meshy (Meshy LLC, terms updated 2026-09-19, §3.2) |
|---|---|---|
| Plan | unknown | unknown |
| Free plan | Tripo retains **all rights** in inputs and outputs → NOT SAFE FOR COMMERCIAL USE | Meshy owns the output and licenses it as **CC BY 4.0**: commercial use allowed **with credit to Meshy** |
| Paid plan | the user has all rights (use, modify, distribute, monetise); Tripo keeps a licence to use/display for providing the service; no training on paid users' content | the paid user owns the output; content can be kept private |
| Restrictions | no use to build competing models/services; outputs may not be unique | no use to train competing AI models; do not remove AI watermarks/metadata in outputs; free-plan content may be used for Meshy's training; outputs may not be unique |
| Rig / animations | part of the output | rigs/animations are "Service Assets", licensed for use with your output |
| Verdict now | **LICENSE NEEDS VERIFICATION** | **LICENSE NEEDS VERIFICATION** |

## 10. Recommendation
*Pending.* Decision rule:
- one provider clearly wins → that provider;
- both only slightly better → keep Quaternius for now and run another generation round;
- both substantially better → the best combination of visual quality, animation compatibility, commercial licence and performance.

## 11. Remaining weaknesses
*Pending.*

## 12. Next step
Place the exports in `~/Downloads/ai-courier/tripo/` and `~/Downloads/ai-courier/meshy/` (and say which plan each came from).
Then:
1. Inspect both folders and check rig and clip compatibility.
2. Derive merged GLBs only if needed.
3. Render the two videos.
4. Fill in sections 1 and 3–11.
