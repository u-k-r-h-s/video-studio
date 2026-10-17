# First full-length story test: "मीरा और खोया बटुआ" (Meera and the Lost Purse)

A 3-minute Hindi moral story rendered end to end with the existing 2D/2.5D animated pipeline (`npm run short`, profile
`animated-short`). Plan file: `scripts/lab/stories/meera-lost-purse.json`.

```bash
npm run short -- --plan scripts/lab/stories/meera-lost-purse.json --language hi --seconds 180 --out ~/Desktop/meera-lost-purse-hindi.mp4
```

## Story

Original story; no existing characters, brands or texts.

- **Beginning:** On a sunny morning in the village of Surajpur, ten-year-old Meera is sent to buy vegetables. Under the banyan
  tree she finds a red cloth purse stuffed with money.
- **Conflict:** The lane is empty. She thinks of the red bicycle she dreams about, hides the purse and runs home. Her mother,
  Amma, sees she is hiding something. Meera argues "finders keepers". Amma asks how Meera would feel if her own piggy bank
  were lost. A slip of paper in the purse reads "Ramu".
- **Climax:** At the village square, old Ramu Kaka searches desperately; the money was a year's savings for his granddaughter
  Munni's school fees. Meera arrives, hesitates as she remembers the bicycle, then decides.
- **Ending:** She returns the purse and declines the reward ("Munni's schooling matters more; just bless me"). He blesses her.
  The narrator closes: she didn't get a bicycle, but she earned something bigger, everyone's trust. Honesty is the greatest
  wealth.

## Cast (continuity sheet)

| id | name | age / role | look (fixed for every shot) | voice |
|---|---|---|---|---|
| meera | Meera | 10, the hero | round face, big brown eyes, two long black braids; **bright yellow kurta, green salwar** | `hi-priyamvada` (female, length ×0.8) |
| ramu-kaka | Ramu Kaka | elderly farmer, purse owner | thin, grey hair, white moustache; **white kurta, brown shawl** | `hi-rohan-elder` (male, ×0.95, slower) |
| amma | Amma | Meera's mother, ~35 | long black plait, red bindi; **dark blue saree, orange border** | `hi-priyamvada-calm` (female, ×0.9, calmer) |
| narrator | — | — | — | `hi-rohan-narrator` (male, ×0.85) |

The two Piper Hindi models are shared:
- Meera and Amma: the same female model at different rates;
- narrator and Ramu Kaka: the same male model at different rates.

In the pipeline each character is ONE generated puppet image (plus face variants), so their look can't drift from shot to shot.

**Object:** one prop, the red cloth purse (`red-cloth-purse`). It appears in the lane (shot 4), is held by Meera through
shots 5–31, and is held by Ramu Kaka from shot 33.

## Locations

| id | place | time / weather | used in shots |
|---|---|---|---|
| village-lane | dusty lane, mud-brick houses, blue doors, huge banyan tree | morning, sunny | 1–11, 28, 37 |
| meera-home | courtyard: whitewashed walls, tulsi plant, charpai, clay pots | morning, sunny | 12–24, 36 |
| village-square | stone well, tea stall, peepal tree | midday, sunny | 25–27, 29–35 |

## Scenes and shots

37 shots in 7 scenes (a scene = consecutive shots in one place). Dialogue is Hindi; actions are what the animation performs.

| scene | shots | beat | what happens |
|---|---|---|---|
| 1 lane | 1–11 | hook → curiosity | establishing; Meera walks to market; spots something red; the purse; picks it up; the money; shock; looks around; dreams of the bicycle; smiles; hides it and runs home |
| 2 home | 12–24 | curiosity → escalation | courtyard; Amma looks up; Meera hides it; Amma asks; Meera shows the purse; Amma: someone's hard-earned money; Meera argues; Amma: what isn't ours isn't ours; the piggy-bank question; Meera's lip trembles; slip of paper "Ramu"; Meera realises; Amma: go return it |
| 3 square | 25–27 | escalation | square; Ramu Kaka searches around the well; Munni's school fees |
| 4 lane | 28 | escalation | Meera runs toward the square |
| 5 square | 29–35 | escalation → payoff | Meera hesitates (the bicycle again); decides; hands the purse back; his shock and relief; offers a reward; she refuses; he blesses her |
| 6 home | 36 | payoff | Meera walks home, beaming; narrator: everyone's trust |
| 7 lane | 37 | payoff | the banyan tree in the breeze; the moral |

Per-shot detail (framing, actions, lines) is in the plan file and is printed by `npm run short` at planning time.

## Validation report (2026-10-17)

**Result: a complete, playable 3-minute Hindi animated story was produced by the existing pipeline**:
`~/Desktop/meera-lost-purse-hindi.mp4`, 187.9 s, 1080×1920, 30 fps, 293 MB.

That needed two workarounds. I wrote the story myself, because the AI director can't write Hindi. I also made some minimal
fixes, listed below. It is not a reliable one-command 3-minute generator yet; see "What still prevents reliable 3-minute
generation".

### Measured

| check | result |
|---|---|
| duration / format | 187.9 s video, 187.89 s audio (7 ms apart); H.264 1080×1920 30/1; 5,637 frames = 187.9 × 30 (none missing) |
| corrupted frames | full decode: no errors; no black segment (≥0.3 s) and no frozen segment (≥2.5 s) |
| narration completeness + sync | Whisper-small (Hindi) transcribed each of the **35/35** lines inside its planned window (±0.25 s): mean character similarity 0.90, worst 0.79, none below 0.6 (the misses are ASR spelling, e.g. उदर for उधर) |
| caption timing | every caption starts exactly at its voice line; ends 0.12 s (median) / 0.23 s (max) before the voice file ends (its trailing silence); words inside a line are timed evenly, not force-aligned |
| captions | Devanagari shaped correctly (conjuncts, matras) by the existing CoreText helper; Kohinoor Devanagari; at most two lines in the lower third |
| loudness | −14.5 LUFS integrated, peak −0.9 dBFS, LRA 2.9 LU |
| continuity | each character is one generated puppet picture, so face, hair and clothes are identical in every shot; 3 locations as planned; the purse is held from pickup to hand-back (but see the issues) |
| tests | `npm test`: 332 server + 26 shared passed; `npm run typecheck`: clean |
| regression | a default English `npm run short` (LLM director, 2D renderer) after all the changes: 11 shots, 23.6 s, completed in 750 s |

**Render time:** about 19.5 min of compute for a clean run on the M1/8 GB:
- planning ~1 s (authored plan, no LLM);
- 14 images 764 s;
- 35 voices 39 s;
- captions 9 s;
- 37 shots / 5,637 frames 353 s;
- assembly 5 s.

Peak memory pressure came during image generation (ComfyUI ~3.2 GB RSS): 10 % free, 7.8 GB swap. It completed.

### Pipeline components reused unchanged

- the deterministic half of the director (`buildStory`: durations, camera, SFX, prompts);
- the asset manifest and ComfyUI generation with BiRefNet cut-outs and the content cache;
- puppet characters and face variants;
- the 2D layered renderer (`canvas2d`);
- Piper TTS;
- the voice/action timeline;
- word-chunked captions (CoreText);
- the soundtrack (SFX, music, ambience, ducking);
- the FFmpeg post chain and assembly;
- resume and caching.

### Blockers found and the minimal fixes

1. **Hindi was refused.** The animated pipeline threw "supports English only" at planning, and the LLM director's prompts
   only ever write English. *Fix:* a non-English project now runs **when it comes with an authored plan**; without one it
   still fails, with a clear message. The LLM director is unchanged.
2. **No way to hand the pipeline a written story.** *Fix:* `storyFromPlan` takes `{ outline, shots }` in the director's own
   output format. It runs the same normalisation, schemas and whole-film checks, then the same `buildStory`; only the LLM call
   is skipped. Authored plans are validated strictly (unknown ids or beats are errors, not silently remapped) and their beats
   are kept. Usage: `npm run short -- --plan <file> --language hi` (the plan is posted as `directorPlan`, checked at once,
   and stored as `director-plan.json`).
3. **3 minutes didn't fit the schema.** `StorySchema` allowed 20 shots (a 3-minute story at natural pacing needs ~35), and
   `buildStory` truncated to the profile's 12. *Fix:* the story schema allows 60 shots; an authored plan's own length is its
   limit. The profile and the LLM director keep their 12, so short films are unchanged.
4. **Only one Hindi voice (male).** *Fix:* I downloaded Piper `hi_IN-priyamvada-medium` (female; **CC BY-NC-SA 4.0, non-commercial**)
   and added an optional per-voice `lengthScale`. Hindi speaks ~2.8–3 words/s at 1.0 (measured), so the English-tuned 1.35
   was too slow. Four distinguishable voices come from two models. `hi-rohan` itself is unchanged, and the voice cache key
   now includes the new rate.
5. **Caption font.** Hindi uses the profile's Devanagari subtitle font. English captions are unaffected (same cache keys).
6. **Walking shots showed a black void.** Long narrated shots stretched a walk or run to ~3,000 px while the location
   picture is barely wider than the frame, so the following camera panned past its edge: 7 of 37 shots were half or
   entirely black. *Fix (2D renderer):*
   - a sideways walk crosses at most ~70 % of the frame, then the character stands;
   - the follow camera is clamped to the background.

   Render recipe bumped to `anim-render-v2`, so stale cached clips re-render.
7. **An unexplained API crash.** The first run died at 75 % (after captions, before render) with only `fetch failed`. There
   was no memory pressure (73 % free), no jetsam and no crash report, and the server's stderr had been thrown away. The
   resume with the same inputs completed. The cause is **unknown**. *Fix (diagnostics only):* the CLI now keeps the API's
   last stderr and prints its exit code/signal if it dies. This was not tested by killing a live run, because that would
   orphan ComfyUI.

**Workarounds:**
- I wrote the story and shot list; the AI director didn't.
- One manual `--resume` after the crash.

### Visual and continuity issues (seen in the frames)

- **The key object never really appears.** The purse reveal (shot 4), the money (6) and the name slip (22) show only the
  blurred background: insert shots of an object without a character have no art path. Where the purse is drawn, it is a
  red bag-like sprite lying at the feet; it is never visibly in Meera's or Ramu Kaka's hand.
- **Locations don't match the text.**
  - The "sunny morning village lane with a banyan tree" came out as a dark, moody, narrow alley with an arched gate.
  - The "courtyard with a charpai and tulsi" came out as a whitewashed alley with an empty stone pedestal.
  - The square has a hut but no well or tea stall.

  The profile's moody 3D-film style wins over "sunny".
- **Costumes drift from the description, but consistently.** Meera wears a teal kurta with a yellow sash instead of a yellow
  kurta with green salwar, and looks older than 10. Amma looks too young to be her mother. Ramu Kaka gained a white turban.
- **One character per shot.** The hand-back and the blessing are shot/reverse-shot; the two characters are never in one
  frame, so the climax has no physical exchange.
- **Puppet look.** Paper-doll cut-outs that slide when walking; close-ups are a talking still with face swaps. This is the
  known limitation of the 2D renderer.
- **Sound doesn't fit the tone.** The music is always the synthesised tension drone (its intensity follows the beats), and
  the ambience is always the *night* bed, even in daylight. For a gentle moral story this is wrong; it is fixed in
  `audio/soundtrack.ts`, not chosen per story.
- **The end card shows the English title** ("MEERA AND THE LOST PURSE") over a Hindi film.
- **Shared voices.** Meera and Amma are one female model at two speeds, and the narrator and Ramu Kaka are one male model.
  They are distinguishable but obviously related. The female voice is **non-commercial only**.

### What still prevents reliable 3-minute generation

1. **Story generation:** the local 7B director writes English only and ≤12 shots. A 3-minute Hindi story needs an authored
   plan (or a stronger/multilingual model and a Hindi prompt path).
2. **Object and insert shots:** objects can't carry a shot. Close-ups of the purse, the money or a note render as an empty
   background.
3. **Two-character staging:** there is no shot with two characters interacting (giving, receiving, hugging).
4. **Location fidelity and time of day:** the style prefix overrides "sunny / morning"; the plates are dark and generic.
5. **Audio mood:** music and ambience are fixed (tension drone, night), not chosen from the story.
6. **Voices:** only two Hindi models, one of them non-commercial; no child voice, no elderly voice, no pitch control.
7. **Robustness:** one unexplained API crash in two long runs. It's resumable, but a 20-minute job should not depend on
   a manual resume.
8. **Memory:** image generation pushes the 8 GB machine to 10 % free and ~8 GB swap; the job finished but has no headroom.
