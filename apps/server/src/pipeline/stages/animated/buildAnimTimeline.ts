import type { CaptionStyle } from "../../../shots/captions";
import { audioCuesFor } from "../../../anim/cues";
import { composeShot } from "../../../anim/compose";
import { planAssets } from "../../../anim/manifest";
import type { ExtraCue } from "../../../audio/soundtrack";
import type { StageFn } from "../../types";
import { runTimelineStage } from "../shots/buildShotTimeline";
import { animationOf, animTimelineOf } from "./common";

/**
 * Stage 4 (animated pipeline, id "subtitles"): the edit. The timeline (voices + the time each action needs), word-timed captions,
 * and the soundtrack, including the sounds the animation implies: every footstep lands on a foot contact, every door sound on
 * the frame where the door starts to open.
 */
export const buildAnimTimeline: StageFn = (svc, ctx) =>
  runTimelineStage(svc, ctx, {
    timeline: (p, story) => animTimelineOf(p, story),
    style: (p, s) => animationOf(s.profiles.get(p.formatProfile)).captions as CaptionStyle,
    recipe: "-anim-v2-small-captions",
    // smaller captions in the lower third: up to two short lines, the animation stays the main thing on screen
    chunk: { maxWords: 6, maxChars: 34 },
    rain: (p) => {
      const text = (p.story?.locations ?? []).map((l) => `${l.visualIdentity} ${l.lighting}`).join(" ").toLowerCase();
      return /(rain|wet|storm|drizzle)/.test(text);
    },
    extraCues: async (p, story, tl, s) => {
      const profile = s.profiles.get(p.formatProfile);
      const anim = animationOf(profile);
      const manifest = planAssets(story, p.characters, anim);
      const out: ExtraCue[] = [];
      for (const [i, shot] of story.shots.entries()) {
        const st = tl.shots[i]!;
        const composed = composeShot({ shot, story, characters: p.characters, manifest, anim, duration: st.duration, fps: profile.video.fps, seed: i + 1, has: () => true });
        for (const c of audioCuesFor(composed.spec)) out.push({ kind: c.kind, at: st.start + c.at, volume: c.volume });
      }
      return out;
    },
  });
