import { Track, ease, envelope, noise1 } from "./ease";
import type { AnimationEvent, ViewName, VisualLayer } from "./types";
import { restPose, type PuppetPose } from "./puppet";

/**
 * Character animation by procedural pose: body-part transforms (bob, sway, leg swing, head turn/nod/shake, lean, pop,
 * tremble) driven by timed events. Walking is DERIVED from the distance the character travels (leg phase = distance /
 * stride), so feet never skate and any horizontal movement walks or runs; a stop stops the legs.
 *
 * Units: offsets are fractions of the character's on-screen height H; angles in degrees; times in seconds.
 */
/** Thigh rotation (deg, + = forward), knee flexion (deg, shin swings back) and foot lift (fraction of H). */
export interface LegPose { rot: number; knee: number; lift: number }
export interface ArmPose { rot: number }
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
  armL: ArmPose;
  armR: ArmPose;
  pop: number; // extra uniform scale
  trembleX: number;
  trembleY: number;
  /** Head variant weights (sum <= 1; the rest is the neutral head). Keys: front, lookL, lookR, surprised, smile, worried, angry. */
  head: Record<string, number>;
}
export interface RootState { x: number; y: number; scale: number; /** continuous facing value: -1 left .. +1 right, passing through 0 during a turn */ fv: number; /** signed horizontal scale: facing * native flip, passes through ~0 during a turn */ sx: number; facing: number }

export const HEAD_VARIANTS = ["front", "lookL", "lookR", "surprised", "smile", "worried", "angry"] as const;
const LOOKS = ["center", "left", "right", "up", "down", "camera"] as const;
const EXPRS = ["neutral", "smile", "surprised", "fear", "anger"] as const;
type Look = (typeof LOOKS)[number];
type Expr = (typeof EXPRS)[number];

const num = (p: AnimationEvent["params"], k: string, d: number): number => (typeof p?.[k] === "number" ? (p[k] as number) : d);
const str = (p: AnimationEvent["params"], k: string, d: string): string => (typeof p?.[k] === "string" ? (p[k] as string) : d);

export interface ViewInfo {
  /** Which way the source art of this view faces on screen: -1 = left, +1 = right. */
  nativeFacing: -1 | 1;
  /** Does the view have separate head variants (otherwise looks/expressions fall back to head transforms)? */
  variants: ReadonlySet<string>;
}
export interface CharacterOptions {
  /** Legacy single-view form (kept for simple rigs and tests). */
  nativeFacing: -1 | 1;
  variants: ReadonlySet<string>;
  /** The views the character has art for. The first of `front`, `three-quarter`, `side`, `back` that exists is the default. */
  views?: Partial<Record<ViewName, ViewInfo>>;
}

const VIEW_ORDER: ViewName[] = ["front", "three-quarter", "side", "back"];
/** How a gait looks from each side: from the front the legs mostly lift and the body bobs; from the side they swing wide. */
const GAIT: Record<ViewName, { swing: number; knee: number; bob: number; arm: number }> = {
  front: { swing: 0.32, knee: 0.7, bob: 1.25, arm: 6 },
  "three-quarter": { swing: 0.72, knee: 0.95, bob: 1.1, arm: 11 },
  side: { swing: 1.12, knee: 1.15, bob: 1, arm: 0 },
  back: { swing: 0.32, knee: 0.7, bob: 1.25, arm: 6 },
};

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
  private readonly viewT = {} as Record<ViewName, Track>;
  readonly availableViews: ViewName[];
  private readonly look = {} as Record<Look, Track>;
  private readonly expr = {} as Record<Expr, Track>;
  private readonly events: AnimationEvent[];
  /** Persistent arm poses (holding / aiming an object) in degrees, and how much the arm still swings when walking. */
  private readonly arm = { N: { sh: new Track(0), el: new Track(0), swing: new Track(1) }, F: { sh: new Track(0), el: new Track(0), swing: new Track(1) } };
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
    const info = opts.views ?? { front: { nativeFacing: opts.nativeFacing, variants: opts.variants } };
    this.availableViews = VIEW_ORDER.filter((v) => info[v]);
    const first = layer.view && info[layer.view] ? layer.view : this.availableViews[0] ?? "front";
    for (const v of VIEW_ORDER) this.viewT[v] = new Track(v === first ? 1 : 0);
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
  private setArm(p: AnimationEvent["params"], t: number, ramp: number, sh: number, el: number, swing: number): void {
    const a = this.arm[str(p, "hand", "near") === "far" ? "F" : "N"];
    a.sh.moveTo(t, ramp, sh, "inOut"); a.el.moveTo(t, ramp, el, "inOut"); a.swing.moveTo(t, ramp, swing, "inOut");
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
        case "view": {
          const to = str(p, "to", "front") as ViewName;
          const use = this.availableViews.includes(to) ? to : this.nearestView(to);
          for (const v of VIEW_ORDER) this.viewT[v].moveTo(s, Math.max(0.05, d), v === use ? 1 : 0, "inOut");
          break;
        }
        case "hold": case "lower-object": this.setArm(p, s, Math.min(0.35, Math.max(0.12, d)), 18, 58, 0.3); break;
        case "raise-object": this.setArm(p, s, Math.max(0.2, Math.min(0.5, d)), 82, 6, 0.03); break;
        case "hold-phone": this.setArm(p, s, Math.max(0.2, Math.min(0.45, d)), 18, 122, 0.05); this.setLook(s, 0.25, "down"); break;
        case "release": this.setArm(p, s, Math.max(0.15, d), 0, 0, 1); break;
        case "listen": this.setLook(s, 0.2, str(p, "to", "right") === "left" ? "left" : "right"); this.setLook(s + Math.max(0.6, d), 0.3, "center"); break;
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

  /** The available view closest to a requested one (a missing 3/4 view falls back to the front, a missing back to the front...). */
  private nearestView(want: ViewName): ViewName {
    const near: Record<ViewName, ViewName[]> = { front: ["three-quarter", "side", "back"], "three-quarter": ["front", "side", "back"], side: ["three-quarter", "front", "back"], back: ["three-quarter", "front", "side"] };
    return this.availableViews.includes(want) ? want : near[want].find((v) => this.availableViews.includes(v)) ?? "front";
  }

  /** Weights of the views at time t (sum 1, only views that exist). */
  viewWeights(t: number): Partial<Record<ViewName, number>> {
    const out: Partial<Record<ViewName, number>> = {};
    let total = 0;
    for (const v of this.availableViews) { const w = Math.max(0, this.viewT[v].at(t)); if (w > 0.001) { out[v] = w; total += w; } }
    if (total <= 0) return { [this.availableViews[0] ?? "front"]: 1 };
    for (const v of Object.keys(out) as ViewName[]) out[v] = out[v]! / total;
    return out;
  }

  /** Strength (0..1) of a glitch right now: flicker events with `glitch: true` break the figure into slipping bands. */
  glitch(t: number): number {
    for (const e of this.events) if (e.type === "flicker" && e.params?.glitch === true && t >= e.start && t <= e.start + e.duration) return noise1(t * 8, 3) > -0.1 ? num(e.params, "strength", 0.8) : 0;
    return 0;
  }

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
    return { x: this.pathX.at(t), y: this.pathY.at(t), scale: this.scaleT.at(t), fv: f, sx: Math.abs(sx) < 0.05 ? 0.05 * (sx < 0 ? -1 : 1) : sx, facing: Math.sign(f) || 1 };
  }

  pose(t: number, view: ViewName = this.availableViews[0] ?? "front"): Pose {
    const gait = GAIT[view];
    const viewVariants = (this.opts.views?.[view]?.variants ?? this.opts.variants) as ReadonlySet<string>;
    const run = this.runBlend.at(t);
    const v = this.speedN(t);
    const move = ease("inOut", Math.min(1, v / (0.19 + 0.10 * run))); // 0 = standing, 1 = full gait
    const stride = 0.30 + 0.10 * run;
    const phase = (Math.PI * this.dist.at(t)) / stride;
    const sinP = Math.sin(phase), cosP = Math.cos(phase);
    const A = (16 + 16 * run) * move * gait.swing; // thigh swing amplitude (deg)
    const K = (24 + 14 * run) * move * gait.knee; // knee flexion at mid-swing (deg)
    const armA = (gait.arm * (1 + 0.9 * run)) * move;
    const f = Math.sign(this.facing.at(t)) || 1;
    const p: Pose = {
      bob: move * (0.010 + 0.014 * run) * Math.abs(sinP) * gait.bob,
      lean: move * (1.3 * sinP + (3 + 7 * run) * (v > 0 ? 1 : 0)),
      headRot: -move * 1.2 * sinP,
      headDx: 0, headDy: 0, headSquashX: 1, headSquashY: 1,
      // the leg that is swinging forward (cos > 0 for the left one) bends its knee; the planted leg stays straight
      legL: { rot: A * sinP, knee: K * Math.pow(Math.max(0, cosP), 1.1), lift: move * 0.008 * Math.max(0, cosP) * (view === "front" || view === "back" ? 1.8 : 1) },
      legR: { rot: -A * sinP, knee: K * Math.pow(Math.max(0, -cosP), 1.1), lift: move * 0.008 * Math.max(0, -cosP) * (view === "front" || view === "back" ? 1.8 : 1) },
      armL: { rot: -armA * sinP },
      armR: { rot: armA * sinP },
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
    const has = (n: string): boolean => viewVariants.has(n);
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
          p.lean += (3 * w + 2) * env * f; p.headRot += 2.5 * w * env; p.bob -= 0.004 * Math.abs(w) * env;
          p.armR.rot += (38 + 14 * w) * env; break;
        }
        case "point": {
          const env = envelope(local, e.duration, 0.12, 0.25);
          p.lean += 7 * env * f; p.headDx += 0.01 * env * f; p.pop += 0.01 * env;
          p.armR.rot += 78 * env; break;
        }
        case "surprise": case "react": {
          const k = Math.exp(-local * 6);
          const hop = Math.sin(Math.min(1, local / 0.18) * Math.PI) * (local < 0.18 ? 1 : 0);
          p.pop += num(q, "strength", 0.06) * k; p.bob -= 0.03 * hop; p.lean -= 7 * k * f; p.headRot -= 6 * k * f;
          p.armL.rot += 20 * k; p.armR.rot += 20 * k;
          p.trembleX += 0.003 * k * Math.sin(local * 90); break;
        }
        case "shake": {
          const env = envelope(local, e.duration, 0.02, 0.1), a = num(q, "amount", 0.006);
          p.trembleX += a * env * noise1(local * 9, 1); p.trembleY += a * 0.8 * env * noise1(local * 9, 2); break;
        }
        case "fear": {
          const env = envelope(local, e.duration, 0.1, 0.2);
          p.armL.rot += (8 + 3 * Math.sin(local * 40)) * env; p.armR.rot += (8 + 3 * Math.sin(local * 37)) * env;
          p.trembleX += 0.0035 * env * Math.sin(local * 67); p.trembleY += 0.0025 * env * Math.sin(local * 81 + 1); break;
        }
        default: break;
      }
    }
    return p;
  }

  /** Facing as a sign (screen: -1 left, +1 right). */
  facingSign(t: number): number { return Math.sign(this.facing.at(t)) || 1; }

  /**
   * Pose of a cut-out puppet (puppet.ts) at time t. Angles are in the puppet's native frame: + = forward. The walk/run cycle is
   * derived from the distance travelled; arms counter-swing the legs; the torso leans and rocks; the coat and the hair follow the
   * body 80 / 120 ms late. Gestures (point, raise, reach, push, pull, wave, react) move the shoulders and elbows; held objects
   * keep the arm in a holding pose.
   */
  puppetPose(t: number, nativeFacing: -1 | 1 = -1): PuppetPose {
    const p = restPose();
    const gaitAt = (tt: number): { move: number; run: number; phase: number } => {
      const run = this.runBlend.at(tt), v = this.speedN(tt);
      return { run, move: ease("inOut", Math.min(1, v / (0.19 + 0.1 * run))), phase: (Math.PI * this.dist.at(tt)) / (0.3 + 0.1 * run) };
    };
    const { move, run, phase } = gaitAt(t);
    const lagC = gaitAt(t - 0.08), lagH = gaitAt(t - 0.12);
    const sn = Math.sin(phase), cs = Math.cos(phase);
    const A = (21 + 25 * run) * move;
    const K = (26 + 62 * run) * move;
    p.hipN = A * sn; p.hipF = -A * sn;
    p.kneeN = K * Math.pow(Math.max(0, cs), 1.2) + 4 * move; p.kneeF = K * Math.pow(Math.max(0, -cs), 1.2) + 4 * move;
    p.liftN = move * (0.008 + 0.012 * run) * Math.max(0, cs); p.liftF = move * (0.008 + 0.012 * run) * Math.max(0, -cs);
    const B = (17 + 33 * run) * move;
    const swN = this.arm.N.swing.at(t), swF = this.arm.F.swing.at(t);
    p.shoulderN = -B * sn * swN + this.arm.N.sh.at(t); p.shoulderF = B * sn * swF + this.arm.F.sh.at(t);
    const elBase = (10 + 62 * run) * move;
    p.elbowN = this.arm.N.el.at(t) + swN * (elBase + 12 * move * Math.max(0, -sn)); p.elbowF = this.arm.F.el.at(t) + swF * (elBase + 12 * move * Math.max(0, sn));
    p.bob = move * (0.009 + 0.018 * run) * Math.abs(sn);
    p.lean = move * (2.5 + 13 * run) + 1.3 * move * Math.sin(2 * phase);
    p.coat = -move * (2 + 5 * run) * 0.6 + 2.4 * lagC.move * Math.sin(lagC.phase) - 1.2 * lagC.move * Math.sin(2 * lagC.phase - 0.6);
    p.hair = -move * (1.5 + 3 * run) + 1.6 * lagH.move * Math.sin(2 * lagH.phase - 1);
    p.headRot = -0.8 * move * Math.sin(2 * phase);

    // idle life: breathing, weight shift, small head drift; arms breathe a little
    const idle = 1 - move;
    p.pop += idle * 0.004 * Math.sin((2 * Math.PI * t) / 3.3);
    p.lean += idle * 0.6 * Math.sin((2 * Math.PI * t) / 5.1 + 1);
    p.coat += idle * 0.5 * Math.sin((2 * Math.PI * t) / 5.1 + 0.4);
    p.headRot += idle * 1.2 * Math.sin((2 * Math.PI * t) / 4.3);
    p.hair += idle * 0.8 * Math.sin((2 * Math.PI * t) / 4.3 - 0.9);
    p.shoulderN += idle * 1.5 * Math.sin((2 * Math.PI * t) / 3.3); p.shoulderF -= idle * 1.5 * Math.sin((2 * Math.PI * t) / 3.3 + 0.3);

    // looks: the head turns and the face slides over it (no picture swap)
    const f = this.facingSign(t);
    const toNative = (screen: number): number => screen * (f === nativeFacing ? 1 : -1) * (nativeFacing === -1 ? -1 : 1) * -1;
    const lw = Object.fromEntries(LOOKS.map((l) => [l, this.look[l].at(t)])) as Record<Look, number>;
    p.look += toNative(-1) * lw.left + toNative(1) * lw.right;
    p.headRot += 6 * (toNative(-1) * lw.left + toNative(1) * lw.right) * -1;
    p.headDx += 0.004 * (toNative(-1) * lw.left + toNative(1) * lw.right);
    p.headRot -= 7 * lw.up; p.headDy -= 0.006 * lw.up; p.lookUp -= lw.up;
    p.headRot += 9 * lw.down; p.headDy += 0.012 * lw.down; p.lookUp += lw.down;
    p.look *= 1 - lw.camera;

    // expressions: only the face changes
    const ew = Object.fromEntries(EXPRS.map((x) => [x, this.expr[x].at(t)])) as Record<Expr, number>;
    if (ew.smile > 0.002) p.face.smile = ew.smile;
    if (ew.surprised > 0.002) { p.face.surprised = ew.surprised; p.headRot -= 4 * ew.surprised; }
    if (ew.fear > 0.002) { p.face.worried = ew.fear; p.lean -= 3 * ew.fear; p.trembleX += 0.0012 * ew.fear * Math.sin(t * 61); }
    if (ew.anger > 0.002) { p.face.angry = ew.anger; p.lean += 4 * ew.anger; }

    // transient gestures
    const blendArm = (limb: "N" | "F", sh: number, el: number, w: number): void => {
      if (limb === "N") { p.shoulderN += (sh - p.shoulderN) * w; p.elbowN += (el - p.elbowN) * w; }
      else { p.shoulderF += (sh - p.shoulderF) * w; p.elbowF += (el - p.elbowF) * w; }
    };
    for (const e of this.events) {
      const local = t - e.start;
      if (local < 0 || local > e.duration + 0.6) continue;
      const q = e.params;
      const hand: "N" | "F" = str(q, "hand", "near") === "far" ? "F" : "N";
      const env = envelope(local, e.duration, Math.min(0.25, e.duration * 0.3), 0.3);
      switch (e.type) {
        case "point": blendArm(hand, 86, 4, env); p.lean += 3 * env; p.headDx += 0.004 * env; break;
        case "raise-hand": blendArm(hand, hand === "N" ? 158 : -150, hand === "N" ? 18 : -14, env); p.lean -= 2 * env; p.headRot -= 3 * env; break;
        case "wave": blendArm(hand, 150, 30 + 28 * Math.sin(2 * Math.PI * 2.6 * local), env); break;
        case "reach": blendArm(hand, 68, 12, env); p.lean += 6 * env; break;
        case "push": blendArm("N", 78, 14, env); blendArm("F", 74, 18, env); p.lean += 8 * env; break;
        case "pull": blendArm("N", 55, 80, env); blendArm("F", 50, 85, env); p.lean -= 6 * env; break;
        case "hand-gesture": blendArm(hand, 34 + 10 * Math.sin(2 * Math.PI * 2.2 * local), 72, env); p.headRot += 2 * Math.sin(2 * Math.PI * 2.2 * local) * env; break;
        case "surprise": case "react": {
          const k = Math.exp(-local * 3.5) * Math.min(1, local / 0.07);
          blendArm("N", 48, 96, k); blendArm("F", 40, 100, k);
          p.pop += num(q, "strength", 0.05) * Math.exp(-local * 6); p.lean -= 7 * k; p.headRot -= 5 * k; p.hair -= 5 * k; p.coat -= 3 * k;
          break;
        }
        case "fear": blendArm("N", 26, 112, env); blendArm("F", 22, 116, env); p.trembleX += 0.003 * env * Math.sin(local * 67); break;
        case "nod": { const w = Math.sin((2 * Math.PI * Math.round(num(q, "count", 2)) * local) / Math.max(0.1, e.duration)); p.headRot += 7 * envelope(local, e.duration, 0.05, 0.12) * Math.max(0, w); p.hair += 3 * Math.max(0, w); break; }
        case "shake-head": { const w = Math.sin((2 * Math.PI * Math.round(num(q, "count", 3)) * local) / Math.max(0.1, e.duration)); const en = envelope(local, e.duration, 0.05, 0.15); p.look += 0.8 * w * en; p.headDx += 0.004 * w * en; break; }
        case "lean": p.lean += num(q, "angle", 8) * envelope(local, e.duration, 0.2, 0.25); break;
        case "shake": { const a = num(q, "amount", 0.006); p.trembleX += a * env * noise1(local * 9, 1); p.trembleY += a * 0.8 * env * noise1(local * 9, 2); break; }
        case "turn": { const k = Math.sin(Math.min(1, local / Math.max(0.15, e.duration)) * Math.PI); p.hair -= 6 * k; p.coat -= 5 * k; break; }
        default: break;
      }
    }
    return p;
  }
}
