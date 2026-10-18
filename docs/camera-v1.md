# Camera Cinematography V1: audit and fix of repetitive shots

Baseline: `fee305d`. HEAD had not moved when the work started. Renderer: Three.js only, and the runtime camera was extended, not rewritten.

## 1. What was inspected

- **V6 proof clips** (`projects/v6-proof/`): v6-village, v6-pump, v6-riders and v6-landscape, plus chunked-v6-village and chunked-v6-pump. Frames were extracted at several timestamps and as frame sequences, and the proof images were viewed. The clips were inspected as extracted frames, not watched in a player.
  - All four are one locked shot each.
  - Their cameras are hand-written `fixed` specs (`scripts/lab/three3d/v3/specs/*.json`).
  - They never pass through the shot planner, so they say nothing about the generated camera.
- **Generated cameras of real story plans:** door-tak-saath (39 shots), andheri-raat-ka-ujala and bharose-ka-parcel, compiled with `planVisuals` + `compileShot3D`.
  - door-tak-saath gave closeup 17, medium 12, wide 10.
  - Its moves were push_in 17, follow 16, pan 4, pull_out 2.
  - `side` was -1 on 36 of 39 shots.
  - over_shoulder, insert and keys were never used.
  - Every establishing shot targeted `"door"`.

## 2. Root cause (confirmed in code)

| Cause | Where | Effect |
|---|---|---|
| Camera move derived from shot size | `shots/cameraLanguage.ts` `deriveMotion`; `compile.ts` `CAMERA_MOVE` | Every close-up pushed in, every medium drifted (parallax→follow), every wide panned |
| 13 Director sizes collapsed to 3 | `compile.ts` `CAMERA_SHOT` (pov / over-shoulder were the only way to reach OTS) | Same three framings all film long |
| No scene-level planning | `visualPlan.ts` varied only the angle (anti-repeat hash) | No establishing → two-shot → coverage grammar; a cut on each line just changed angle |
| Establishing shots framed the door | `compile.ts` `target: who?.id ?? "door"` | The "place" shot was a door, not the place |
| Street sets forced `side` to the open front | `frontSide()` in compile | Near-constant screen side, as intended for continuity, but with no variety elsewhere |
| Proofs bypass the planner | hand-written `fixed` specs | The proofs looked good while the generated camera stayed repetitive |

`over_shoulder` existed in the runtime, but it looked *past* the subject at nothing in particular, at 3 m. That is why the planner never had a reason to use it.

`deriveMotion` itself was left unchanged, because the 2D path uses it. The 3D compiler no longer reads it when a coverage plan exists.

## 3. What changed

- **`three3d/cinematography.ts` (new): `planCoverage(shots)`.** A pure, deterministic, scene-local plan that says what each shot is *for*.
  - **Purposes:** establishing, master, two-shot, ots, single, reaction, insert, tracking.
  - **Scene opening:** a scene opens on the place, and a conversation opens on a two-shot.
  - **Lines:** a close line becomes a single; a medium reply becomes an OTS (shot / reverse shot); a continuing line keeps its speaker's framing; other medium lines become medium singles.
  - **Reactions:** a silent strong-emotion close-up becomes a reaction.
  - **Re-establishing:** after 4 tight shots the plan returns to the two-shot, on the next line the author did not ask to be close.
  - **Objects:** a close shot of a story object (pump, tap, bucket, letter, phone) that is not about a face becomes an insert.
  - **Movement:** a travelling character gets tracking.
  - **Push-ins:** only on a strong emotional turn. Otherwise the camera holds.
  - **Establishing angles and the ending:** establishing angles differ per scene, and the last shot rises higher and wider (a pull-out).
  - **Author's explicit choices:** low-angle and high-angle shots, and anger, awe and sadness tilts, are kept.
- **`visualPlan.ts`:** each `ShotDirection` now carries a `coverage`, with the style lens applied.
- **`compile.ts`: `coverageCamera()`** maps the coverage to `CameraSpec3D`.
  - **Establishing:** target `stage`.
  - **Two-shot and master:** `frameWith` the farthest partner.
  - **OTS:** `target` is the listener and `toward` is the speaker. The shoulder sits toward the open front of the set.
  - **Single and reaction:** target the speaker or lead.
  - **Insert:** targets a village set point (`pump-spout`, `tap`). Off the village set it falls back to a single.
  - **Tracking:** from the side, or from behind at three-quarters when the walk goes *into* the set.
  - **Fallback:** the coverage applies only if it was planned for this shot id *and* the same Director size. A shot edited after planning uses the old mapping.
  - **`fixed`** still overrides everything in the runtime.
- **`compile.ts`, hand pump:** a village shot about pumping stages the lead at the pump stand.
  - It replaces any implied walk and emits `reach → pump-handle` plus `interactions.handpump`.
  - The bucket keeps about 2.5 l per earlier pump shot in the scene.
  - A later shot of the scene cuts *into* the pumping: the hand is already on the grip and the handle is already stroking.
  - Mediums and wides frame the lead with the pump (`frameWith` handle or spout).
- **Lane walks:** "along the lane" now walks along the set, not to the door.
- **`spec.ts`:**
  - `CAMERA_SHOTS` gains `"insert"`;
  - `CameraSpec3D.purpose?: string` is used by tests and logs only.
- **`runtime/camera.ts`:**
  - **Insert:** about 0.9 m from the object's 3D point, 0.38 m above it, looking 0.22 m below it so the spout and the falling water both show.
  - **OTS:** behind the listener along the listener→speaker line and 0.7 m off the shoulder, aimed at the speaker's head. The planner's `side` picks the shoulder.
  - **Wide of a set point:** looks across at eye level instead of down at the ground.
  - **Static camera with keys:** now follows the keys. Before, `static` froze the camera at its first position and ignored them.
- **`runtime/shot.ts`:**
  - set points resolve with their real height (`head`) and `place: true`;
  - the face light follows the speaker on an OTS.
- **`runtime/environment.ts`:** every kit has a `"stage"` point, the middle of where the action is blocked.
- **`runtime/character.ts`:** an event with `at < 0` is already under way at frame 0. This is how a cut lands inside an ongoing action. It stays deterministic because the start time is `e.at`, not the first frame that was evaluated.

## 4. Before / after shot specs

**Proof story** (hand-written Director shots, cameras all generated). The "before" column is the old mapping for the same shots.

| Shot | Director | Before (size/move, target) | After (purpose: size/move, target) |
|---|---|---|---|
| 01 | establishing, pan | wide/pan, `door` | establishing: wide/pull_out, `stage`, raised |
| 02 | medium, Dadaji speaks | medium/follow, dadaji + meera | two-shot: medium/static, dadaji with meera |
| 03 | medium, Meera replies | medium/follow, meera + dadaji | ots: over_shoulder/static, behind Dadaji, toward Meera |
| 04 | close-up, push-in, Dadaji | closeup/push_in | single: closeup/static |
| 05 | close-up, push-in, silent | closeup/push_in | reaction: closeup/static, Meera |
| 06 | medium-wide, at the pump | wide/follow (an implied walk) | master: wide/static, Meera with pump-spout, pumping |
| 07 | medium, pumping | medium/follow | single (action): medium/static, Meera with pump-handle |
| 08 | close-up, water fills bucket | closeup/push_in on Meera | insert: `pump-spout`, water into the bucket |
| 09 | close-up, Meera smiles | closeup/push_in | reaction: closeup/static, hand still on the pump |
| 10 | medium-wide, walk along lane | wide/follow toward the door | tracking: wide/follow, side-on along the lane |
| 11 | wide, pull-out | wide/pull_out, `door` | establishing: wide/pull_out, `stage`, higher, other side |

**Real story plans** (`npx tsx scripts/lab/camera/plan-dump.ts scripts/lab/stories/<plan>.json 200`):

- **door-tak-saath (39 shots)**
  - Before:
    - shots: closeup 17, medium 12, wide 10;
    - moves: push_in 17, follow 12, pan 8, pull_out 2 (the size→move table alone; after the compiler turns pans on walking shots into follows it is follow 16, pan 4, as in §1).
  - After:
    - purposes: single 15, ots 9, two-shot 6, tracking 5, establishing 4;
    - moves: static 28, follow 5, push_in 4, pull_out 2.
- **andheri-raat-ka-ujala (37 shots)**
  - Before: push_in 12, follow 14, pan 10.
  - After:
    - purposes: single 14, ots 8, two-shot 7, establishing 5, tracking 2, master 1;
    - moves: push_in 5, static 28.
- **bharose-ka-parcel (43 shots)**
  - Before: push_in 15, follow 14, pan 12.
  - After:
    - purposes: single 21, tracking 8, establishing 5, ots 5, two-shot 4;
    - moves: push_in 8, static 25.
  - This story is mostly monologue, so singles dominate. They split between medium and close sizes by the author's request.

## 5. Tests

- **`test/cinematography.test.ts`** (12 tests):
  - conversation grammar;
  - beat-dependent moves (a calm close-up is held, shock pushes in);
  - establishing → stage, tracking, insert → pump;
  - determinism and scene-locality;
  - real plans: no camera above 40 % of shots, push-ins under 25 %, no calm close-up pushes in;
  - compiled specs: stage target, two-shot frameWith, OTS geometry and side, single;
  - pump staging, interaction and insert target, and the fallback off the village;
  - compile determinism;
  - runtime insert framing, OTS aim (speaker centred, listener at the edge), `fixed` + `fixed.to`, and keys blending without jumps.
- `npm run typecheck` is clean.
- `npm test` passes: 393 server and 26 shared tests.

## 6. Proof clips (`projects/camera-v1/`, 1080×1920, 30 fps)

The clips use the real compiler and the real cast (rb-elder-man, rb-girl), with Piper Hindi voices and lip-sync. Render times were measured on the M1:

| Clip | Length | Render | Shots |
|---|---|---|---|
| camera-v1-dialogue.mp4 | 14.9 s | 41.7 s | establishing → two-shot → OTS → single → reaction |
| camera-v1-pump.mp4 | 9.6 s | 25.5 s | master (girl + pump + bucket) → medium on the handle → insert of the water → reaction |
| camera-v1-walk.mp4 | 8.1 s | 19.7 s | side tracking along the lane → closing high wide |

**Frame inspection.**
- Stills were checked at 3 points per shot before each render.
- Each MP4 was then sampled at 2 fps into contact sheets.
- Defects found and fixed along the way:
  - the establishing shot looked at bare ground;
  - the OTS listener's head hid the speaker;
  - the reaction close-up had the partner's shoulder in it;
  - the pump was out of frame in the context shot;
  - the bucket was cropped in the insert;
  - the hand was off the pump at a cut;
  - the lane walk went to the door;
  - the camera ran into a porch pillar;
  - the closing wide repeated the opening.

**Chunk check** (`chunk-test.ts`, cut mid-shot). Chunked and continuous frames were byte-identical for:
- OTS (88/88);
- pumping with a pre-shot reach (78/78);
- insert (72/72);
- tracking (165/165).

## 7. Remaining issues

- The OTS reverse angle looks across open ground beyond the set (+x at z ≈ 3). The background there is empty desert. This is world dressing, not camera.
- The two-shot on a 9:16 frame is side-on and fairly wide: both characters in profile, with small faces. A tighter, more three-quarter two-shot needs staging that turns the pair toward the camera.
- A reaction close-up shows the face, but the "joy" expression only plays on lines. A silent reaction stays neutral.
- The insert is only for the village pump and tap. Letters, phones and other set kits fall back to a face close-up because there is no named point for them yet.
- The establishing pull-out is subtle (35 % in 2.6 s).
- The proof story's Director shots were hand-written. The camera was planned and compiled by the production code, but the Director (LLM) stage was not part of this proof.
- **Readiness for an 8-minute story.**
  - The camera planner is deterministic, chunk-safe, cheap (pure functions) and tested on three full-length plans.
  - At about 2.8 s of render per second of video, 8 minutes is roughly 22–25 minutes of render on this M1. This is an estimate and was not run.
  - The remaining risks are the weak two-shot staging and the world beyond the set edges. Both show up on wide reverse angles.
