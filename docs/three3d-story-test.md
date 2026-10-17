# 3-minute Hindi story rendered with Three.js: "भरोसे का पार्सल" (The Parcel of Trust)

**Output:** `~/Desktop/bharose-ka-parcel-3d.mp4`, with a render report at `~/Desktop/bharose-ka-parcel-3d.mp4.render.json`.
180.2 s, 1080×1920, 30 fps, H.264 + AAC, 282 MB. All 43 shots (5,406 frames) were drawn by Three.js.

```bash
npm run short -- --plan scripts/lab/stories/bharose-ka-parcel.json --renderer=3d --seconds 180 --out ~/Desktop/bharose-ka-parcel-3d.mp4
```

## Story

Raju is a new courier, always in a hurry and afraid of losing his job. He has to deliver a parcel to house 42 before noon,
but its owner, the schoolteacher Sunita, is out. Old Ramdeen Kaka, a retired farmer next door, warns him that a parcel was
stolen from the street only yesterday. Raju leaves the parcel on the doorstep anyway and runs off.

When Sunita comes home, the parcel is gone. It held her class's exam papers. She calls the depot, angry, and Raju rushes
back to apologise. Then Ramdeen Kaka walks up with the parcel: he had taken it in for safekeeping. He hands it to Sunita and
tells Raju that being quick is good, but responsibility matters more. Sunita forgives him.

That evening Raju rings a doorbell and waits patiently, parcel in hand, while Ramdeen and Sunita watch: "trust is built one
parcel at a time".

- 43 shots, 3 locations: the courier depot (warehouse set), Green Park colony (house 42, midday) and the same colony at
  golden hour.
- No narrator: the whole story is told through dialogue.

## Characters, models, voices

| character | role | 3D model (CC0) | voice | measured pitch of their lines in the final MP4 |
|---|---|---|---|---|
| Raju | young courier | Quaternius "Casual Character" (`casual-man`), red t-shirt, courier bag | `hi-rohan-young` (Piper rohan, rate ×0.8) | 17 lines, 129–168 Hz (median 150) |
| Sunita | schoolteacher, house 42 | Quaternius "Woman Casual" (`woman-casual`) | `hi-priyamvada` (Piper priyamvada, ×0.8) | 9 lines, 178–229 Hz (median 213) |
| Ramdeen Kaka | retired farmer, neighbour | Quaternius "Farmer" (`farmer`) | `hi-pratham-elder` (Piper pratham, ×0.95, slower) | 9 lines, 97–114 Hz (median 103) |

The three pitch ranges do not overlap, so every line is spoken by its own character's voice: no swaps and no shared audio file.
These are three distinct Piper voice identities. **Licence:** priyamvada and pratham are CC BY-NC-SA 4.0, so this video is
**non-commercial**. rohan's licence is unresolved (see config/voices.json). All three models are CC0.

## Verification of the final MP4

| check | result |
|---|---|
| renderer | startup log `RENDERER: three3d (Three.js)`; every clip and the final video record `engine: three3d`; render report: `three.js r186`, WebGL `ANGLE (Apple, ANGLE Metal Renderer: Apple M1)`, 43/43 clips |
| duration / format | 180.2 s video, 180.196 s audio; 1080×1920; 30/1 fps; 5,406 frames = 180.2 × 30 |
| integrity | full decode: no errors; no black segment (≥0.3 s); no frozen segment (≥3 s) |
| dialogue | Whisper-small heard all **35/35** lines inside their planned windows: mean character similarity 0.90, worst 0.70, none below 0.6 |
| music | a warm major-key bed plus daytime ambience (chosen from the story's mood); in the gaps, music + ambience are **8 dB below** the dialogue passages, and they are ducked further under speech; −14.9 LUFS, peak −1.3 dBFS |
| continuity | each character is one fixed rigged model in every shot; the parcel goes Raju → (left at the door, off screen) → Ramdeen → Sunita; same house 42, same depot |
| on-screen characters | 22 shots show 2–3 characters together (walk-ups, conversations, the hand-over); all three are on screen in shots 28, 30, 36 and 37 |

**Render time:**
- the full first pass was 4 min up to the soundtrack mix: planning 0 s, 3 location images ~3.5 min, 35 voices 32 s;
- the resume took 7.3 min: soundtrack 18 s, 43 Three.js shots 414 s (~77 ms/frame end to end), assembly 5 s.

**Memory (M1 / 8 GB):** the minimum was 12 % free with 6.9 GB swap, during ComfyUI image generation. During the Three.js
render it stayed at ≥45 % free.

## Why the previous video (`meera-lost-purse-hindi.mp4`) was not Three.js

It was run without `--renderer=3d`, which by design selects the 2D profile. The code also had real ways to end up on 2D
even when 3D was asked for:
- `--renderer=3D`, `three` or `threejs` silently meant 2D (only the exact string `3d` was recognised);
- `--profile` silently overrode `--renderer`;
- `--resume` ignored `--renderer`;
- nothing logged or recorded which engine drew the frames.

**Fixed.** `profiles/rendererChoice.ts`:
- only known spellings are accepted; anything else is an error;
- the API picks or validates the profile (a conflict is HTTP 400 `renderer_mismatch`);
- a resume is checked against the project's profile;
- assembly refuses any clip whose engine differs from the project's;
- every 3D clip records the Three.js revision and the WebGL renderer, and the final video records `engine`;
- the CLI logs the renderer at startup, prints the engine per clip, fails if any clip isn't from the requested engine, and
  writes the `.render.json` report.

Tested by `test/renderer-choice.test.ts`, the engine guards in `test/anim-pipeline.test.ts`, and CLI runs: an unknown value,
`--renderer=3d --profile animated-short`, and a 2D project resumed with `--renderer=3d` are all refused.

## Other problems found and fixed on the way

- **The plan's `cast` was dropped by the CLI.** The first validation render played Sunita with the man's model and gave
  **Raju the female voice**. *Fix:* the whole plan is sent, and the CLI verifies after planning that every cast entry
  reached the project and prints the model/voice map.
- **The 3D compiler staged only the first character of a shot.** *Fix:* partner staging:
  - extra subjects stand at conversation distance facing the lead, look at it and do their own actions;
  - a walk "toward <character>" ends in front of them;
  - the camera frames the group;
  - long spoken shots no longer walk a character off the set.
- **Model scale.** The "Woman Casual" export is 4.64 m tall. *Fix:* an implausible human height is normalised to 1.72 m;
  correct models are untouched.
- **Rig discovery.** That model's hand bones are called `Palm.L/R`. *Fix:* `palm` is recognised as a hand.
- **Authored plans** can name each character's 3D model and voice (`cast`) and who else is on screen (`with`). Their actions
  are not overridden by the director's "a quarter of shots must walk" rule. Partner actions stay with the partner (in
  `impliedActions`).
- **The soundtrack** was always a tension drone plus night ambience. *Fix:* a warm bed plus day ambience for gentle daytime
  stories; night or frightening stories keep the old bed (soundtrack recipe v2).
- **"fetch failed".** This was the cause of the earlier unexplained failure, and it happened again here at the soundtrack
  mix. The API's event loop is busy for minutes mixing a 3-minute soundtrack, so it resets connections, and the CLI then
  *killed the healthy API*. *Fix:* the CLI retries network-level failures for up to 10 minutes while the API process is
  alive, and prints the cause. This run continued after a `--resume` with the new CLI.

## Remaining limitations that affect quality

- **No faces or lips.** These low-poly CC0 models have no facial rig, morph targets or lip-sync, so a speaking character is
  shown only by framing and gestures.
- **Generic sets.** There are two set kits (warehouse, suburban street); there is no Indian colony or interior.
- **No hand-over animation.** The runtime has no "put down / give" motion, so the parcel changes hands across cuts, not on
  screen.
- **Camera framing.** In one running shot (23) the runner passes very close to the camera. Some runs head off the edge of the
  depot set into plain grey.
- **Woman Casual has a smaller clip set** (no wave, interact or react clips); procedural layers cover some of it.
- **Voices and licence.** The voices are distinct but robotic (Piper medium). Two of three are non-commercial, so this video
  can't be monetised as is.
- **Event loop.** The API's long synchronous audio mix still blocks its event loop. The CLI now tolerates it, but the real fix
  (a worker thread) isn't done.
- **Process.** The run needed one `--resume` (before the CLI fix).
