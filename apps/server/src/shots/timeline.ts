import type { Shot } from "@studio/shared";

export interface TimelineOptions {
  /** Silence before the first line of a shot (s). Hook shots start speaking sooner. */
  lead: number;
  hookLead: number;
  /** Gap between two lines in the same shot. */
  gap: number;
  /** Hold after the last line before the cut. */
  tail: number;
}
export const DEFAULT_TIMELINE: TimelineOptions = { lead: 0.3, hookLead: 0.15, gap: 0.22, tail: 0.35 };

export interface LineTiming { dialogueId: string; characterId: string; text: string; start: number; end: number; localStart: number; localEnd: number; emphasis?: string[] }
export interface ShotTiming { shotId: string; start: number; duration: number; end: number; lines: LineTiming[] }
export interface Timeline { shots: ShotTiming[]; totalSec: number }

/**
 * Lays shots end to end. A shot lasts at least its planned duration, and long enough for its spoken lines (real audio
 * durations). All numbers are seconds from the start of the video; `local*` are relative to the shot.
 */
export function planTimeline(shots: Shot[], lineDurations: Record<string, number>, opts: Partial<TimelineOptions> = {}): Timeline {
  const o = { ...DEFAULT_TIMELINE, ...opts };
  let cursor = 0;
  const out: ShotTiming[] = [];
  for (const shot of shots) {
    let local = shot.dialogue.length ? (shot.beat === "hook" ? o.hookLead : o.lead) : 0;
    const lines: LineTiming[] = [];
    for (const d of shot.dialogue) {
      const dur = lineDurations[d.id];
      if (dur === undefined) throw new Error(`no audio duration for dialogue line ${d.id}`);
      lines.push({ dialogueId: d.id, characterId: d.characterId, text: d.text, localStart: local, localEnd: local + dur, start: cursor + local, end: cursor + local + dur, emphasis: d.emphasis });
      local += dur + o.gap;
    }
    const speech = lines.length ? lines[lines.length - 1]!.localEnd + o.tail : 0;
    const duration = Math.max(shot.duration, speech);
    out.push({ shotId: shot.id, start: cursor, duration, end: cursor + duration, lines });
    cursor += duration;
  }
  return { shots: out, totalSec: cursor };
}
