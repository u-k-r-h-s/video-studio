import type { FormatProfile, Scene } from "@studio/shared";

export interface Timeline {
  lines: { dialogueId: string; start: number; end: number }[];
  /** Total scene length in seconds. */
  duration: number;
}

/**
 * Scene timeline from REAL audio durations: lead-in, then each line in order separated by a gap, then a tail.
 * For scenes with dialogue the duration is derived from the voice; for silent scenes the planned duration stands.
 */
export function buildTimeline(scene: Scene, audioSec: ReadonlyMap<string, number>, profile: FormatProfile): Timeline {
  const t = profile.timing;
  const lines: Timeline["lines"] = [];
  let cursor = t.leadInSeconds;
  for (const d of scene.dialogue) {
    const dur = audioSec.get(d.id);
    if (dur === undefined) throw new Error(`no audio duration for dialogue ${d.id}`);
    lines.push({ dialogueId: d.id, start: round3(cursor), end: round3(cursor + dur) });
    cursor += dur + t.gapSeconds;
  }
  const lastEnd = lines.at(-1)?.end;
  const duration = lastEnd === undefined ? scene.duration : Math.max(t.minSceneSeconds, round3(lastEnd + t.tailSeconds));
  return { lines, duration: round3(duration) };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
