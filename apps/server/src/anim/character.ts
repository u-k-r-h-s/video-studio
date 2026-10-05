import { Track, ease, envelope, noise1 } from "./ease";
import type { AnimationEvent, VisualLayer } from "./types";

/**
 * Character animation by procedural pose: body-part transforms (bob, sway, leg swing, head turn/nod/shake, lean, pop,
 * tremble) driven by timed events. Walking is DERIVED from the distance the character travels (leg phase = distance /
 * stride), so feet never skate and any horizontal movement walks or runs; a stop stops the legs.
 *
 * Units: offsets are fractions of the character's on-screen height H; angles in degrees; times in seconds.
 */
export interface LegPose { rot: number; lift: number }
/** Conventions: headRot/headDx/trembleX are SCREEN space (clockwise / right positive); lean is relative to the facing direction. */
export interface Pose {
  bob: number; // + = body lower
  lean: number; // torso rotation about the hips, + = leaning toward the facing direction
  headRot: number;
  headDx: number;
  headDy: number; // + = down
  headSquashX: number;
  headSquashY: number;
  legL: LegPose;
  legR: LegPose;
  pop: number; // extra uniform scale
  trembleX: number;
  trembleY: number;
  /** Head variant weights (sum <= 1; the rest is the neutral head). Keys: front, lookL, lookR, surprised, smile, worried, angry. */
  head: Record<string, number>;
}
export interface RootState { x: number; y: number; scale: number; /** signed horizontal scale: facing * native flip, passes through ~0 during a turn */ sx: number; facing: number }

export const HEAD_VARIANTS = ["front", "lookL", "lookR", "surprised", "smile", "worried", "angry"] as const;
const LOOKS = ["center", "left", "right", "up", "down", "camera"] as const;
const EXPRS = ["neutral", "smile", "surprised", "fear", "anger"] as const;
type Look = (typeof LOOKS)[number];
type Expr = (typeof EXPRS)[number];

const num = (p: AnimationEvent["params"], k: string, d: number): number => (typeof p?.[k] === "number" ? (p[k] as number) : d);
const str = (p: AnimationEvent["params"], k: string, d: string): string => (typeof p?.[k] === "string" ? (p[k] as string) : d);

export interface CharacterOptions {
  /** Which way the source art faces on screen: -1 = left, +1 = right. */
  nativeFacing: -1 | 1;
  /** Does the rig have separate head variants (otherwise looks/expressions fall back to head transforms)? */
  variants: ReadonlySet<string>;
}

export class CharacterTimeline {
  readonly pathX: Track;
  readonly pathY: Track;
  /** Cumulative distance travelled along x (px). */
  readonly dist: Track;
  readonly facing: Track;
  readonly runBlend: Track;
  /** Depth scale (walking toward / away from the camera). */
  readonly scaleT: Track;
  /** Visibility (fade / appear / disappear events) and flicker. */
  private readonly opacityT: Track;
  private readonly look = {} as Record<Look, Track>;
  private readonly expr = {} as Record<Expr, Track>;
  private readonly events: AnimationEvent[];
  readonly H: number;
  private readonly baseH: number;

  constructor(private readonly layer: VisualLayer, events: AnimationEvent[], private readonly opts: CharacterOptions, private readonly durationSec: number) {
    this.events = events.filter((e) => e.targetId === layer.id).sort((a, b) => a.start - b.start);
    this.H = (layer.height ?? 900) * layer.scale;
    this.pathX = new Track(layer.x);
    this.pathY = new Track(layer.y);
    this.dist = new Track(0);
    this.facing = new Track(layer.flipX ? -opts.nativeFacing : opts.nativeFacing === -1 ? -1 : 1);
    this.runBlend = new Track(0);
    this.scaleT = new Track(layer.scale);
    this.opacityT = new Track(this.events.some((e) => e.type === "appear") ? 0 : layer.opacity);
    this.baseH = layer.height ?? 900;
    for (const l of LOOKS) this.look[l] = new Track(l === "center" ? 1 : 0);
    for (const x of EXPRS) this.expr[x] = new Track(x === "neutral" ? 1 : 0);
    this.compile();
  }

  private setLook(t: number, ramp: number, to: Look): void {
    for (const l of LOOKS) this.look[l].moveTo(t, ramp, l === to ? 1 : 0, "inOut");
  }
  private setExpr(t: number, ramp: number, to: Expr): void {
    for (const x of EXPRS) this.expr[x].moveTo(t, ramp, x === to ? 1 : 0, "inOut");
  }
  private faceTo(t: number, dur: number, dir: number): void {
    if (Math.sign(this.facing.at(t)) !== Math.sign(dir) || Math.abs(this.facing.at(t)) < 0.99) this.facing.moveTo(t, dur, dir, "inOut");
  }

  private compile(): void {
    let cursorX = this.layer.x;
    for (const e of this.events) {
      const { start: s, duration: d, params: p } = e;
      switch (e.type) {
        case "walk": case "run": case "enter": case "exit": case "move": case "step-forward": case "step-back": {
          const run = e.type === "run" || (e.type === "enter" || e.type === "exit" ? str(p, "mode", "walk") === "run" : false);
          let to = typeof p?.to === "number" ? (p.to as number) : cursorX;
          if (e.type === "exit") to = str(p, "side", "right") === "left" ? -400 : 1080 + 400;
          if (e.type === "enter") {
            const from = typeof p?.from === "number" ? (p.from as number) : str(p, "side", "left") === "right" ? 1080 + 400 : -400;
            this.pathX.setInitial(from); // off screen until the entrance starts
            cursorX = from;
            to = typeof p?.to === "number" ? (p.to as number) : 540;
          }
          if (e.type === "step-forward" || e.type === "step-back") {
            const dirF = Math.sign(this.facing.at(s)) * (this.opts.nativeFacing === -1 ? 1 : 1);
            const screenDir = dirF === 0 ? 1 : dirF;
            to = cursorX + screenDir * (e.type === "step-forward" ? 1 : -1) * num(p, "distance", 0.12) * this.H;
          }
          const dx = to - cursorX;
          if (Math.abs(dx) > 1) this.faceTo(s, Math.min(0.22, d * 0.4), Math.sign(dx));
          const easing = str(p, "ease", "inOut") as import("./ease").Easing;
          const sc0 = this.scaleT.at(s), sc1 = typeof p?.scale === "number" ? (p.scale as number) : sc0;
          this.pathX.moveTo(s, d, to, easing);
          // distance is measured in character heights, so a smaller (more distant) character takes proportionally smaller steps
          const dy = typeof p?.y === "number" ? (p.y as number) - this.pathY.at(s) : 0;
          const len = Math.hypot(dx, dy) + Math.abs(sc1 - sc0) * this.baseH * 0.8; // walking toward the camera also covers ground
          this.dist.moveTo(s, d, this.dist.at(s) + len / (this.baseH * ((sc0 + sc1) / 2)), easing);
          if (typeof p?.y === "number") this.pathY.moveTo(s, d, p.y as number, easing);
          if (sc1 !== sc0) this.scaleT.moveTo(s, d, sc1, easing);
          this.runBlend.moveTo(s, 0.15, run ? 1 : 0, "inOut");
          cursorX = to;
          break;
        }
        case "turn": {
          const to = str(p, "to", "right");
          if (to === "left") this.faceTo(s, Math.max(0.1, d), -1);
          else if (to === "right") this.faceTo(s, Math.max(0.1, d), 1);
          else if (to === "camera") { this.setLook(s, Math.max(0.1, d * 0.6), "camera"); }
          break;
        }
        case "look-left": this.setLook(s, num(p, "ramp", 0.16), "left"); break;
        case "look-right": this.setLook(s, num(p, "ramp", 0.16), "right"); break;
        case "look-up": this.setLook(s, num(p, "ramp", 0.16), "up"); break;
        case "look-down": this.setLook(s, num(p, "ramp", 0.16), "down"); break;
        case "look-center": this.setLook(s, num(p, "ramp", 0.16), "center"); break;
        case "head-turn": {
          const to = str(p, "to", "right");
          this.setLook(s, Math.max(0.12, Math.min(d, 0.45)), to === "left" ? "left" : to === "camera" ? "camera" : to === "right" ? "right" : "center");
          break;
        }
        case "fade": this.opacityT.moveTo(s, d, num(p, "to", 0), "inOut"); break;
        case "appear": this.opacityT.moveTo(s, Math.min(d, 0.3), this.layer.opacity, "out"); break;
        case "disappear": this.opacityT.moveTo(s, d, 0, "in"); break;
        case "smile": this.setExpr(s, 0.2, "smile"); if (p?.hold !== true) this.setExpr(s + d, 0.25, "neutral"); break;
        case "neutral": this.setExpr(s, 0.2, "neutral"); break;
        case "surprise": case "react": {
          this.setExpr(s, 0.07, "surprised");
          this.setExpr(s + Math.max(0.5, d), 0.3, "neutral");
          break;
        }
        case "fear": this.setExpr(s, 0.15, "fear"); if (p?.hold !== true) this.setExpr(s + d, 0.3, "neutral"); break;
        case "anger": this.setExpr(s, 0.15, "anger"); if (p?.hold !== true) this.setExpr(s + d, 0.3, "neutral"); break;
        default: break;
      }
    }
  }

  /** Foot-contact times (seconds) for footstep sound: whenever the travelled distance passes half a stride multiple. */
  footContacts(fps = 240): number[] {
    const out: number[] = [];
    const step = this.stride(0) / this.H;
    let last = Math.floor(this.dist.at(0) / step);
    for (let i = 1; i <= this.durationSec * fps; i++) {
      const t = i / fps;
      const idx = Math.floor((this.dist.at(t) + step * 0.5) / step);
      if (idx > last) { out.push(t); last = idx; }
    }
    return out;
  }

  private stride(runBlend: number): number {
    return this.H * (0.30 + 0.10 * runBlend); // one step: walking ~2 steps/s at 520 px/s, running ~3 steps/s at 1100 px/s (for a 900 px character)
  }

  /** Horizontal speed in px/s on screen. */
  speed(t: number): number {
    const h = 0.04;
    const dx = this.pathX.at(t + h) - this.pathX.at(t - h), dy = this.pathY.at(t + h) - this.pathY.at(t - h);
    const ds = Math.abs(this.scaleT.at(t + h) - this.scaleT.at(t - h)) * this.baseH * 0.8;
    return (Math.hypot(dx, dy) + ds) / (2 * h);
  }

  /** Speed in character heights per second (independent of depth scale). */
  private speedN(t: number): number { return this.speed(t) / (this.baseH * this.scaleT.at(t)); }

  /** Current opacity including glitch flicker events. */
  alpha(t: number): number {
    let a = this.opacityT.at(t);
    for (const e of this.events) {
      if (e.type !== "flicker" || t < e.start || t > e.start + e.duration) continue;
      const n = noise1(t * num(e.params, "rate", 8), num(e.params, "seed", 5));
      const depth = num(e.params, "depth", 0.5);
      a *= n > num(e.params, "threshold", 0.3) ? 1 - depth : 1;
    }
    return a;
  }

  root(t: number): RootState {
    const f = this.facing.at(t);
    const sx = f * (this.opts.nativeFacing === -1 ? -1 : 1);
    // a turn passes through 0: keep a sliver so the figure squashes but never vanishes
    return { x: this.pathX.at(t), y: this.pathY.at(t), scale: this.scaleT.at(t), sx: Math.abs(sx) < 0.05 ? 0.05 * (sx < 0 ? -1 : 1) : sx, facing: Math.sign(f) || 1 };
  }

  pose(t: number): Pose {
    const run = this.runBlend.at(t);
    const v = this.speedN(t);
    const move = ease("inOut", Math.min(1, v / (0.19 + 0.10 * run))); // 0 = standing, 1 = full gait
    const stride = 0.30 + 0.10 * run;
    const phase = (Math.PI * this.dist.at(t)) / stride;
    const sinP = Math.sin(phase), cosP = Math.cos(phase);
    const A = (16 + 16 * run) * move; // leg swing amplitude (deg)
    const f = Math.sign(this.facing.at(t)) || 1;
    const p: Pose = {
      bob: move * (0.010 + 0.014 * run) * Math.abs(sinP),
      lean: move * (1.3 * sinP + (3 + 7 * run) * (v > 0 ? 1 : 0)),
      headRot: -move * 1.2 * sinP,
      headDx: 0, headDy: 0, headSquashX: 1, headSquashY: 1,
      legL: { rot: A * sinP, lift: move * (0.012 + 0.02 * run) * Math.max(0, cosP) },
      legR: { rot: -A * sinP, lift: move * (0.012 + 0.02 * run) * Math.max(0, -cosP) },
      pop: 0, trembleX: 0, trembleY: 0, head: {},
    };
    // idle life: slow breathing, tiny weight shift and head drift (always present, strongest when standing)
    const idle = 1 - move;
    p.pop += idle * 0.004 * Math.sin((2 * Math.PI * t) / 3.3);
    p.lean += idle * 0.5 * Math.sin((2 * Math.PI * t) / 5.1 + 1);
    p.headRot += idle * 0.8 * Math.sin((2 * Math.PI * t) / 4.3);
    p.headDy += idle * 0.0012 * Math.sin((2 * Math.PI * t) / 3.3 + 0.6);

    // looks (persistent state) -> head transform + variant weights
    const lw = Object.fromEntries(LOOKS.map((l) => [l, this.look[l].at(t)])) as Record<Look, number>;
    const screenToNative = (screenSide: 1 | -1): "lookL" | "lookR" => (screenSide * (Math.sign(this.root(t).sx) || 1) < 0 ? "lookL" : "lookR");
    const addVariant = (name: string, w: number): void => { if (w > 0.001) p.head[name] = (p.head[name] ?? 0) + w; };
    const has = (n: string): boolean => this.opts.variants.has(n);
    const lookSide = (screenSide: 1 | -1, w: number): void => {
      if (w <= 0) return;
      const v = screenToNative(screenSide);
      if (has(v)) addVariant(v, w);
      p.headRot += screenSide * 7 * w; // screen space: right = clockwise
      p.headDx += screenSide * 0.008 * w;
      p.headSquashX *= 1 - 0.07 * w;
    };
    lookSide(-1, lw.left);
    lookSide(1, lw.right);
    if (lw.up > 0) { p.headRot += -f * 4 * lw.up; p.headDy -= 0.010 * lw.up; p.headSquashY *= 1 + 0.02 * lw.up; }
    if (lw.down > 0) { p.headRot += f * 3 * lw.down; p.headDy += 0.016 * lw.down; p.headSquashY *= 1 - 0.07 * lw.down; }
    if (lw.camera > 0) { if (has("front")) addVariant("front", lw.camera); p.headSquashX *= 1 + 0.03 * lw.camera; }

    // expressions (persistent with holds)
    const ew = Object.fromEntries(EXPRS.map((x) => [x, this.expr[x].at(t)])) as Record<Expr, number>;
    const map: [Expr, string, string][] = [["smile", "smile", "smile"], ["surprised", "surprised", "surprised"], ["fear", "worried", "surprised"], ["anger", "angry", "worried"]];
    for (const [e, primary, fallback] of map) {
      const w = ew[e];
      if (w <= 0.001) continue;
      const use = has(primary) ? primary : has(fallback) ? fallback : null;
      if (use) addVariant(use, w);
      if (e === "surprised") { p.headRot -= f * 5 * w; p.headDy -= 0.006 * w; p.headSquashY *= 1 + 0.03 * w; }
      if (e === "fear") { p.headRot -= f * 3 * w; p.trembleX += 0.0016 * w * Math.sin(t * 61); p.trembleY += 0.0012 * w * Math.sin(t * 73 + 1); p.lean -= 4 * w; p.pop -= 0.012 * w; }
      if (e === "anger") { p.lean += 5 * w; p.headDy += 0.006 * w; p.trembleX += 0.0008 * w * Math.sin(t * 47); }
      if (e === "smile") { p.headRot += f * 1.5 * w; p.pop += 0.004 * w; }
    }
    // variant weights must not exceed 1: scale if they do
    const total = Object.values(p.head).reduce((a, b) => a + b, 0);
    if (total > 1) for (const k of Object.keys(p.head)) p.head[k] = p.head[k]! / total;

    // transient motions
    for (const e of this.events) {
      const local = t - e.start;
      if (local < 0 || local > e.duration + 0.6) continue;
      const q = e.params;
      switch (e.type) {
        case "nod": {
          const env = envelope(local, e.duration, 0.05, 0.12), n = Math.round(num(q, "count", 2));
          const w = Math.sin((2 * Math.PI * n * local) / e.duration);
          p.headDy += 0.016 * env * Math.max(0, w); p.headSquashY *= 1 - 0.05 * env * Math.max(0, w); p.headRot += f * 4 * env * w; break;
        }
        case "shake-head": {
          const env = envelope(local, e.duration, 0.05, 0.15), n = Math.round(num(q, "count", 3));
          const w = Math.sin((2 * Math.PI * n * local) / e.duration);
          p.headRot += 7 * env * w; p.headDx += 0.01 * env * w; p.headSquashX *= 1 - 0.06 * env * Math.abs(w); break;
        }
        case "lean": {
          const env = envelope(local, e.duration, 0.2, 0.25);
          p.lean += num(q, "angle", 8) * env; p.headRot -= num(q, "angle", 8) * 0.3 * env; break;
        }
        case "hand-gesture": {
          const env = envelope(local, e.duration, 0.1, 0.2), w = Math.sin((2 * Math.PI * 2.5 * local));
          p.lean += (3 * w + 2) * env * f; p.headRot += 2.5 * w * env; p.bob -= 0.004 * Math.abs(w) * env; break;
        }
        case "point": {
          const env = envelope(local, e.duration, 0.12, 0.25);
          p.lean += 7 * env * f; p.headDx += 0.01 * env * f; p.pop += 0.01 * env; break;
        }
        case "surprise": case "react": {
          const k = Math.exp(-local * 6);
          const hop = Math.sin(Math.min(1, local / 0.18) * Math.PI) * (local < 0.18 ? 1 : 0);
          p.pop += num(q, "strength", 0.06) * k; p.bob -= 0.03 * hop; p.lean -= 7 * k * f; p.headRot -= 6 * k * f;
          p.trembleX += 0.003 * k * Math.sin(local * 90); break;
        }
        case "shake": {
          const env = envelope(local, e.duration, 0.02, 0.1), a = num(q, "amount", 0.006);
          p.trembleX += a * env * noise1(local * 9, 1); p.trembleY += a * 0.8 * env * noise1(local * 9, 2); break;
        }
        case "fear": {
          const env = envelope(local, e.duration, 0.1, 0.2);
          p.trembleX += 0.0035 * env * Math.sin(local * 67); p.trembleY += 0.0025 * env * Math.sin(local * 81 + 1); break;
        }
        default: break;
      }
    }
    return p;
  }
}
