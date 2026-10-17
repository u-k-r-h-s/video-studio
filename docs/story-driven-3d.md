# Story-driven visuals, character art direction and facial animation (Three.js)

Three.js is the only renderer used here: every clip records `engine: three3d`, the Three.js revision and the WebGL
renderer, and the CLI fails a `--renderer=3d` run if any clip came from another engine.

## Root causes

| problem | root cause in the code |
|---|---|
| courier everywhere | `castFor` defaulted every character to the `casual-man` model, matched models by words in folder names, and added a courier bag from words; the Director prompts used a "delivery rider" as their example |
| torch in the hand | `compile.ts`: **every `raise-object` action created a flashlight** (for example a parcel being handed over got a lit torch); the Director's schema used "raise the flashlight" as its gesture example |
| always the same daylight street | `kitFor` knew 2 sets (warehouse, suburban street with house 42): every non-industrial story got the same street; `lightingFor` fell back to `sunny-day`; weather was guessed per shot |
| black sky on grey days | the gradient sky dome (radius 400 m) lay beyond the camera's far plane (300 m): cloudy, overcast and rainy days rendered a black sky |
| repeated camera | a fixed angle per shot size (medium always 1.05 rad, close-up 0.85) and the side by seed parity; with `frameWith` the side was arbitrary when both sides were free (often the backs of the characters) |
| toy look | the geometry: Quaternius low-poly models, 3–6k triangles, flat-colour materials, no textures. Materials cannot fix this |
| no facial movement | none of the three models has blend shapes or face bones, and the shot spec carried no dialogue timing: there was nothing to animate |

## What was built (one responsibility per module)

1. **Story and characters**: the story file / Director (unchanged in structure). An authored plan can set `artStyle` and a `cast` (voice, and optionally a model).
2. **Visual direction**: `three3d/visualPlan.ts`. Decided before rendering from the story alone, per location (so a continuous scene never changes weather):
   set kit, time of day, weather, lighting preset, rain, fog, wind, a power cut, palette. Per shot: camera angle, height and
   lens, varied deterministically (no repeated angle back to back, low angles for anger/shock/awe, high for sadness, one
   screen side per scene). Written to `projects/<id>/visual-plan.json` at render time.
3. **Characters and assets**: `config/characters3d.json` (a catalogue: gender, age, style, tags, face capability, licence) and
   `three3d/casting.ts` (story-level casting by description; no two characters share a model while others are free). No
   default courier, no default props: props come from the shot's objects only.
4. **Environment, lighting, weather**: `runtime/kits.ts`, four new sets with practical lights:
   - an Indian **village** lane;
   - a **market** with Hindi signboards;
   - a home **interior**, with a power-cut mode: a candle, the tube light off, the fan stopped;
   - a country **road**.

   These join the street and warehouse sets. `runtime/lighting.ts` gains `foggy-dawn` and `power-outage`, and the sky
   bug is fixed. A soft face light from the camera side keeps faces readable at night.
5. **Body and face animation**:
   - `runtime/face.ts` finds face shapes by name: the 15 visemes, the ARKit expression shapes, blinks, or a jaw bone. A
     model with none of these reports `lipSync: "none"`.
   - `anim/lipsync.ts`: mouth opening = the loudness envelope of the line's actual voice audio (frame by frame); mouth
     shape = visemes from the Hindi/Latin text, spread over the voiced frames.
   - Expressions (happy, sad, angry, worried, surprised, fear, neutral) come from the shot's emotion, plus listener reactions.
   - Blinks every 2–5 s.
   - Talking and listening gesture clips (upper body), chosen by mood, each character at its own phase.
   - Listeners look at the speaker.
6. **Camera and composition**: `runtime/camera.ts`:
   - lens and height per shot from the plan;
   - two-shots from the set's open front;
   - close-ups frame only the speaker.
7. **Voice and timing**: unchanged (Piper, one voice per character, timeline from the real audio).
8. **Three.js rendering**: `runtime/shot.ts` applies the art style (exposure; a toon ramp for the folk style).
9. **Assembly**: unchanged; the art style's colour grade is applied in the post chain.

### Art styles (`three3d/artStyle.ts`)

| style | shading | palettes | grade | lens | characters |
|---|---|---|---|---|---|
| cinematic | PBR | warm/teal set colours | contrast 1.08, bloom, vignette | 0.92 (longer) | semi-realistic |
| semi-realistic | PBR | muted | neutral, low vignette | 1.0 | semi-realistic |
| family-animated | PBR, +12 % exposure | bright pastels | saturation 1.2, soft bloom | 1.06 (wider) | semi-realistic |
| indian-folk | 3-step toon ramp | ochre / indigo / vermilion / saffron | saturation 1.28 | 1.0 | semi-realistic |

## Character assets and their faces

| key | source / licence | look | face |
|---|---|---|---|
| rb-young-man | Microsoft Rocketbox Male_Adult_17, **MIT** | semi-realistic, textured (hoodie, cap) | 15 visemes + 33 ARKit shapes, 23 face bones: **real lip-sync** |
| rb-elder-man | Rocketbox Male_Adult_05, MIT | grey hair and beard, work vest | same |
| rb-girl | Rocketbox Female_Child_02, MIT | kurta, salwar, dupatta / headscarf | same |
| casual-man, woman-casual, farmer | Quaternius, CC0 | low-poly, flat colours | **none**: no blend shapes, no jaw bone. These cannot lip-sync; it is not faked |

The Rocketbox models are converted locally by `scripts/lab/three3d/rocketbox/convert.ts`. It uses three.js (`FBXLoader` →
`GLTFExporter`) in headless Chrome, with no other tools:
- PBR materials;
- body and head split, so the blend shapes live only on the head;
- the blend shapes kept are the 15 visemes plus the expression, blink and brow shapes;
- 12 clips per character (idle, walk, run, wave, look-around, talk ×4, listen ×3), with root motion removed and the root
  height rescaled for a child;
- 1024 px textures; 19–21 MB per character.

Sources (315 MB) are in `assets/3d/sources/` and are git-ignored.

## Evidence

- Lip-sync (Meera, "तो चलिए…"): `~/Desktop/lipsync-evidence-meera.png`. Closed before the line, rounded on "तो", wide on
  "च", narrow with teeth on "लि", spread on "ए".
- Per character, the render info records the face capabilities and the frames in which the mouth was driven by speech. In
  validation A: Dadaji 140, Meera 110, Arjun 123 frames, each only while they speak; listeners 0.
- Contrasting worlds from the story alone: `~/Desktop/contrast-rainy-night-vs-sunny-market.jpg` (validations A and B) and
  `~/Desktop/kits-four-moods.jpg` (village rain night, sunny market, power cut at home, foggy dawn road).
- No automatic torch: a test proves `raise-object` without a named torch creates none, and that one appears only when the
  shot names it.

## Full story: "अँधेरी रात का उजाला" (Light on a Dark Night)

`~/Desktop/andheri-raat-ka-ujala-3d.mp4`: 182.0 s, 1080×1920, 30 fps, 5,461 frames, 37 shots. All 37 clips were drawn by
Three.js r186 on ANGLE Metal (Apple M1).

```bash
npm run short -- --plan scripts/lab/stories/andheri-raat-ka-ujala.json --renderer=3d --seconds 180
```

**Story.** Meera, a 12-year-old girl, is afraid of the dark. Her over-confident brother Arjun and their grandfather Dadaji
are with her:
- at the afternoon market, Dadaji buys candles because he reads a storm in the sky, and Arjun laughs at him;
- that night a monsoon storm hits the village and the power goes out; Arjun's phone is dead;
- the candle Dadaji bought lights the room, and he tells Meera how a small light and someone's hand chase fear away;
- the siblings play a shadow game, and Meera, back at the door in the rain, is no longer afraid.

**What the visual plan decided.** The plan file has no environment settings; these came from the story's words and fields:

| location | set | time / weather | lighting | art style |
|---|---|---|---|---|
| mandi | market | day, sunny | `sunny-day` | cinematic |
| aangan | village | night, heavy rain | `rainy-night`, rain 1.0 | cinematic |
| ghar | interior, power cut (`lightsOut`) | night | `power-outage` (candles) | cinematic |

**Verified.**
- **Casting** (automatic): Meera → `rb-girl`, Arjun → `rb-young-man`, Dadaji → `rb-elder-man`.
- **Voices:** median pitch per speaker in the final audio, with no overlap between characters:
  - Dadaji 99–110 Hz (pratham);
  - Arjun 146–168 Hz (rohan);
  - Meera 187–216 Hz (priyamvada).
- **Lip-sync:** mouth driven by speech on 1,767 (Dadaji), 1,363 (Meera) and 1,240 (Arjun) frames.
- **Speech:** Whisper heard all 31 lines in their windows (mean similarity 0.89, worst 0.76).
- **Props:** the only prop in the film is Arjun's phone; no torch.
- **Integrity:** no decode errors, no black or frozen segments; −14.9 LUFS.
- **Tests:** `npm test` 352 + 26 passed (three consecutive full runs stable); `npm run typecheck` clean.

**Render time.** About 13.5 min of compute for the clean first pass:
- 3 location images: 336 s;
- 31 voices: 35 s;
- captions and soundtrack: 27 s;
- 37 Three.js shots: 409 s (each re-render after the lighting fixes took 370–470 s);
- assembly: 4 s.

Peak memory pressure came during image generation: 7 % free, 8.0 GB swap.

## Remaining limitations

- **Faces are viseme-level, not phoneme-aligned.** The mouth opening is the real audio envelope; the mouth shapes follow the
  text's letters spread over the voiced frames. There is no forced alignment.
- **Teeth are lit too brightly** inside the mouth (no mouth-interior occlusion in the asset). It shows in tight close-ups.
- **Only three face-capable characters** (an adult man, an elder man, a girl). There is **no adult woman and no boy** with a
  face rig yet. More Rocketbox avatars can be converted the same way (MIT), but each is a ~90 MB download.
- **Rocketbox characters wear Western clothes,** except the girl's kurta and dupatta. No saree, dhoti or kurta-pyjama for adults.
- **The models share one walk / idle / gesture set per gender.** There are no sit, give or hug clips yet, and no hand-over of
  objects between characters.
- **Set kits are procedural** (village, market, interior, road, street, warehouse): one layout each, palette and light vary.
  Unrecognised objects ("packet of candles") have no prop art and are skipped.
- **The folk style** is toon shading plus a palette, not hand-painted folk-art textures.
- **Licences:** characters MIT / CC0; two of the three voices (priyamvada, pratham) are **CC BY-NC-SA: non-commercial**.
- **Hardware:** image generation (ComfyUI) pushes the 8 GB M1 to ~7 % free memory; the Three.js render itself stays well within it.

## Milestone film: "दूर तक साथ" (Together, However Far)

`~/Desktop/door-tak-saath-3d.mp4`: 176.8 s, 1080×1920, 30 fps, 39 shots, all 39 drawn by Three.js r186 (ANGLE Metal, M1).
Validation scene first: `~/Desktop/door-tak-saath-validation-20s.mp4` (22.2 s, the film's opening, 5 shots).

```bash
npm run short -- --plan scripts/lab/stories/door-tak-saath-validation.json --renderer=3d --seconds 20
npm run short -- --plan scripts/lab/stories/door-tak-saath.json --renderer=3d --seconds 180
```

**Story.** Arjun gets his first job in the city. His sister Meera, 12, is hurt and angry. That night Dadaji explains that her
anger is fear, and the siblings make up (a promise of Sunday calls and Diwali). At the misty bus stop at dawn, Meera gives
Arjun a letter and waves him off with a smile.

**Blocking faults found in the rendered frames (not in the logs) and fixed:**
- close-ups were full-body shots: a reaction added `frameWith: door`, and the camera aimed at the root, not the head;
- a still conversation jumped back to the door after a walk-up (broken continuity);
- indoors that same meeting point stood the cast at the open front of the room (a black void behind);
- one "tea stall" made a village road a market;
- any night location forced the tension music onto a warm family story.

**Verified on the final MP4.**
- **Decode and integrity:** no black or frozen segments; −14.8 LUFS.
- **Cast:** Meera → rb-girl (in 28 shots), Arjun → rb-young-man (25), Dadaji → rb-elder-man (23).
- **Pitch bands per speaker** (33 lines), with no overlap:
  - Dadaji 99–105 Hz;
  - Arjun 139–174 Hz;
  - Meera 172–239 Hz.
- **Whisper:** mean 0.91. The weakest is "पक्का वादा?" at 0.55 (2 words); every other line is ≥ 0.77.
- **Lip-sync frames:** Arjun 1,560, Dadaji 1,373, Meera 1,238; listeners 0.
- **Shots:** 17 close-ups, 12 medium, 10 wide.
- **Sets:** village golden hour, home interior warm night, road foggy dawn.
- **Music:** warm bed + day ambience.
