import type { AnimationEvent, EventType } from "./types";
import type { ShotAnimAction, ShotObjectAction } from "@studio/shared";

/**
 * Director -> animation events. The director states WHAT physically happens in a shot ("the rider walks, then turns her head")
 * with a coarse `when`; this compiles it into timed AnimationEvents. The model never writes a time or a pixel, so a bad answer
 * can only produce a boring shot, never a broken one.
 */
const WHEN_AT: Record<string, number> = { start: 0.04, early: 0.2, mid: 0.42, late: 0.66, end: 0.86 };
/** Seconds an action takes when the director gives no duration (walks and runs fill most of the shot). */
const DEFAULT_DURATION: Partial<Record<string, number>> = {
  walk: 0.7, run: 0.6, enter: 0.5, exit: 0.45, turn: 0.28, "head-turn": 0.5, "look-left": 0.6, "look-right": 0.6, "look-up": 0.6, "look-down": 0.7, "look-center": 0.5,
  nod: 0.8, "shake-head": 0.9, lean: 0.9, "step-forward": 0.7, "step-back": 0.7, "hand-gesture": 1.2, point: 1.0, react: 0.7, surprise: 0.9, fear: 1.4, anger: 1.2, smile: 1.4, idle: 1,
};
const SCREEN_X = { left: 190, center: 540, right: 890 };

export interface CompileInput {
  duration: number;
  width: number;
  actions: ShotAnimAction[];
  objects: ShotObjectAction[];
  /** layer id of each named character / object in the shot (default: the name itself). */
  ids?: Record<string, string>;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function compileAnimation(input: CompileInput): AnimationEvent[] {
  const D = input.duration;
  const out: AnimationEvent[] = [];
  const idOf = (name: string): string => input.ids?.[name] ?? name;
  const place = (when: string, dur: number): { start: number; duration: number } => {
    const start = clamp((WHEN_AT[when] ?? WHEN_AT.mid!) * D, 0, Math.max(0, D - 0.2));
    return { start: Math.round(start * 100) / 100, duration: Math.round(clamp(dur, 0.1, Math.max(0.1, D - start)) * 100) / 100 };
  };
  for (const a of input.actions) {
    const base = DEFAULT_DURATION[a.action] ?? 0.8;
    // walking and running fill the time from their start to the end of the shot unless the director says otherwise
    const dur = a.duration ?? (a.action === "walk" || a.action === "run" || a.action === "enter" ? Math.max(base, D * (1 - (WHEN_AT[a.when] ?? 0.42)) - 0.1) : base);
    const { start, duration } = place(a.when, dur);
    const params: AnimationEvent["params"] = {};
    if (a.action === "walk" || a.action === "run" || a.action === "enter" || a.action === "exit") {
      const x = typeof a.to === "number" ? a.to : a.to === "left" || a.to === "center" || a.to === "right" ? SCREEN_X[a.to] : undefined;
      if (x !== undefined) params.to = x;
      else if (a.action === "walk" || a.action === "run") params.to = SCREEN_X.right;
      if (a.action === "exit") params.side = a.to === "left" ? "left" : "right";
      if (a.action === "enter") params.side = typeof a.to === "number" ? "left" : "left";
    }
    if (a.action === "turn" || a.action === "head-turn") params.to = a.to === "left" || a.to === "right" || a.to === "camera" ? a.to : "camera";
    out.push({ targetId: idOf(a.character), type: a.action as EventType, start, duration, ...(Object.keys(params).length ? { params } : {}) });
  }
  for (const o of input.objects) {
    const type: EventType = o.action === "flicker" ? "flicker" : (o.action as EventType);
    const { start, duration } = place(o.when, o.duration ?? (o.action === "open" || o.action === "close" ? 0.9 : o.action === "drive" ? Math.max(1, D * 0.5) : 0.6));
    out.push({ targetId: idOf(o.object), type, start, duration, ...(o.action === "glow" ? { params: { color: "#9fd6ff", radius: 300, amount: 0.7 } } : {}) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Camera that responds to the action: it follows a character who walks or runs, shakes when someone reacts or is startled,
 * and otherwise creeps in (calm) or pushes harder (tense).
 */
export function cameraForActions(opts: { duration: number; actions: ShotAnimAction[]; tense: boolean; width: number; ids?: Record<string, string> }): AnimationEvent[] {
  const D = opts.duration;
  const out: AnimationEvent[] = [];
  const mover = opts.actions.find((a) => a.action === "walk" || a.action === "run");
  if (mover) out.push({ targetId: "camera", type: "camera", start: 0, duration: D, params: { mode: "follow", target: opts.ids?.[mover.character] ?? mover.character, screenX: mover.to === "left" ? 0.62 : 0.38, tau: mover.action === "run" ? 0.25 : 0.35 } });
  out.push({ targetId: "camera", type: "camera", start: 0, duration: D, params: { mode: "push", zoom: opts.tense ? 1.25 : 1.1 } });
  const startled = opts.actions.find((a) => a.action === "react" || a.action === "surprise" || a.action === "fear");
  if (startled) {
    const at = clamp((WHEN_AT[startled.when] ?? 0.42) * D, 0, D - 0.3);
    out.push({ targetId: "camera", type: "camera", start: at, duration: Math.min(1.2, D - at), params: { mode: "shake", amount: startled.action === "fear" ? 18 : 28, decay: 4.5 } });
  }
  return out;
}
