import { createCanvas, loadImage, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { CharacterTimeline, type Pose } from "./character";
import { EffectPainter } from "./effects";
import { Track, ease, envelope, noise1, type Easing } from "./ease";
import { audioCuesFor } from "./cues";
import { drawDoor, hexa } from "./props";
import { composeFigure, glowsAt, type FigureLight } from "./figure";
import type { Rig, RigSet } from "./rig";
import { composePuppet, type HeldItem, type Puppet } from "./puppet";
import type { AnimShotSpec, AnimationEvent, AudioCue, CameraState, VisualLayer } from "./types";

export type Drawable = Image | Canvas;

/** Loaded pictures and rigs, addressed by id. */
export class AssetLibrary {
  readonly images = new Map<string, Drawable>();
  readonly rigs = new Map<string, RigSet>();
  /** Cut-out puppets (puppet.ts), by character id: preferred over a rig set when both exist. */
  readonly puppets = new Map<string, Puppet>();
  addPuppet(p: Puppet): void { this.puppets.set(p.id, p); }
  async addImage(id: string, src: string | Buffer, opts: { blur?: number } = {}): Promise<Drawable> {
    const img = await loadImage(src);
    let out: Drawable = img;
    if (opts.blur && opts.blur > 0) {
      const c = createCanvas(img.width, img.height), g = c.getContext("2d");
      g.filter = `blur(${opts.blur}px)`;
      g.drawImage(img, 0, 0);
      out = c;
    }
    this.images.set(id, out);
    return out;
  }
  /** Registers a character: one rig (front view only) or a set with several camera views. */
  addRig(rig: Rig | RigSet): void {
    if ("views" in rig) this.rigs.set(rig.id, rig);
    else this.rigs.set(rig.id, { id: rig.id, views: { [rig.view]: rig } });
  }
}

const num = (p: AnimationEvent["params"], k: string, d: number): number => (typeof p?.[k] === "number" ? (p[k] as number) : d);
const str = (p: AnimationEvent["params"], k: string, d: string): string => (typeof p?.[k] === "string" ? (p[k] as string) : d);

/** Animation of a non-character layer: position, scale, rotation, opacity, door opening, plus flicker/shake/glow modifiers. */
class ObjectTimeline {
  readonly x: Track; readonly y: Track; readonly scale: Track; readonly rot: Track; readonly opacity: Track; readonly open = new Track(0);
  private readonly events: AnimationEvent[];
  constructor(readonly layer: VisualLayer, events: AnimationEvent[]) {
    this.events = events.filter((e) => e.targetId === layer.id).sort((a, b) => a.start - b.start);
    const appears = this.events.some((e) => e.type === "appear");
    this.x = new Track(layer.x); this.y = new Track(layer.y); this.scale = new Track(layer.scale); this.rot = new Track(layer.rotation ?? 0);
    this.opacity = new Track(appears ? 0 : layer.opacity);
    for (const e of this.events) {
      const p = e.params, s = e.start, d = e.duration;
      const eas = str(p, "ease", "inOut") as Easing;
      switch (e.type) {
        case "move": case "drive": {
          const tx = typeof p?.x === "number" ? (p.x as number) : this.x.at(s) + num(p, "dx", 0);
          const ty = typeof p?.y === "number" ? (p.y as number) : this.y.at(s) + num(p, "dy", 0);
          const ee = e.type === "drive" ? "linear" : eas;
          this.x.moveTo(s, d, tx, ee); this.y.moveTo(s, d, ty, ee); break;
        }
        case "scale": this.scale.moveTo(s, d, num(p, "to", 1), eas); break;
        case "rotate": this.rot.moveTo(s, d, num(p, "to", 0), eas); break;
        case "fade": this.opacity.moveTo(s, d, num(p, "to", 0), eas); break;
        case "appear": this.opacity.moveTo(s, Math.min(d, 0.25), layer.opacity, "out"); if (p?.pop !== false) { this.scale.moveTo(s, 0.001, layer.scale * 0.88, "linear"); this.scale.moveTo(s + 0.001, Math.max(0.2, d), layer.scale, "outBack"); } break;
        case "disappear": this.opacity.moveTo(s, d, 0, "in"); break;
        case "open": this.open.moveTo(s, d, 1, "inOut"); break;
        case "close": this.open.moveTo(s, d, 0, "inOut"); break;
        default: break;
      }
    }
  }
  hasGlowEvents(): boolean { return this.events.some((e) => e.type === "glow"); }
  /** Offsets and multipliers from transient events at time t. */
  mods(t: number): { dx: number; dy: number; rot: number; alpha: number; glow: { color: string; radius: number; amount: number } | null } {
    let dx = 0, dy = 0, rot = 0, alpha = 1, glow: { color: string; radius: number; amount: number } | null = null;
    for (const e of this.events) {
      const local = t - e.start;
      if (local < 0 || local > e.duration) continue;
      const p = e.params;
      if (e.type === "shake") {
        const env = envelope(local, e.duration, 0.02, 0.12), a = num(p, "amount", 10);
        dx += a * env * noise1(local * 11, 3); dy += a * 0.8 * env * noise1(local * 11, 4); rot += (a / 14) * env * noise1(local * 9, 5);
      } else if (e.type === "flicker") {
        const n = noise1(t * num(p, "rate", 4), num(p, "seed", 9));
        const depth = num(p, "depth", 0.6);
        alpha *= n > num(p, "threshold", 0.25) ? 1 - depth : n < -0.55 ? 1 - depth * 0.4 : 1;
      } else if (e.type === "glow") {
        glow = { color: str(p, "color", "#9fd0ff"), radius: num(p, "radius", 420), amount: num(p, "amount", 0.8) * envelope(local, e.duration, num(p, "in", 0.15), num(p, "out", 0.3)) };
      }
    }
    return { dx, dy, rot, alpha, glow };
  }
}

interface CharEntry { layer: VisualLayer; set: RigSet; puppet?: Puppet; tl: CharacterTimeline; lights: AnimationEvent[]; held: ObjectTimeline[] }

export interface FrameInfo { camera: CameraState }

/** Evaluates and draws one animated shot. All state is a pure function of time, so frames can be rendered in any order. */
export class AnimEngine {
  readonly W: number; readonly H: number;
  private readonly chars = new Map<string, CharEntry>();
  private readonly objs = new Map<string, ObjectTimeline>();
  private readonly camX: Track; private readonly camY: Track; private readonly camZoom: Track; private readonly camRot: Track;
  private readonly camEvents: AnimationEvent[];
  private readonly fx: EffectPainter;
  private readonly order: VisualLayer[];
  private readonly scratch = new Map<string, Canvas>();

  constructor(readonly spec: AnimShotSpec, private readonly lib: AssetLibrary) {
    this.W = spec.width; this.H = spec.height;
    this.fx = new EffectPainter(this.W, this.H, spec.seed ?? 1);
    for (const l of spec.layers) {
      if (l.type === "character") {
        const id = l.rig ?? l.source;
        const puppet = lib.puppets.get(id);
        if (puppet) {
          const info = { nativeFacing: puppet.nativeFacing, variants: new Set(Object.keys(puppet.faces)) };
          const tl = new CharacterTimeline(l, spec.events, { ...info, views: { "three-quarter": info } }, spec.duration);
          this.chars.set(l.id, { layer: l, set: { id, views: {} }, puppet, tl, lights: spec.events.filter((e) => e.type === "glow" && e.targetId === l.id), held: [] });
          continue;
        }
        const set = lib.rigs.get(id);
        if (!set) throw new Error(`character layer ${l.id}: no rig "${id}" in the asset library`);
        const views = Object.fromEntries(Object.entries(set.views).map(([v, r]) => [v, { nativeFacing: r!.nativeFacing, variants: new Set(Object.keys(r!.variants)) }]));
        const first = Object.values(set.views)[0]!;
        const tl = new CharacterTimeline(l, spec.events, { nativeFacing: first.nativeFacing, variants: new Set(Object.keys(first.variants)), views }, spec.duration);
        this.chars.set(l.id, { layer: l, set, tl, lights: spec.events.filter((e) => e.type === "glow" && e.targetId === l.id), held: [] });
      } else this.objs.set(l.id, new ObjectTimeline(l, spec.events));
    }
    // props held by a character are drawn by the character (in its hand), not as free layers
    for (const l of spec.layers) {
      if (!l.parent) continue;
      const c = this.chars.get(l.parent.layerId), o = this.objs.get(l.id);
      if (c?.puppet && o) c.held.push(o);
    }
    const heldIds = new Set([...this.chars.values()].flatMap((c) => c.held.map((o) => o.layer.id)));
    this.order = [...spec.layers].filter((l) => !heldIds.has(l.id)).sort((a, b) => a.zIndex - b.zIndex);
    this.camX = new Track(spec.camera.x); this.camY = new Track(spec.camera.y); this.camZoom = new Track(spec.camera.zoom); this.camRot = new Track(spec.camera.rotation);
    this.camEvents = spec.events.filter((e) => e.targetId === "camera").sort((a, b) => a.start - b.start);
    this.compileCamera();
  }

  private compileCamera(): void {
    for (const e of this.camEvents) {
      const p = e.params, s = e.start, d = e.duration, mode = str(p, "mode", "pan");
      const eas = str(p, "ease", "inOut") as Easing;
      if (mode === "pan") {
        if (typeof p?.x === "number") this.camX.moveTo(s, d, p.x as number, eas);
        if (typeof p?.y === "number") this.camY.moveTo(s, d, p.y as number, eas);
      } else if (mode === "push" || mode === "zoom") this.camZoom.moveTo(s, d, num(p, "zoom", 1.2), eas);
      else if (mode === "roll") this.camRot.moveTo(s, d, num(p, "deg", 0), eas);
      else if (mode === "follow") {
        const c = this.chars.get(str(p, "target", ""));
        if (!c) throw new Error(`camera follow: unknown character "${str(p, "target", "")}"`);
        const tau = num(p, "tau", 0.35), sx = num(p, "screenX", 0.5), sy = typeof p?.y === "number" ? (p.y as number) : null;
        const z = this.camZoom.at(s);
        let cx = this.camX.at(s);
        const hz = 60;
        for (let i = 0; i <= Math.ceil(d * hz); i++) {
          const t = s + i / hz;
          const goal = c.tl.pathX.at(t) - (sx - 0.5) * (this.W / z) + num(p, "lead", 0) * (Math.sign(c.tl.facing.at(t)) || 1);
          cx += (goal - cx) * (1 - Math.exp(-1 / hz / tau));
          this.camX.set(t, cx);
        }
        if (sy !== null) this.camY.moveTo(s, Math.min(d, 0.6), sy, "inOut");
      }
    }
  }

  camera(t: number): CameraState & { flash: number } {
    let sx = 0, sy = 0, sr = 0, flash = 0;
    for (const e of this.camEvents) {
      const local = t - e.start;
      if (local < 0 || local > e.duration) continue;
      const mode = str(e.params, "mode", "pan");
      if (mode === "shake") {
        const env = Math.exp(-local * num(e.params, "decay", 5)) * Math.min(1, local / 0.015 + 0.2), a = num(e.params, "amount", 18), f = num(e.params, "freq", 22);
        sx += a * env * Math.sin(local * f * 2.1) * 0.9 + a * env * 0.4 * noise1(local * f, 1);
        sy += a * env * Math.sin(local * f * 1.7 + 1) * 0.8 + a * env * 0.4 * noise1(local * f, 2);
        sr += (a / 22) * env * Math.sin(local * f * 1.3);
      } else if (mode === "flash") flash = Math.max(flash, num(e.params, "amount", 0.7) * Math.exp(-local * num(e.params, "decay", 9)));
    }
    return { x: this.camX.at(t) + sx, y: this.camY.at(t) + sy, zoom: this.camZoom.at(t), rotation: this.camRot.at(t) + sr, flash };
  }

  /** Sound cues implied by the animation (see `audioCuesFor`). */
  audioCues(): AudioCue[] { return audioCuesFor(this.spec); }

  private project(cam: CameraState, p: number): { project: (x: number, y: number) => { x: number; y: number }; zl: number } {
    const { W, H } = this;
    const cx = W / 2 + (cam.x - W / 2) * p, cy = H / 2 + (cam.y - H / 2) * p;
    const zl = 1 + (cam.zoom - 1) * Math.min(1.4, Math.max(0.35, p));
    return { zl, project: (x, y) => ({ x: W / 2 + (x - cx) * zl, y: H / 2 + (y - cy) * zl }) };
  }

  private canvas(key: string, w: number, h: number): Canvas {
    let c = this.scratch.get(key);
    if (!c || c.width !== w || c.height !== h) { c = createCanvas(w, h); this.scratch.set(key, c); }
    const g = c.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, w, h);
    return c;
  }

  renderFrame(g: SKRSContext2D, t: number): void {
    const { W, H } = this;
    const cam = this.camera(t);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.fillStyle = this.spec.backdrop ?? "#05070c";
    g.fillRect(0, 0, W, H);
    g.save();
    if (Math.abs(cam.rotation) > 0.01) { g.translate(W / 2, H / 2); g.rotate((cam.rotation * Math.PI) / 180); g.translate(-W / 2, -H / 2); }
    const world = this.project(cam, 1).project;
    const back = this.spec.effects.filter((e) => (e.layer ?? "front") === "back");
    const front = this.spec.effects.filter((e) => (e.layer ?? "front") === "front");
    let backDone = false;
    for (const l of this.order) {
      if (!backDone && (l.type === "character" || l.type === "prop" || l.type === "foreground")) { for (const e of back) this.fx.draw(g, e, t, world); backDone = true; }
      if (l.type === "character") this.drawCharacter(g, this.chars.get(l.id)!, t, cam);
      else this.drawObject(g, this.objs.get(l.id)!, t, cam);
    }
    if (!backDone) for (const e of back) this.fx.draw(g, e, t, world);
    for (const e of front) this.fx.draw(g, e, t, world);
    g.restore();
    if (cam.flash > 0.01) { g.globalAlpha = Math.min(1, cam.flash); g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
  }

  private drawObject(g: SKRSContext2D, o: ObjectTimeline, t: number, cam: CameraState): void {
    const l = o.layer;
    const img = this.lib.images.get(l.source);
    if (!img) throw new Error(`layer ${l.id}: no image "${l.source}" in the asset library`);
    const par = l.parallax ?? (l.type === "background" ? 0.4 : l.type === "midground" ? 0.7 : l.type === "foreground" ? 1.25 : 1);
    const { project, zl } = this.project(cam, par);
    const src = (l.attach ? this.objs.get(l.attach) : undefined) ?? o;
    const m = src.mods(t);
    const x = src.x.at(t) + m.dx, y = src.y.at(t) + m.dy, scale = src.scale.at(t);
    const opacity = o.opacity.at(t) * (l.attach ? 1 : m.alpha);
    if (opacity < 0.003) return;
    const hPx = (l.height ?? (l.type === "background" ? this.H * 1.15 : img.height)) * scale * zl;
    const wPx = hPx * (img.width / img.height);
    const p = project(x, y);
    const centered = l.type === "background" || l.type === "midground" || l.type === "effect";
    g.save();
    g.globalAlpha = Math.min(1, opacity);
    if (l.blend && l.blend !== "normal") g.globalCompositeOperation = l.blend === "lighter" ? "lighter" : l.blend;
    g.translate(p.x, p.y);
    const rot = (src.rot.at(t) + m.rot) * (Math.PI / 180);
    if (rot) g.rotate(rot);
    if (l.flipX) g.scale(-1, 1);
    const ox = -wPx / 2, oy = centered ? -hPx / 2 : -hPx;
    if (l.door) {
      g.restore();
      g.save();
      drawDoor(g, { x: p.x, y: p.y, w: wPx, h: hPx, open: src.open.at(t), hinge: l.door.hinge, glow: l.door.glow, leaf: img, opacity: Math.min(1, opacity), zoom: zl });
      if (l.tint && (l.tintAmount ?? 0) > 0) { g.globalAlpha = l.tintAmount! * 0.5; g.fillStyle = l.tint; g.fillRect(p.x - wPx / 2, p.y - hPx, wPx, hPx); }
      g.restore();
      this.drawGlow(g, m.glow, project, x, y - (l.height ?? img.height) * scale * 0.5, zl);
      return;
    }
    // props standing on the ground get a contact shadow; distant or very near ones are blurred (depth of field)
    if (!centered && l.shadow !== false && l.type === "prop") {
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      const gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, wPx * 0.6);
      gr.addColorStop(0, `rgba(0,0,0,${0.5 * Math.min(1, opacity)})`);
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.translate(p.x, p.y); g.scale(1, 0.2); g.translate(-p.x, -p.y);
      g.fillStyle = gr; g.fillRect(p.x - wPx, p.y - wPx, wPx * 2, wPx * 2);
      g.restore();
    }
    if (l.blur && l.blur > 0) g.filter = `blur(${(l.blur * zl).toFixed(1)}px)`;
    g.drawImage(img, ox, oy, wPx, hPx);
    if (l.tint && (l.tintAmount ?? 0) > 0) {
      g.globalCompositeOperation = "source-atop";
      g.fillStyle = l.tint;
      g.globalAlpha = l.tintAmount!;
      g.fillRect(ox - 4, oy - 4, wPx + 8, hPx + 8);
    }
    g.restore();
    this.drawGlow(g, m.glow, project, x, y - (centered ? 0 : (l.height ?? img.height) * scale * 0.5), zl);
  }

  private drawGlow(g: SKRSContext2D, glow: { color: string; radius: number; amount: number } | null, project: (x: number, y: number) => { x: number; y: number }, wx: number, wy: number, zl: number): void {
    if (!glow || glow.amount <= 0.01) return;
    const gp = project(wx, wy);
    g.save();
    g.globalCompositeOperation = "screen";
    const r = glow.radius * zl;
    const gr = g.createRadialGradient(gp.x, gp.y, 0, gp.x, gp.y, r);
    gr.addColorStop(0, hexa(glow.color, 0.9 * glow.amount));
    gr.addColorStop(0.4, hexa(glow.color, 0.35 * glow.amount));
    gr.addColorStop(1, hexa(glow.color, 0));
    g.fillStyle = gr;
    g.fillRect(gp.x - r, gp.y - r, r * 2, r * 2);
    g.restore();
  }

  private drawCharacter(g: SKRSContext2D, c: CharEntry, t: number, cam: CameraState): void {
    if (c.puppet) { this.drawPuppet(g, c, c.puppet, t, cam); return; }
    const l = c.layer, par = l.parallax ?? 1;
    const { project, zl } = this.project(cam, par);
    const root = c.tl.root(t);
    const opacity = c.tl.alpha(t);
    if (opacity < 0.003) return;
    const weights = c.tl.viewWeights(t);
    const views = (Object.entries(weights) as [keyof RigSet["views"], number][]).filter(([v]) => c.set.views[v]).sort((x, y) => x[1] - y[1]);
    const base = c.tl.pose(t, views[views.length - 1]![0]);
    const stageH = (l.height ?? 900) * root.scale;
    const rp = project(root.x + base.trembleX * stageH, root.y + base.trembleY * stageH);
    const glows = glowsAt(c.lights, t);
    const light: FigureLight = { tint: l.tint, tintAmount: l.tintAmount, rim: l.rim, glows };
    const glitch = c.tl.glitch(t);

    g.save();
    // contact shadow
    if (l.shadow !== false) {
      const ref = c.set.views[views[views.length - 1]![0]]!;
      const s0 = (stageH / ref.h) * zl * (1 + base.pop);
      const sw = ref.w * 0.55 * s0 * (1 - base.bob * 2), sh = sw * 0.16;
      const gr = g.createRadialGradient(rp.x, rp.y, 0, rp.x, rp.y, sw);
      gr.addColorStop(0, `rgba(0,0,0,${0.55 * opacity})`);
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr;
      g.save();
      g.translate(rp.x, rp.y); g.scale(1, sh / sw); g.translate(-rp.x, -rp.y);
      g.fillRect(rp.x - sw, rp.y - sw, sw * 2, sw * 2);
      g.restore();
    }
    if (l.blur && l.blur > 0) g.filter = `blur(${(l.blur * zl).toFixed(1)}px)`;

    // each camera view is posed on its own canvas and cross-faded while the character turns
    for (const [view, w] of views) {
      const rig = c.set.views[view]!;
      const sx0 = root.fv * (rig.nativeFacing === -1 ? -1 : 1);
      const sx = Math.abs(sx0) < 0.05 ? 0.05 * (sx0 < 0 ? -1 : 1) : sx0;
      const sg = Math.sign(sx) || 1;
      const pose = view === views[views.length - 1]![0] ? base : c.tl.pose(t, view);
      const fig = composeFigure((k, cw, ch) => this.canvas(k, cw, ch), `${l.id}-${view}`, rig, pose, sg, light);
      const s = (stageH / rig.h) * zl * (1 + pose.pop);
      const dx = -(fig.margin + rig.w / 2), dy = -(fig.margin + rig.pad + rig.h);
      g.save();
      g.globalAlpha = Math.min(1, opacity) * (views.length > 1 ? (w >= 0.999 ? 1 : w) : 1);
      g.translate(rp.x, rp.y);
      g.scale(sx * s, s);
      if (glitch > 0) {
        // glitch: the figure is drawn in horizontal bands that slip sideways, with a red/blue split
        const bands = 9, bh = fig.canvas.height / bands;
        for (let i = 0; i < bands; i++) {
          const off = (noise1(t * 31 + i * 3.7, 11) > 0.1 ? noise1(t * 17 + i, 5) * 34 * glitch : 0);
          g.drawImage(fig.canvas, 0, i * bh, fig.canvas.width, bh, dx + off, dy + i * bh, fig.canvas.width, bh);
        }
        g.globalCompositeOperation = "screen";
        g.globalAlpha *= 0.35 * glitch;
        g.drawImage(fig.canvas, dx - 5 * glitch, dy);
        g.drawImage(fig.canvas, dx + 5 * glitch, dy);
      } else {
        g.drawImage(fig.canvas, dx, dy);
      }
      g.restore();
    }
    g.restore();
  }

  /** A cut-out puppet: posed part by part, held props in its hands, a light beam from a held flashlight. */
  private drawPuppet(g: SKRSContext2D, c: CharEntry, pup: Puppet, t: number, cam: CameraState): void {
    const l = c.layer, par = l.parallax ?? 1;
    const { project, zl } = this.project(cam, par);
    const root = c.tl.root(t);
    const opacity = c.tl.alpha(t);
    if (opacity < 0.003) return;
    const pose = c.tl.puppetPose(t, pup.nativeFacing);
    const stageH = (l.height ?? 900) * root.scale;
    const rp = project(root.x + pose.trembleX * stageH, root.y + pose.trembleY * stageH);
    const s = (stageH / pup.figH) * zl * (1 + pose.pop);
    // facing: a quick squash-and-flip (never a sliver), hidden by the hair/coat swing of the turn
    const fv = root.fv * (pup.nativeFacing === -1 ? -1 : 1);
    const sx = (Math.sign(fv) || 1) * (0.6 + 0.4 * Math.min(1, Math.abs(fv)));
    const held: HeldItem[] = [];
    for (const o of c.held) {
      const img = this.lib.images.get(o.layer.source);
      if (!img) continue;
      const m = o.mods(t);
      const gr = o.layer.grip ?? { x: 0.15, y: 0.5 };
      held.push({ hand: o.layer.parent?.hand === "far" ? "F" : "N", image: img, grip: { x: gr.x, y: gr.y }, axis: gr.axis ?? 0, size: gr.size ?? 0.16, opacity: o.opacity.at(t) * m.alpha });
    }
    const fig = composePuppet((k, cw, ch) => this.canvas(k, cw, ch), l.id, pup, pose, held);
    const dx = -(fig.margin + pup.w / 2), dy = -(fig.margin + pup.groundY);
    g.save();
    if (l.shadow !== false) {
      const sw = pup.w * 0.42 * s * (1 - pose.bob * 2), sh = sw * 0.16;
      const gr = g.createRadialGradient(rp.x, rp.y, 0, rp.x, rp.y, sw);
      gr.addColorStop(0, `rgba(0,0,0,${0.6 * opacity})`);
      gr.addColorStop(0.55, `rgba(0,0,0,${0.25 * opacity})`);
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr;
      g.save(); g.translate(rp.x, rp.y); g.scale(1, sh / sw); g.translate(-rp.x, -rp.y); g.fillRect(rp.x - sw, rp.y - sw, sw * 2, sw * 2); g.restore();
    }
    // lighting match on the posed figure: scene tint, rim light, glows (phone light on the face)
    const fc = fig.canvas, fg2 = fc.getContext("2d");
    fg2.save();
    fg2.globalCompositeOperation = "source-atop";
    if (l.tint && (l.tintAmount ?? 0) > 0) { fg2.globalAlpha = l.tintAmount!; fg2.fillStyle = l.tint; fg2.fillRect(0, 0, fc.width, fc.height); }
    if (l.rim) {
      fg2.globalAlpha = (l.rim.amount ?? 0.4) * 0.55;
      const rx = (l.rim.side * (sx < 0 ? -1 : 1)) > 0 ? fc.width : 0;
      const gr = fg2.createLinearGradient(rx, 0, fc.width / 2, 0);
      gr.addColorStop(0, l.rim.color); gr.addColorStop(0.35, hexa(l.rim.color, 0)); gr.addColorStop(1, hexa(l.rim.color, 0));
      fg2.fillStyle = gr; fg2.fillRect(0, 0, fc.width, fc.height);
    }
    for (const gl of glowsAt(c.lights, t)) {
      fg2.globalAlpha = Math.min(1, gl.alpha);
      const gy = fig.margin + pup.joints.neck.y, gx = fig.margin + pup.joints.neck.x;
      const gr = fg2.createRadialGradient(gx, gy, 0, gx, gy, pup.figH * 0.5);
      gr.addColorStop(0, hexa(gl.color, 0.55)); gr.addColorStop(1, hexa(gl.color, 0));
      fg2.fillStyle = gr; fg2.fillRect(0, 0, fc.width, fc.height);
    }
    fg2.restore();
    if (l.blur && l.blur > 0) g.filter = `blur(${(l.blur * zl).toFixed(1)}px)`;
    g.globalAlpha = Math.min(1, opacity);
    g.translate(rp.x, rp.y);
    g.scale(sx * s, s);
    g.drawImage(fc, dx, dy);
    g.restore();
    // beams from held lights: from the far end of the item, along the forearm
    for (const o of c.held) {
      const b = o.layer.beam;
      if (!b) continue;
      const hand = fig.hands[o.layer.parent?.hand === "far" ? "F" : "N"];
      if (!hand) continue;
      const m = o.mods(t);
      const hasGlow = o.hasGlowEvents();
      const amount = (b.intensity ?? 1) * o.opacity.at(t) * m.alpha * (hasGlow ? (m.glow?.amount ?? 0) : 1);
      if (amount < 0.02) continue;
      const len = (o.layer.grip?.size ?? 0.16) * pup.figH * (1 - (o.layer.grip?.x ?? 0.15));
      const a = (hand.angle * Math.PI) / 180;
      const tip = { x: hand.x + Math.cos(a) * len, y: hand.y + Math.sin(a) * len };
      const toScreen = (q: { x: number; y: number }): { x: number; y: number } => ({ x: rp.x + sx * s * (q.x + dx), y: rp.y + s * (q.y + dy) });
      const p0 = toScreen(tip), p1 = toScreen({ x: tip.x + Math.cos(a) * 10, y: tip.y + Math.sin(a) * 10 });
      const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x), L = (b.length ?? 1400) * zl, spread = ((b.spread ?? 16) * Math.PI) / 180;
      g.save();
      g.globalCompositeOperation = "screen";
      g.translate(p0.x, p0.y); g.rotate(ang);
      const gr = g.createLinearGradient(0, 0, L, 0);
      gr.addColorStop(0, hexa(b.color, 0.75 * amount)); gr.addColorStop(0.25, hexa(b.color, 0.35 * amount)); gr.addColorStop(1, hexa(b.color, 0));
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(0, -6 * zl); g.lineTo(L, -Math.tan(spread) * L); g.lineTo(L, Math.tan(spread) * L); g.lineTo(0, 6 * zl); g.closePath(); g.fill();
      const hg = g.createRadialGradient(0, 0, 0, 0, 0, 90 * zl);
      hg.addColorStop(0, hexa(b.color, 0.9 * amount)); hg.addColorStop(1, hexa(b.color, 0));
      g.fillStyle = hg; g.fillRect(-90 * zl, -90 * zl, 180 * zl, 180 * zl);
      g.restore();
    }
  }
}

export { ease };
