import type { FormatProfile, Motion, Scene } from "@studio/shared";
import { NARRATOR_ID } from "@studio/shared";
import type { Cue } from "./subtitleCues";

export interface MotionPlanInput {
  scene: Scene;
  profile: FormatProfile;
  /** Scene length from the timeline. */
  duration: number;
  /** Prop asset ids in the same order as scene.props. */
  propIds: string[];
  cues: Cue[];
}

const SLOTS: Record<number, number[]> = { 1: [0.5], 2: [0.3, 0.7], 3: [0.2, 0.5, 0.8], 4: [0.15, 0.38, 0.62, 0.85] };
export const characterSlots = (n: number): number[] => SLOTS[Math.min(4, Math.max(1, n))]!;
export const propSlots = (n: number): number[] => (n <= 1 ? [0.5] : n === 2 ? [0.4, 0.62] : [0.3, 0.5, 0.7, 0.85].slice(0, n));

const SHOT_ZOOM = { wide: 1.0, medium: 1.04, close_up: 1.18 } as const;
const cam = { layer: "camera" as const };

/**
 * Deterministic motion planner: scene hints (camera, entrance, emphasis) + timeline -> Motion primitives.
 * This is the ONLY place that decides what moves; the LLM supplies a few enum hints, never expressions.
 */
export function planMotion(input: MotionPlanInput): Motion[] {
  const { scene, duration: D } = input;
  const out: Motion[] = [];

  // ---- camera
  const z0 = SHOT_ZOOM[scene.camera.shot];
  switch (scene.camera.movement) {
    case "zoom_in": out.push({ type: "zoom", target: cam, from: z0, to: z0 + 0.18, start: 0, end: D, easing: "ease_in_out" }); break;
    case "zoom_out": out.push({ type: "zoom", target: cam, from: z0 + 0.18, to: z0, start: 0, end: D, easing: "ease_in_out" }); break;
    case "pan_left":
    case "pan_right": {
      const z = Math.max(z0, 1.15);
      const [a, b] = scene.camera.movement === "pan_left" ? [0.85, 0.15] : [0.15, 0.85];
      out.push({ type: "zoom", target: cam, from: z, to: z, start: 0, end: D, easing: "linear" });
      out.push({ type: "pan", target: cam, from: [a, 0.5], to: [b, 0.5], start: 0, end: D, easing: "ease_in_out" });
      break;
    }
    case "static":
      if (z0 > 1) out.push({ type: "zoom", target: cam, from: z0, to: z0, start: 0, end: D, easing: "linear" });
      break;
  }

  // ---- characters
  const chars = scene.characters;
  const slots = characterSlots(chars.length);
  const SLIDE = 1.3;
  chars.forEach((id, i) => {
    const target = { layer: "character" as const, id };
    const start = Math.min(0.15 * i, Math.max(0, D - SLIDE - 0.1));
    let idleFrom = 0;
    if (scene.motion.entrance !== "none") {
      // Start fully off-screen: the character's centre begins at x=-0.4 (left) or x=1.4 (right) of the canvas.
      const startCentre = scene.motion.entrance === "left" ? -0.4 : 1.4;
      const from: [number, number] = [startCentre - slots[i]!, 0];
      out.push({ type: "translate", target, from, to: [0, 0], start, end: start + SLIDE, easing: "ease_out" });
      out.push({ type: "pulse", target, axis: "y", amplitude: 0.008, frequency: 2.2, shape: "abs_sine", start, end: start + SLIDE, easing: "linear" });
      idleFrom = start + SLIDE;
    }
    if (D > idleFrom) out.push({ type: "pulse", target, axis: "scale", amplitude: 0.012, frequency: 1.2, shape: "sine", start: idleFrom, end: D, easing: "linear" });
  });

  // ---- talking emphasis: a slightly stronger pulse while a character speaks (timeline-driven)
  for (const d of scene.dialogue) {
    if (d.characterId === NARRATOR_ID || d.startTime === undefined || d.endTime === undefined || !chars.includes(d.characterId)) continue;
    out.push({ type: "pulse", target: { layer: "character", id: d.characterId }, axis: "scale", amplitude: 0.02, frequency: 3, shape: "abs_sine", start: d.startTime, end: d.endTime, easing: "linear" });
  }

  // ---- emphasis
  const tHit = Math.round(D * 0.55 * 100) / 100;
  if (scene.motion.emphasis === "impact") {
    for (const id of chars) out.push({ type: "shake", target: { layer: "character", id }, amplitude: 0.012, frequency: 18, start: tHit, end: tHit + 0.45, easing: "linear" });
  } else if (scene.motion.emphasis === "surprise" && chars[0]) {
    const target = { layer: "character" as const, id: chars[0] };
    out.push({ type: "scale", target, from: 1, to: 1.12, start: tHit, end: tHit + 0.2, easing: "ease_out_back" });
    out.push({ type: "scale", target, from: 1, to: 1 / 1.12, start: tHit + 0.25, end: tHit + 0.55, easing: "ease_in_out" });
  }

  // ---- props: pop in with overshoot
  input.propIds.forEach((id, i) => {
    const t0 = Math.min(0.9 + 0.25 * i, Math.max(0, D - 0.5));
    out.push({ type: "scale", target: { layer: "prop", id }, from: 0, to: 1, start: t0, end: t0 + 0.35, easing: "ease_out_back" });
  });

  // ---- subtitles: fade in/out + slide up
  for (const c of input.cues) {
    const target = { layer: "subtitle" as const, id: c.id };
    const inEnd = Math.min(c.start + 0.2, c.end);
    out.push({ type: "fade", target, from: 0, to: 1, start: c.start, end: inEnd, easing: "linear" });
    out.push({ type: "translate", target, from: [0, 0.015], to: [0, 0], start: c.start, end: inEnd, easing: "ease_out" });
    out.push({ type: "fade", target, from: 1, to: 0, start: Math.max(inEnd, c.end - 0.2), end: c.end, easing: "linear" });
  }
  return out;
}
