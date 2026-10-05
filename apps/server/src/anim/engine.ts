import { createCanvas, loadImage, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { CharacterTimeline, type Pose } from "./character";
import { EffectPainter } from "./effects";
import { Track, ease, envelope, noise1, type Easing } from "./ease";
import type { Rig } from "./rig";
import type { AnimShotSpec, AnimationEvent, AudioCue, CameraState, VisualLayer } from "./types";

export type Drawable = Image | Canvas;

/** Loaded pictures and rigs, addressed by id. */
export class AssetLibrary {
  readonly images = new Map<string, Drawable>();
  readonly rigs = new Map<string, Rig>();
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
  addRig(rig: Rig): void { this.rigs.set(rig.id, rig); }
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

interface CharEntry { layer: VisualLayer; rig: Rig; tl: CharacterTimeline; lights: AnimationEvent[] }

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
        const rig = lib.rigs.get(l.rig ?? l.source);
        if (!rig) throw new Error(`character layer ${l.id}: no rig "${l.rig ?? l.source}" in the asset library`);
        const tl = new CharacterTimeline(l, spec.events, { nativeFacing: rig.nativeFacing, variants: new Set(Object.keys(rig.variants)) }, spec.duration);
        this.chars.set(l.id, { layer: l, rig, tl, lights: spec.events.filter((e) => e.type === "glow" && e.targetId === l.id) });
      } else this.objs.set(l.id, new ObjectTimeline(l, spec.events));
    }
    this.order = [...spec.layers].sort((a, b) => a.zIndex - b.zIndex);
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

  /** Sound cues implied by the animation. */
  audioCues(): AudioCue[] {
    const cues: AudioCue[] = [];
    for (const c of this.chars.values()) {
      const contacts = c.tl.footContacts().filter((t) => c.tl.speed(t) > 40);
      for (const t of contacts) cues.push({ kind: "footsteps", at: t, volume: 0.32 });
    }
    for (const e of this.spec.events) {
      if (e.type === "open" || e.type === "close") cues.push({ kind: "door", at: e.start, volume: 0.45 });
      if (typeof e.params?.sfx === "string") cues.push({ kind: e.params.sfx as AudioCue["kind"], at: e.start + num(e.params, "sfxAt", 0), volume: num(e.params, "sfxVolume", 0.6) });
      if (e.type === "camera" && str(e.params, "mode", "") === "shake" && e.params?.impact !== false && num(e.params, "amount", 18) >= 12) cues.push({ kind: "impact", at: e.start, volume: 0.7 });
    }
    return cues.sort((a, b) => a.at - b.at);
  }

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
      const open = src.open.at(t);
      // light behind the door grows as it opens, then the door swings about its hinge
      if (open > 0.01) {
        const gr = g.createLinearGradient(0, oy, 0, oy + hPx);
        gr.addColorStop(0, "rgba(0,0,0,0.9)");
        gr.addColorStop(0.35, l.door.glow);
        gr.addColorStop(1, "rgba(0,0,0,0.85)");
        g.globalAlpha = Math.min(1, opacity) * Math.min(1, open * 3);
        g.fillStyle = gr;
        g.fillRect(ox, oy, wPx, hPx);
        g.globalAlpha = Math.min(1, opacity);
      }
      const sx = Math.max(0.06, Math.cos(open * 1.3));
      const hingeX = l.door.hinge === "left" ? ox : ox + wPx;
      g.translate(hingeX, 0);
      g.scale(sx, 1);
      g.translate(-hingeX, 0);
      g.drawImage(img, ox, oy, wPx, hPx);
      if (open > 0.01) { g.fillStyle = `rgba(0,0,0,${0.5 * open})`; g.fillRect(ox, oy, wPx, hPx); }
    } else {
      g.drawImage(img, ox, oy, wPx, hPx);
    }
    if (l.tint && (l.tintAmount ?? 0) > 0) {
      g.globalCompositeOperation = "source-atop";
      g.fillStyle = l.tint;
      g.globalAlpha = l.tintAmount!;
      g.fillRect(ox - 4, oy - 4, wPx + 8, hPx + 8);
    }
    g.restore();
    if (m.glow && m.glow.amount > 0.01) {
      const gp = project(x, y - (centered ? 0 : (l.height ?? img.height) * scale * 0.5));
      g.save();
      g.globalCompositeOperation = "screen";
      const r = m.glow.radius * zl;
      const gr = g.createRadialGradient(gp.x, gp.y, 0, gp.x, gp.y, r);
      gr.addColorStop(0, hexA(m.glow.color, 0.9 * m.glow.amount));
      gr.addColorStop(0.4, hexA(m.glow.color, 0.35 * m.glow.amount));
      gr.addColorStop(1, hexA(m.glow.color, 0));
      g.fillStyle = gr;
      g.fillRect(gp.x - r, gp.y - r, r * 2, r * 2);
      g.restore();
    }
  }

  private drawCharacter(g: SKRSContext2D, c: CharEntry, t: number, cam: CameraState): void {
    const l = c.layer, rig = c.rig, par = l.parallax ?? 1;
    const { project, zl } = this.project(cam, par);
    const root = c.tl.root(t), pose = c.tl.pose(t);
    const opacity = c.tl.alpha(t);
    if (opacity < 0.003) return;
    const H = rig.h;
    const stageH = (l.height ?? 900) * root.scale;
    const s = (stageH / H) * zl * (1 + pose.pop);
    const sg = Math.sign(root.sx) || 1;
    const rp = project(root.x + pose.trembleX * stageH, root.y + pose.trembleY * stageH);

    // contact shadow
    g.save();
    if (l.shadow !== false) {
      const sw = rig.w * 0.55 * s * (1 - pose.bob * 2), sh = sw * 0.16;
      const gr = g.createRadialGradient(rp.x, rp.y, 0, rp.x, rp.y, sw);
      gr.addColorStop(0, `rgba(0,0,0,${0.55 * opacity})`);
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.translate(0, 0);
      g.fillStyle = gr;
      g.save();
      g.translate(rp.x, rp.y); g.scale(1, sh / sw); g.translate(-rp.x, -rp.y);
      g.fillRect(rp.x - sw, rp.y - sw, sw * 2, sw * 2);
      g.restore();
    }

    // compose the puppet in native pixels: legs on one scratch canvas, torso + head on another (the rim light must not
    // catch the straight cut edges of the leg slices)
    const m = Math.round(H * 0.3);
    const cw = rig.w + 2 * m, ch = rig.h + rig.pad + 2 * m;
    const lc = this.canvas(`legs-${l.id}`, cw, ch);
    const lf = lc.getContext("2d");
    const uc = this.canvas(`upper-${l.id}`, cw, ch);
    const f = uc.getContext("2d");
    const a = rig.analysis;
    const pivotY = a.hipY;
    const legs: [Pose["legL"], Canvas, number][] = [[pose.legR, rig.legR, a.hipRx], [pose.legL, rig.legL, a.hipLx]];
    for (const [leg, canvas, px] of legs) {
      lf.save();
      lf.translate(m + px, m + pivotY + pose.bob * H - leg.lift * H);
      lf.rotate(leg.rot * sg * (Math.PI / 180) * -1);
      lf.translate(-px, -pivotY);
      lf.drawImage(canvas, 0, 0);
      lf.restore();
    }
    const hipCx = (a.hipLx + a.hipRx) / 2;
    f.save();
    f.translate(m + hipCx, m + pivotY + pose.bob * H);
    f.rotate(pose.lean * (rig.nativeFacing === -1 ? -1 : 1) * (Math.PI / 180));
    f.translate(-hipCx, -pivotY);
    f.drawImage(rig.torso, 0, 0);
    // head about the neck
    f.save();
    f.translate(a.neckCx + pose.headDx * H * sg, a.neckY + pose.headDy * H);
    f.rotate(pose.headRot * sg * (Math.PI / 180));
    f.scale(pose.headSquashX, pose.headSquashY);
    f.translate(-a.neckCx, -a.neckY);
    // cross-fade the head: the neutral head fades OUT as variants fade in, so two hairlines never show at once
    const entries = Object.entries(pose.head).filter(([n, w]) => rig.variants[n] && w > 0.002);
    const total = Math.min(1, entries.reduce((a, [, w]) => a + w, 0));
    f.globalAlpha = 1 - total;
    if (total < 0.999) f.drawImage(rig.head, 0, 0);
    let cum = 1 - total;
    for (const [name, w] of entries) {
      cum += w;
      f.globalAlpha = Math.min(1, w / cum);
      f.drawImage(rig.variants[name]!, 0, 0);
    }
    f.globalAlpha = 1;
    f.restore();
    f.restore();

    // lighting match: ambient tint on both parts; event-driven glow (a phone lighting the face) on the upper body only
    for (const part of [lf, f]) {
      part.globalCompositeOperation = "source-atop";
      if (l.tint && (l.tintAmount ?? 0) > 0) { part.globalAlpha = l.tintAmount!; part.fillStyle = l.tint; part.fillRect(0, 0, cw, ch); part.globalAlpha = 1; }
      part.globalCompositeOperation = "source-over";
    }
    for (const e of c.lights) {
      const local = t - e.start;
      if (local < 0 || local > e.duration) continue;
      const amt = num(e.params, "amount", 0.5) * envelope(local, e.duration, num(e.params, "in", 0.15), num(e.params, "out", 0.3));
      f.globalCompositeOperation = "source-atop";
      f.globalAlpha = Math.min(0.12, amt * 0.14);
      f.fillStyle = str(e.params, "color", "#8fc4ff");
      f.fillRect(0, 0, cw, ch);
      f.globalAlpha = 1;
      f.globalCompositeOperation = "source-over";
    }
    if (l.rim) {
      const rc = this.canvas(`rim-${l.id}`, cw, ch), rg = rc.getContext("2d");
      rg.drawImage(uc, 0, 0);
      rg.globalCompositeOperation = "source-in";
      rg.fillStyle = l.rim.color;
      rg.fillRect(0, 0, cw, ch);
      rg.globalCompositeOperation = "destination-out";
      rg.drawImage(uc, -l.rim.side * sg * 3, 0);
      f.globalCompositeOperation = "source-atop";
      f.globalAlpha = l.rim.amount ?? 0.5;
      f.drawImage(rc, 0, 0);
      f.globalAlpha = 1;
      f.globalCompositeOperation = "source-over";
    }
    lf.drawImage(uc, 0, 0); // upper body over the legs
    const cv = lc;

    // place on stage: feet-centre at the projected root; sx flips (and squashes during turns)
    g.globalAlpha = Math.min(1, opacity);
    g.translate(rp.x, rp.y);
    g.scale(root.sx * s, s);
    g.drawImage(cv, -(m + rig.w / 2), -(m + rig.pad + rig.h));
    g.restore();
  }
}

function hexA(hex: string, a: number): string {
  const mm = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!mm) return hex;
  const v = parseInt(mm[1]!, 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}
export { ease };
