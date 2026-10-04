import type { Beat, CameraRig, ShotMotion, ShotType, StoryEmotion } from "@studio/shared";

/**
 * Camera language: camera movement is DERIVED from story beat + shot type + emotion + action, never random and never
 * invented by the LLM. Pure and deterministic, so it is unit-testable and cacheable.
 *
 * Units: scale >= 1 (zoom); x/y = crop position inside the available slack (0 left/top, 0.5 centre, 1 right/bottom).
 */
export interface CameraInput {
  shotType: ShotType;
  beat: Beat;
  emotion: StoryEmotion;
  /** Free-text action of the shot; a few keywords change the camera (reveal, run, chase, open...). */
  action?: string;
  duration: number;
  /** Alternates pan/tilt direction so consecutive shots do not all move the same way. */
  order: number;
  /** Director's explicit choice; otherwise it is derived. */
  motion?: ShotMotion;
}

export interface CameraPlan {
  camera: CameraRig;
  motion: { type: ShotMotion; shake?: number };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const has = (t: string | undefined, re: RegExp) => !!t && re.test(t);

/** How urgent/violent the movement is, 0 (frozen) .. 1 (frantic). */
export function intensity(emotion: StoryEmotion, beat: Beat, action?: string): number {
  const byEmotion: Record<StoryEmotion, number> = { calm: 0.15, sad: 0.2, neutral: 0.35, joy: 0.4, curious: 0.4, awe: 0.45, uneasy: 0.5, eerie: 0.5, tense: 0.65, anger: 0.75, fear: 0.8, shock: 0.95 };
  let v = byEmotion[emotion];
  const byBeat: Record<Beat, number> = { hook: 0.15, setup: -0.1, curiosity: 0, conflict: 0.1, escalation: 0.2, payoff: -0.05 };
  v += byBeat[beat];
  if (has(action, /\b(run|runs|chase|rush|slam|burst|crash|lunge|sprint)\b/i)) v += 0.2;
  return clamp(v, 0, 1);
}

/** Pick the motion type when the director did not. */
export function deriveMotion(i: CameraInput): ShotMotion {
  if (i.motion) return i.motion;
  if (has(i.action, /\b(reveal|reveals|uncover|emerges?|turns? around)\b/i)) return "pan";
  switch (i.shotType) {
    case "extreme-close-up": return intensity(i.emotion, i.beat, i.action) > 0.7 ? "shake" : "push-in";
    case "close-up": return i.emotion === "calm" || i.emotion === "sad" ? "push-in" : "push-in";
    case "medium-close": return "push-in";
    case "medium": return "parallax";
    case "medium-wide": return "pan";
    case "wide": return "pull-out";
    case "establishing": return "pan";
    case "over-shoulder": return "parallax";
    case "pov": return "push-in";
    case "low-angle": return "tilt";
    case "high-angle": return "tilt";
    case "tracking": return "tracking";
    case "action": return "action";
  }
}

export function planCamera(i: CameraInput): CameraPlan {
  const I = intensity(i.emotion, i.beat, i.action);
  const motion = deriveMotion(i);
  const dir = i.order % 2 === 0 ? 1 : -1; // alternate direction shot to shot
  const reveal = has(i.action, /\b(reveal|reveals|uncover|emerges?|turns? around)\b/i);
  // base zoom per framing: tighter shots start tighter
  const base: Record<ShotType, number> = { "extreme-close-up": 1.12, "close-up": 1.08, "medium-close": 1.05, medium: 1.03, "medium-wide": 1.02, wide: 1.0, establishing: 1.0, "over-shoulder": 1.04, pov: 1.04, "low-angle": 1.06, "high-angle": 1.04, tracking: 1.08, action: 1.06 };
  const s0 = base[i.shotType];
  // zoom travel grows with intensity: calm ~ +0.03, discovery/shock ~ +0.14
  const travel = 0.03 + 0.12 * I;
  const cam: CameraRig = { startScale: s0, endScale: s0, startX: 0.5, endX: 0.5, startY: 0.5, endY: 0.5 };
  let shake: number | undefined;

  switch (motion) {
    case "static":
      break;
    case "push-in":
      cam.endScale = s0 + travel;
      break;
    case "pull-out":
      cam.startScale = s0 + travel;
      cam.endScale = s0;
      break;
    case "pan": {
      cam.startScale = Math.max(s0, 1.1);
      cam.endScale = cam.startScale + (reveal ? 0 : 0.02);
      const a = reveal ? 0.05 : 0.3, b = reveal ? 0.5 : 0.7; // reveal: start nearly at the edge, uncover the subject
      cam.startX = dir > 0 ? a : 1 - a;
      cam.endX = dir > 0 ? b : 1 - b;
      break;
    }
    case "tilt": {
      cam.startScale = Math.max(s0, 1.1);
      cam.endScale = cam.startScale + travel * 0.5;
      const up = i.shotType !== "high-angle"; // low-angle tilts up, high-angle tilts down
      cam.startY = up ? 0.78 : 0.22;
      cam.endY = up ? 0.3 : 0.7;
      cam.rotation = up ? 1.2 * dir : -0.8 * dir;
      cam.endRotation = 0;
      break;
    }
    case "tracking":
      cam.startScale = cam.endScale = Math.max(s0, 1.12);
      cam.startX = dir > 0 ? 0.2 : 0.8;
      cam.endX = dir > 0 ? 0.8 : 0.2;
      shake = 0.003 + 0.004 * I;
      break;
    case "shake":
      cam.endScale = s0 + travel * 0.6;
      shake = 0.005 + 0.007 * I;
      break;
    case "parallax":
      cam.startScale = s0;
      cam.endScale = s0 + travel * 0.7;
      cam.startX = 0.5 - 0.08 * dir;
      cam.endX = 0.5 + 0.08 * dir;
      break;
    case "action":
      cam.startScale = Math.max(s0, 1.1);
      cam.endScale = cam.startScale + travel;
      cam.startX = dir > 0 ? 0.25 : 0.75;
      cam.endX = dir > 0 ? 0.7 : 0.3;
      shake = 0.006 + 0.008 * I;
      break;
  }

  // emotion colouring on top of the base motion
  if ((i.emotion === "fear" || i.emotion === "shock" || i.emotion === "tense") && shake === undefined && motion !== "static") shake = 0.002 + 0.004 * I;
  if (i.emotion === "eerie" || i.emotion === "uneasy") { cam.rotation = (cam.rotation ?? 0) + 1.5 * dir; cam.endRotation = cam.endRotation ?? cam.rotation; } // slight dutch tilt
  if (i.emotion === "shock") { cam.rotation = (cam.rotation ?? 0) - 2 * dir; cam.endRotation = 0; }

  const out: CameraRig = {
    startScale: clamp(cam.startScale, 1, 1.6), endScale: clamp(cam.endScale, 1, 1.6),
    startX: clamp(cam.startX, 0, 1), endX: clamp(cam.endX, 0, 1), startY: clamp(cam.startY, 0, 1), endY: clamp(cam.endY, 0, 1),
    ...(cam.rotation !== undefined ? { rotation: clamp(cam.rotation, -12, 12) } : {}),
    ...(cam.endRotation !== undefined ? { endRotation: clamp(cam.endRotation, -12, 12) } : {}),
  };
  return { camera: out, motion: { type: motion, ...(shake !== undefined ? { shake: Math.min(0.02, shake) } : {}) } };
}

/** Default soft subject region (normalised) for depth-of-field and parallax, by framing. */
export function defaultFocus(shotType: ShotType): { x: number; y: number; rx: number; ry: number } {
  switch (shotType) {
    case "extreme-close-up": return { x: 0.5, y: 0.45, rx: 0.5, ry: 0.28 };
    case "close-up": return { x: 0.5, y: 0.42, rx: 0.42, ry: 0.3 };
    case "medium-close": return { x: 0.5, y: 0.45, rx: 0.4, ry: 0.34 };
    case "medium": return { x: 0.5, y: 0.5, rx: 0.34, ry: 0.36 };
    case "over-shoulder": return { x: 0.55, y: 0.45, rx: 0.32, ry: 0.3 };
    case "medium-wide": return { x: 0.5, y: 0.55, rx: 0.3, ry: 0.4 };
    case "pov": return { x: 0.5, y: 0.5, rx: 0.45, ry: 0.4 };
    case "low-angle": return { x: 0.5, y: 0.45, rx: 0.4, ry: 0.42 };
    case "high-angle": return { x: 0.5, y: 0.55, rx: 0.4, ry: 0.38 };
    case "tracking": case "action": return { x: 0.5, y: 0.55, rx: 0.34, ry: 0.4 };
    case "wide": case "establishing": return { x: 0.5, y: 0.6, rx: 0.55, ry: 0.5 };
  }
}
