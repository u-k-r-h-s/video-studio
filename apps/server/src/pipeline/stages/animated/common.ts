import type { AnimationSettings, FormatProfile } from "@studio/shared";
import { StageOrderError } from "../../../errors";

export { storyOf, shotsInScope, scenesFromStory } from "../shots/common";

export function animationOf(profile: FormatProfile): AnimationSettings {
  if (!profile.animation) throw new StageOrderError(`Format profile "${profile.id}" has no animation settings.`);
  return profile.animation;
}

import type { Project, Story } from "@studio/shared";
import { minShotDuration } from "../../../anim/compose";
import { planTimeline, type Timeline } from "../../../shots/timeline";
import { timelineOf } from "../shots/common";

/**
 * The edit timeline of an animated project: the real voice durations plus the time each shot's physical action needs (a walk
 * must cross the screen, a door must open). Rendering and audio both read this one timeline, so sound and picture agree.
 */
export function animTimelineOf(p: Project, story: Story): Timeline {
  const base = timelineOf(p, story); // validates that every voice exists
  const durations: Record<string, number> = {};
  for (const sh of base.shots) for (const l of sh.lines) durations[l.dialogueId] = l.localEnd - l.localStart;
  return planTimeline(story.shots, durations, { minDuration: Object.fromEntries(story.shots.map((s) => [s.id, minShotDuration(s)])) });
}
