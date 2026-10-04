# The cinematic shot pipeline (`cinematic-animated-short`)

This is the second pipeline of the studio. The first (`motion-comic`) builds scenes from a background plus sliding
cut-outs. This one thinks like an editor: **story -> beats -> shots -> a few key images -> 2.5D camera -> sound ->
edit**. A format selects it with `pipeline: "shots"` in its `FormatProfile`; the stages, store, memory gates, caching,
API and UI are shared with the scene pipeline.

```
idea -> Ollama (bible -> 6 beats -> shots per beat) -> validated Story (shots, locations, characters, key visuals)
     -> approve -> ComfyUI (one session): ~6-8 key images, img2img variants for the same face
     -> Piper voices (slow, dramatic) -> timeline + word-timed captions + procedural soundtrack
     -> FFmpeg: one 2.5D clip per shot -> concat + mux + loudness -> final.mp4
```

## What the model decides and what the code decides

| The LLM chooses (enums + short text) | The code derives (deterministic, tested) |
|---|---|
| title, logline, characters (appearance + ONE costume), locations (look + lighting) | ids, scenes (runs of shots per place), **durations** (from line length) |
| six story beats | **camera rig** (`cameraLanguage.ts`: shot type x beat x emotion x action) |
| per shot: beat, shot type, location, the one visible character, emotion, an action sentence, at most one spoken line, optional on-screen text | **image prompts** (character + location bibles), **which shots share an image**, img2img variants |
| | character micro-motion, transitions, SFX, impact/flash, the title card, caption timing, the audio mix |

The model never writes a camera value, a prompt, a filter or a number. A 3B model is only trusted with words.

## Story model (`packages/shared/src/story.ts`)

`Shot { id, sceneId, order, beat, duration, shotType, subjectIds, locationId, emotion, action, visualPrompt, visualKey,
focus?, camera{startScale,endScale,startX,endX,startY,endY,rotation?,endRotation?}, motion{type,shake?},
transition{type,duration?}, characterMotion[], dialogue[], sfx[], insert?, effects? }`.

Shot types: extreme-close-up, close-up, medium-close, medium, medium-wide, wide, establishing, over-shoulder, pov,
low-angle, high-angle, tracking, action. Motions: static, push-in, pull-out, pan, tilt, tracking, shake, parallax, action.
Transitions: cut, fade, zoom, match-cut. Beats: hook, setup, curiosity, conflict, escalation, payoff.
`AudioTrack { type, path, startTime, duration?, volume }` describes the audio timeline.

## The director (`shots/director.ts`)

Small structured Ollama calls (about 8 per film), each validated by zod, normalised and repaired:

1. **story bible**: title, logline, 1-3 characters (the first is the hero), 2-3 locations;
2. **six beats**: what happens in hook / setup / curiosity / conflict / escalation / payoff;
3. **shots of one beat**, called once per beat with the story so far in the prompt (a small model stays coherent when each
   call is a small task).

Deterministic repairs instead of failures: an invented place keeps the previous place, an unknown speaker becomes the
person on screen, an empty `character` is inferred from the action text or the speaker, junk and repeated lines are
dropped, near-miss enums are mapped (`scared` -> `fear`, `closeup` -> `close-up`). Quality advice (narration limits,
"that line is a place label") is sent back once per beat and then accepted, so a small model can never block the
project. After all beats: a variety pass (no framing three times in a row, at least four framings).

## Key images: few generations, shared and varied (`shots/keyVisuals.ts`)

* One image per (character, place, emotion group) for portraits, per (place, wide/detail) for environments; a phone
  insert gets one. At most **3 shots share one picture**; further shots get another take (same prompt, new seed).
* The first portrait of a character is the **identity anchor**; the character's other portraits are **img2img variants** of
  it (denoise 0.5-0.58), which kept the same jacket, face and bike in the measured prototype.
* A budget (`maxKeyImages`, 8) merges the least-used picture into its closest relative; every shot stays covered.
* Prompts are built from the **character bible** (appearance + costume, reused verbatim) and the **location bible**, and
  never mention unwanted things (LCM at low guidance ignores negative prompts).
* Model: DreamShaper 8 + LCM-LoRA, 6 steps, cfg 1.8, 512x896 (about 37-44 s per image on the M1).

## The 2.5D renderer (`shots/shotRenderer.ts`)

One FFmpeg filter graph per shot, built from data:

* **far layer**: the image, defocused (cheap depth of field), moved less; **mid layer**: the same image, sharp, cut out by
  a soft elliptical subject mask (`focus`), moved more -> real parallax. Character motion (breathing, surprise pop, fear
  tremble, nod, lean, step) moves only the mid layer.
* **camera rig**: zoom/pan/tilt with ease-in-out, roll (dutch tilt), shake, impact shake; transition punches (zoom) are baked
  into the zoom curve, fades are baked into the clip.
* **look**: haze (drifting gradient), contrast/saturation/gamma, teal-shadow / warm-highlight balance, bloom, vignette,
  sharpening (to counter the 512 px source), film grain, flash frames.
* **overlays**: word-timed captions and insert cards (phone text, title).

## Camera language (`shots/cameraLanguage.ts`)

`planCamera({shotType, beat, emotion, action, order})` -> rig + motion. Tight shots start tighter; close shots push in,
wide shots pull out, establishing shots pan (a "reveal" starts at the frame edge), low/high angles tilt with a roll,
tracking/action shots move sideways with shake. Intensity grows with emotion (calm < neutral < uneasy < tense < fear <
shock) and the beat (escalation > setup), and with action words (run, slam, burst). Pan direction alternates shot to shot.

## Audio

* **Voices**: Piper (`libritts_r`), one distinct speaker id per character (picked by measured pitch), `--length-scale 1.35`.
* **Soundtrack** (`audio/`): deterministic synthesis, no samples and no model: whoosh, impact, notification ping, elevator
  ding, door slide, footsteps, heartbeat, riser, glitch, night ambience and a tension bed whose intensity follows the
  story. SFX come from each shot's cues plus automatic ones (whoosh into a zoom transition, a hit on impact frames).
  Music and ambience are **ducked under speech**; the mix is loudness-normalised (-14 LUFS) when muxed.
* Limitation: synthesized sound is functional, not rich. A small CC0 sample pack could replace the synth per `SfxKind`
  without changing the planner.

## Captions (`shots/captions.ts`, `scripts/subpng.swift`)

Lines are split into 1-3 word phrases; Piper gives no word timestamps, so word times are **estimated** from character
weights over the real audio duration (tested to be monotonic and inside the line). One CoreText PNG per (phrase, active
word); the active word is highlighted (emphasised words in red), phrases never overlap. They sit in the lower third
above the platform UI zone, or at the top when the subject is low in the frame.

## Stages (same ids as the scene pipeline)

| Stage | Shot-pipeline implementation |
|---|---|
| `scene_planning` | `planStory` (director) |
| `image_generation` | `generateKeyVisuals` (one ComfyUI session, img2img variants, quality check, resume) |
| `voice_generation` | `generateShotVoices` |
| `subtitles` | `buildShotTimeline` (timings, captions, inserts, soundtrack mix) |
| `scene_render` | `renderShots` (one clip per shot, cached by input hash) |
| `assembly` | `assembleShots` (concat, mux, loudnorm, SRT) |

Per-scene regeneration works through the same API: a scene is a run of shots in one place. Because shots share images,
regenerating a scene's images re-renders every shot that uses those images.

## Measured on the target machine

MacBook Air M1, 8 GB, macOS 26.3.1, other apps open as in normal use.

**Hand-authored prototype "The Last Delivery"** (`scripts/lab/prototype-*.ts`, the script a good writer would produce):
22 s, 10 shots, 8 key images (about 37-44 s each, 6 of them text-to-image and 2 img2img variants of the rider's portrait),
2 voices + a silent double, 21 audio tracks. Rendering the 10 shots took 33 s (2.7-4.9 s per shot with VideoToolbox).
Integrated loudness -14 LUFS, true peak -1.4 dBFS. This is the quality ceiling of the renderer.

**Real end to end run** (`npm run short -- "Create a 25 second animated mystery short about a delivery rider."`, fresh
project, llama3.2 as the director):

| Stage | Wall time | Notes |
|---|---|---|
| planning (Ollama, ~8 small calls) | 105 s | story bible, six beats, shots per beat; Ollama then unloaded + verified |
| key images (ComfyUI, one session) | 323 s | 8 images (4 text-to-image, 4 img2img variants), 0 quality retries |
| voices (Piper) | 7 s | 7 lines |
| timeline, captions, soundtrack | 2.3 s | |
| render (FFmpeg, VideoToolbox) | 43.6 s | 11 shots |
| assembly | 0.7 s | |
| **total** | **486 s** | 1080x1920, 30 fps, 22.3 s, H.264 + AAC, 34.7 MB |

* **Intelligibility proxy:** the final mixed audio (voices + ducked music + ambience + SFX) was transcribed with Whisper
  small (`scripts/asr_check.py`, test-only) and matched the dialogue word for word. That says the speech is clear through the
  mix; it says nothing about how the voices *sound*.
* **Resume:** after a failure in the voice stage, `--resume <project-id>` re-used every cached image and finished in 42 s.
* **Image sharing:** 11 shots from 8 images; the model's first version (before the sharing cap) produced 4 images for 10
  shots and looked monotonous, which is why at most 3 shots share an image.

## Honest comparison with the comic MVP

Same machine, same idea style. The comic MVP (`~/Desktop/the-midnight-thief.mp4`): flat cut-out characters on one background,
sliding in, white-on-box subtitles, no sound design. The cinematic output: full-frame moody images with depth of field
and parallax, a different camera move per shot, word-by-word captions, ambient/tension sound, hits and whooshes, a title
card. It looks like a different class of product. What it does **not** reach is the quality of the hand-authored
prototype: the 3B director's stories are generic and repetitive (see README limitations), and characters are still images.
