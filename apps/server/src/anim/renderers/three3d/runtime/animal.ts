import * as THREE from "three";
import type { AnimalSpec3D } from "../spec";

/**
 * A rigged animal driven by the timeline. Its whole state is a PURE FUNCTION of the shot time t, so any frame (and any
 * chunk) is evaluated independently:
 *  - position: the spec's path (time-stamped points), eased between points (a stop is a repeated point);
 *  - heading: toward the direction of travel, blended over a short look-ahead (no snap at corners); at rest, the
 *    spec's `face` (a point) or the last travel direction;
 *  - clips: the walk / run cycle phase is the DISTANCE travelled divided by the clip's own stride (measured from the
 *    planted paws), so the paws stay planted at any speed; idle and the spec's actions (eat, rest, react) cross-fade by
 *    smooth weights computed from t.
 */
export interface GLTFLike { scene: THREE.Object3D; animations: THREE.AnimationClip[] }
const smooth = (x: number): number => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };

export class Animal3D {
  readonly root = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly act = new Map<string, THREE.AnimationAction>();
  /** Metres travelled per clip cycle (walk / run), from the planted paws. */
  readonly stride: Record<string, number> = {};
  private readonly cum: number[] = [];
  readonly height: number;

  constructor(readonly spec: AnimalSpec3D, gltf: GLTFLike, readonly clips: Record<string, string>, targetHeight: number) {
    const model = gltf.scene;
    model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; } });
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    model.scale.multiplyScalar(targetHeight / Math.max(1e-6, box.max.y - box.min.y));
    model.updateMatrixWorld(true);
    this.height = targetHeight;
    this.root.add(model); this.root.name = `animal:${spec.id}`;
    // a soft contact shadow under the body
    const sh = new THREE.Mesh(new THREE.CircleGeometry(1, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }));
    const b2 = new THREE.Box3().setFromObject(model); sh.scale.set((b2.max.x - b2.min.x) * 0.55, (b2.max.z - b2.min.z) * 0.55, 1); sh.rotation.x = -Math.PI / 2; sh.position.y = 0.01; this.root.add(sh);
    this.mixer = new THREE.AnimationMixer(model);
    for (const [role, name] of Object.entries(clips)) {
      const clip = gltf.animations.find((a) => a.name === name);
      if (!clip) continue;
      const a = this.mixer.clipAction(clip); a.play(); a.setEffectiveWeight(0); this.act.set(role, a);
      if (role === "walk" || role === "run") this.stride[role] = this.measureStride(model, clip);
    }
    // cumulative distance along the path (for the cycle phase)
    let d = 0; this.cum.push(0);
    for (let i = 1; i < spec.path.length; i++) { d += Math.hypot(spec.path[i]!.x - spec.path[i - 1]!.x, spec.path[i]!.z - spec.path[i - 1]!.z); this.cum.push(d); }
  }

  /** Stride per cycle: how far the lowest bone (a paw) slides backward under the body over one cycle while planted. */
  private measureStride(model: THREE.Object3D, clip: THREE.AnimationClip): number {
    const m = new THREE.AnimationMixer(model), a = m.clipAction(clip); a.play();
    const bones: THREE.Object3D[] = []; model.traverse((o) => { if ((o as THREE.Bone).isBone && o.children.every((c) => !(c as THREE.Bone).isBone)) bones.push(o); });
    const N = 48, track = bones.map(() => [] as THREE.Vector3[]);
    for (let i = 0; i <= N; i++) { m.setTime((i / N) * clip.duration); model.updateMatrixWorld(true); bones.forEach((b, k) => track[k]!.push(b.getWorldPosition(new THREE.Vector3()))); }
    m.stopAllAction(); m.uncacheRoot(model);
    // paws: the end bones that reach lowest; their backward travel while within 3 cm of their lowest point
    const low = track.map((tr) => Math.min(...tr.map((p) => p.y))), floor = Math.min(...low);
    let best = 0;
    track.forEach((tr, k) => {
      if (low[k]! > floor + 0.05 * this.height) return;
      let back = 0;
      for (let i = 1; i <= N; i++) if (tr[i]!.y - low[k]! < 0.03 * this.height && tr[i - 1]!.y - low[k]! < 0.03 * this.height) back += Math.max(0, tr[i - 1]!.z - tr[i]!.z);
      best = Math.max(best, back);
    });
    return best > 1e-3 ? best : 0.6 * this.height;
  }

  /** Position (eased between path points), speed and travel direction at time t. */
  private at(t: number): { x: number; z: number; v: number; dist: number; dir: number | null } {
    const P = this.spec.path;
    if (t <= P[0]!.at) return { x: P[0]!.x, z: P[0]!.z, v: 0, dist: 0, dir: null };
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1]!, b = P[i]!;
      if (t > b.at) continue;
      const len = Math.hypot(b.x - a.x, b.z - a.z), T = Math.max(1e-3, b.at - a.at), u = (t - a.at) / T;
      // ease in and out over a segment: speed 0 at both ends (smoothstep), so starts and stops never jolt
      const e = u * u * (3 - 2 * u), de = (6 * u * (1 - u)) / T;
      return { x: a.x + (b.x - a.x) * e, z: a.z + (b.z - a.z) * e, v: len * de, dist: this.cum[i - 1]! + len * e, dir: len > 1e-3 ? Math.atan2(b.x - a.x, b.z - a.z) : null };
    }
    const L = P[P.length - 1]!; return { x: L.x, z: L.z, v: 0, dist: this.cum[this.cum.length - 1]!, dir: null };
  }

  /** The heading at t: the direction of the current/last moving segment, turned smoothly over 0.4 s at corners. */
  private heading(t: number): number {
    const dirAt = (tt: number): number | null => {
      const P = this.spec.path;
      let last: number | null = null;
      for (let i = 1; i < P.length; i++) { const a = P[i - 1]!, b = P[i]!; const len = Math.hypot(b.x - a.x, b.z - a.z); if (a.at > tt) break; if (len > 1e-3) last = Math.atan2(b.x - a.x, b.z - a.z); }
      return last;
    };
    const face = this.spec.face?.filter((f) => f.at <= t).pop();
    const base = this.spec.start?.heading ?? 0;
    const d0 = dirAt(t) ?? base;
    const want = face && (!this.moving(t)) ? Math.atan2(face.x - this.at(t).x, face.z - this.at(t).z) : d0;
    // a blend from the heading TURN seconds ago: corners and "turn to look" take most of a second (an animal turning on
    // the spot at 0.4 s spun ~9 degrees a frame)
    const TURN = 0.9;
    const prevFace = this.spec.face?.filter((f) => f.at <= t - TURN).pop();
    const before = prevFace && !this.moving(t - TURN) ? Math.atan2(prevFace.x - this.at(t - TURN).x, prevFace.z - this.at(t - TURN).z) : dirAt(t - TURN) ?? base;
    const since = Math.min(TURN, Math.max(0, t - this.changeAt(t)));
    const k = smooth(since / TURN), d = Math.atan2(Math.sin(want - before), Math.cos(want - before));
    return before + d * k;
  }
  private moving(t: number): boolean { return this.at(t).v > 0.02; }
  /** When the wanted heading last changed (a segment start or a face event). */
  private changeAt(t: number): number {
    let c = -1e9;
    for (const p of this.spec.path) if (p.at <= t) c = Math.max(c, p.at);
    for (const f of this.spec.face ?? []) if (f.at <= t) c = Math.max(c, f.at);
    return c;
  }

  update(t: number): void {
    const s = this.at(t);
    this.root.position.set(s.x, 0, s.z);
    this.root.rotation.y = this.heading(t);
    // locomotion: walk below ~1.4 m/s, gallop above; the cycle phase comes from distance (paws planted)
    const gait = this.act.has("run") && s.v > 1.6 ? "run" : "walk";
    const move = smooth((s.v - 0.05) / 0.35);
    // actions (eat, rest, react): weight ramps in and out over 0.35 s inside their window
    let actionW = 0, action: string | null = null, actionT = 0;
    for (const a of this.spec.actions ?? []) {
      if (t < a.at || t > a.at + a.duration + 0.35) continue;
      const w = Math.min(smooth((t - a.at) / 0.35), 1 - smooth((t - a.at - a.duration) / 0.35));
      if (w > actionW) { actionW = w; action = a.clip; actionT = t - a.at; }
    }
    for (const [role, a] of this.act) {
      let w = 0;
      if (role === gait) { w = move; const dur = a.getClip().duration; a.time = ((s.dist / (this.stride[role] ?? 1)) * dur) % dur; }
      else if (role === "idle") { w = (1 - move) * (1 - actionW); a.time = t % a.getClip().duration; }
      else if (role === action) { w = (1 - move) * actionW; const dur = a.getClip().duration; a.time = Math.min(dur - 1e-3, actionT % (dur * 4)) % dur; }
      a.setEffectiveWeight(w);
    }
    this.mixer.update(0);
    this.root.updateMatrixWorld(true);
  }
  /** The speed the path asks for at t (tests: compare with the paws). */
  speedAt(t: number): number { return this.at(t).v; }
}
