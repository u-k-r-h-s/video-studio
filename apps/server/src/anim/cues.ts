import { CharacterTimeline } from "./character";
import type { AnimShotSpec, AudioCue } from "./types";

const num = (p: Record<string, number | string | boolean> | undefined, k: string, d: number): number => (typeof p?.[k] === "number" ? (p[k] as number) : d);

/**
 * Sounds implied by the animation, from the events alone (no art needed): a footstep on every foot contact of every
 * walking/running character, a door sound when a door opens or closes, explicit `sfx` on events, an impact for a strong camera
 * shake. These are the sounds that must land on the frame where the visible event happens.
 */
export function audioCuesFor(spec: AnimShotSpec): AudioCue[] {
  const cues: AudioCue[] = [];
  for (const l of spec.layers) {
    if (l.type !== "character") continue;
    const tl = new CharacterTimeline(l, spec.events, { nativeFacing: -1, variants: new Set() }, spec.duration);
    for (const t of tl.footContacts()) if (tl.speed(t) > 40) cues.push({ kind: "footsteps", at: t, volume: 0.5 });
  }
  for (const e of spec.events) {
    if (e.type === "open" || e.type === "close") cues.push({ kind: "door", at: e.start, volume: 0.6 });
    if (typeof e.params?.sfx === "string") cues.push({ kind: e.params.sfx as AudioCue["kind"], at: e.start + num(e.params, "sfxAt", 0), volume: num(e.params, "sfxVolume", 0.6) });
    if (e.type === "camera" && e.params?.mode === "shake" && e.params?.impact !== false && num(e.params, "amount", 18) >= 12) cues.push({ kind: "impact", at: e.start, volume: 0.7 });
  }
  return cues.sort((a, b) => a.at - b.at);
}
