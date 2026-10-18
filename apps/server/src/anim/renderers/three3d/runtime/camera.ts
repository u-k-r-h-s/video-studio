import * as THREE from "three";
import type { CameraSpec3D, CameraState3D } from "../spec";

/**
 * Cinematic camera. The Director names an intention (shot size + movement + subject); this turns it into a camera that
 * frames the subject by shot size, sits on one side / behind it, and moves with a critically damped spring so nothing is
 * robotic: follow lags a little, a push-in eases, handheld breathes. Deterministic: step(t, dt) once per frame, in order.
 */
export interface Framing { distance: number; height: number; lookHeight: number; fov: number }
export const FRAMINGS: Record<CameraSpec3D["shot"], Framing> = {
  wide: { distance: 6.5, height: 1.55, lookHeight: 1.1, fov: 42 },
  medium: { distance: 3.6, height: 1.5, lookHeight: 1.25, fov: 38 },
  closeup: { distance: 2.0, height: 1.62, lookHeight: 1.5, fov: 32 },
  // close behind the listener's shoulder (it frames the speaker past it), not a wide from behind
  over_shoulder: { distance: 1.7, height: 1.6, lookHeight: 1.5, fov: 40 },
  // a detail of an object: ~0.9 m away, a little above it, looking at the object's own point (a spout, a tap, a bucket)
  insert: { distance: 0.9, height: 0.38, lookHeight: 0, fov: 38 },
};

export interface CameraSubject { position: THREE.Vector3; heading: number; height: number; head?: THREE.Vector3; /** A point of the set, not a person. */ place?: boolean }

/** Critically damped spring toward a goal (Unity-style SmoothDamp): smooth, no overshoot. `omega` = 2 / smoothing time. */
class Spring {
  v = new THREE.Vector3();
  // (omega is public: a composition change can retune it)
  constructor(public x: THREE.Vector3, public omega: number) {}
  step(goal: THREE.Vector3, dt: number): THREE.Vector3 {
    const k = this.omega * dt, e = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
    const change = this.x.clone().sub(goal);
    const temp = this.v.clone().addScaledVector(change, this.omega).multiplyScalar(dt);
    this.v.sub(temp.clone().multiplyScalar(this.omega)).multiplyScalar(e);
    this.x.copy(goal).add(change.add(temp).multiplyScalar(e));
    return this.x;
  }
}

/** A composition in force: the spec's framing fields, as changed by a key or an entry move. */
type State = Required<Pick<CameraSpec3D, "shot" | "move" | "target">> & Pick<CameraSpec3D, "toward" | "side" | "behind" | "angle" | "heightOffset" | "fovScale" | "frameWith"> & { atEnd?: boolean };
interface Pose { P: THREE.Vector3; L: THREE.Vector3; fov: number }
/** 0..1 with zero velocity AND acceleration at both ends: a move starts and settles without a jolt or an overshoot. */
const smoother = (u: number): number => { const c = Math.min(1, Math.max(0, u)); return c * c * c * (c * (c * 6 - 15) + 10); };

export class CinematicCamera {
  readonly camera: THREE.PerspectiveCamera;
  private pos: Spring | null = null;
  private look: Spring | null = null;
  private fov: number;
  /** Per composition, decided once: the side of the subject (the one in the open) and the side of a two-shot line. */
  private sides = new Map<State, number>();
  private pairSides = new Map<State, boolean>();
  /** A static composition holds the position it first had. */
  private held = new Map<State, THREE.Vector3>();
  /** The timeline: the composition in force from `at`, reached by a move of `blend` seconds from wherever the camera was. */
  private readonly timeline: { at: number; blend: number; state: State }[];
  private out: Pose | null = null;
  private moveFrom: { index: number; pose: Pose } | null = null;
  constructor(readonly spec: CameraSpec3D, aspect: number, private readonly duration: number, private readonly resolve: (id: string) => CameraSubject | null, private readonly clamp?: (p: THREE.Vector3) => void) {
    this.camera = new THREE.PerspectiveCamera(FRAMINGS[spec.shot].fov, aspect, 0.05, 300);
    this.fov = FRAMINGS[spec.shot].fov;
    const base: State = { shot: spec.shot, move: spec.move, target: spec.target, toward: spec.toward, side: spec.side, behind: spec.behind, angle: spec.angle, frameWith: spec.frameWith, heightOffset: spec.heightOffset, fovScale: spec.fovScale };
    const merge = (a: State, k: CameraState3D): State => {
      const m: State = { ...a };
      for (const [key, v] of Object.entries(k)) if (v !== undefined && key !== "at" && key !== "blend") (m as Record<string, unknown>)[key] = v === null ? undefined : v;
      // a new subject or a new size is a new composition: its own side and two-shot line are decided afresh
      return m;
    };
    this.timeline = spec.enter
      ? [{ at: -Infinity, blend: 0, state: merge(base, spec.enter.from) }, { at: spec.enter.at ?? 0, blend: spec.enter.duration, state: base }]
      : [{ at: -Infinity, blend: 0, state: base }];
    for (const k of [...(spec.keys ?? [])].sort((a, b) => a.at - b.at)) this.timeline.push({ at: k.at, blend: Math.max(1 / 60, k.blend ?? 1.2), state: merge(this.timeline.at(-1)!.state, k) });
  }

  /** Where the camera stands, what it looks at and its lens for composition `st` at time t (before smoothing). */
  private compose(t: number, st: State): Pose & { stiff: number } | null {
    const f = { ...FRAMINGS[st.shot] };
    const behind = !!st.behind, frameWith = st.frameWith;
    const subj = this.resolve(st.target);
    if (!subj) return null;
    const u = st.atEnd ? 1 : Math.min(1, Math.max(0, t / this.duration)), ease = u * u * (3 - 2 * u);
    // the shot's own lens and height (the visual plan varies them: a low angle for awe or anger, a longer lens in close)
    // (a close-up keeps the angle mild: at 2 m on a long lens a full low angle shows sky, not a face)
    const close = st.shot === "closeup" && !behind;
    const hOff = close ? THREE.MathUtils.clamp(st.heightOffset ?? 0, -0.22, 0.3) : st.heightOffset ?? 0;
    f.height += hOff;
    f.lookHeight += hOff * -0.25;
    let dist = f.distance * (st.fovScale && st.fovScale < 1 ? 1 / st.fovScale : 1), fov = f.fov * (st.fovScale ?? 1), yawOffset = 0, tilt = 0;
    switch (st.move) {
      case "push_in": dist *= 1 - 0.28 * ease; fov -= 3 * ease; break;
      case "pull_out": dist *= 1 + 0.35 * ease; break;
      case "pan": yawOffset = -0.35 + 0.7 * ease; break;
      case "tilt": tilt = -0.25 + 0.4 * ease; break;
      default: break;
    }
    // where the camera sits: around the subject at an angle (three-quarter from the front, or over the shoulder from behind)
    // which side of the subject: the one where the camera stays in the open (needs no collision clamp), decided once
    if (!this.sides.has(st)) {
      const test = (sd: number): number => { const a = subj.heading + (st.angle ?? (behind ? Math.PI - 0.38 : 0.62)) * sd; const p = subj.position.clone().add(new THREE.Vector3(Math.sin(a) * dist, f.height, Math.cos(a) * dist)); const q = p.clone(); this.clamp?.(q); return q.distanceTo(p); };
      this.sides.set(st, st.side !== undefined && test(st.side) < 0.01 ? st.side : test(1) <= test(-1) ? 1 : -1);
    }
    // over the shoulder: the planner picks the shoulder (the open front of the set), not the clamp probe around the listener
    const sideUse = st.shot === "over_shoulder" && st.side !== undefined ? st.side : this.sides.get(st)!;
    const ang = subj.heading + (st.angle !== undefined ? st.angle * sideUse : behind ? Math.PI - 0.38 * sideUse : 0.62 * sideUse) + yawOffset;
    const lookAt = subj.position.clone().add(new THREE.Vector3(0, f.lookHeight * (subj.height / 1.8) + tilt, 0));
    // the look point leads a little ahead of a moving subject: the frame leaves room in front of it
    const fwd = new THREE.Vector3(Math.sin(subj.heading), 0, Math.cos(subj.heading));
    lookAt.addScaledVector(fwd, behind ? 1.2 : 0.25);
    // a close-up is about the face: aim at the head itself (a turned head or a leaning body would otherwise drift off frame)
    if (close && subj.head) lookAt.set(subj.head.x, subj.head.y - 0.06 + tilt, subj.head.z);
    const ots = st.shot === "over_shoulder" || (behind && f.distance < 2.5);
    // over the shoulder: aim at the face of whom it is about (the speaker, `toward`), or past the character at what it faces
    const otsAt = ots && st.toward ? this.resolve(st.toward) : null;
    if (ots) { if (otsAt) lookAt.copy(otsAt.head ?? otsAt.position.clone().setY(1.45)).add(new THREE.Vector3(0, -0.05, 0)); else lookAt.copy(subj.position).addScaledVector(fwd, 4).setY(1.45); }
    // a wide of the place (no one in it): look across the set at eye level, not down at the ground under the camera
    if (subj.place && st.shot === "wide") lookAt.setY(1.7 + tilt);
    if (st.toward && !ots) {
      const tw = this.resolve(st.toward);
      if (tw) lookAt.lerp(tw.position.clone().add(new THREE.Vector3(0, 1.4, 0)), (f.distance > 4 ? 0.35 : 0) * (st.move === "push_in" ? ease : 0.5));
    }
    // two-shot: the subject AND what it deals with (a door, a doorbell) in one mobile frame: the camera stands off the line between
    // them, on the open side, far enough that both fit the narrow 9:16 width, looking at a point weighted toward the subject
    let twoShot: THREE.Vector3 | null = null;
    if (frameWith && !ots) {
      const fw = this.resolve(frameWith);
      if (fw) {
        const S = subj.position.clone().setY(0), T = fw.position.clone().setY(0);
        const line = T.clone().sub(S); const sep = Math.max(0.3, line.length()); line.normalize();
        let perp = new THREE.Vector3(line.z, 0, -line.x);
        const mid = S.clone().lerp(T, 0.38);
        // the open side; when both sides are open, the side the subject faces (we see faces, not backs). Decided once per
        // composition: re-deciding every frame flipped the camera across the pair when someone turned or walked
        // (probe at camera height: a ground-level probe was "clamped" by the terrain under it)
        if (!this.pairSides.has(st)) {
          const test = (p: THREE.Vector3): number => { const q = p.clone(); this.clamp?.(q); return q.distanceTo(p); };
          const probeY = f.height * (subj.height / 1.8);
          const ta = test(mid.clone().addScaledVector(perp, 4).setY(probeY)), tb = test(mid.clone().addScaledVector(perp, -4).setY(probeY));
          const pref = this.spec.front ? new THREE.Vector3(this.spec.front.x, 0, this.spec.front.z) : fwd;
          this.pairSides.set(st, ta > tb + 0.01 || (Math.abs(ta - tb) <= 0.01 && perp.dot(pref) < 0));
        }
        if (this.pairSides.get(st)) perp.negate();
        // a little toward the subject's front, so the face reads
        perp = perp.addScaledVector(fwd, 0.35).normalize();
        const vfov = THREE.MathUtils.degToRad(fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
        const d = Math.max(dist * 0.9, (sep + 1.3) / 2 / Math.tan(hfov / 2));
        twoShot = mid.clone().addScaledVector(perp, d).setY(f.height * (subj.height / 1.8));
        lookAt.copy(mid).setY(f.lookHeight * (subj.height / 1.8) + tilt);
      }
    }
    // insert: the object's own point (set points resolve with their real height), seen from a little above and in front
    let insertGoal: THREE.Vector3 | null = null;
    if (st.shot === "insert") {
      // the look point a little under the object's point: a spout and the water falling from it, a tap and its bucket
      const P = (subj.head ?? subj.position).clone().add(new THREE.Vector3(0, -0.22, 0));
      lookAt.copy(P);
      insertGoal = P.clone().add(new THREE.Vector3(Math.sin(ang) * dist, f.height, Math.cos(ang) * dist));
    }
    // OTS: behind the listener and off one shoulder (the camera's side of the line of action); on a 9:16 frame 0.7 m
    // sideways keeps the listener's head at the frame edge and ~0.3 m clear of the line to the speaker's face
    const otsBack = otsAt ? otsAt.position.clone().sub(subj.position).setY(0).normalize() : fwd;
    const otsRight = new THREE.Vector3(otsBack.z, 0, -otsBack.x);
    const goal = insertGoal ? insertGoal : twoShot ? twoShot : ots
      ? subj.position.clone().addScaledVector(otsBack, -dist).addScaledVector(otsRight, -0.7 * sideUse).setY(f.height * (subj.height / 1.8))
      : (close && subj.head ? subj.head.clone().setY(0) : subj.position.clone()).add(new THREE.Vector3(Math.sin(ang) * dist, f.height * (subj.height / 1.8), Math.cos(ang) * dist));
    this.clamp?.(goal);
    // a static composition holds where it first stood (its look still follows the subject)
    if (st.move === "static") { const h = this.held.get(st); if (h) goal.copy(h); else this.held.set(st, goal.clone()); }
    return { P: goal, L: lookAt, fov, stiff: st.move === "follow" || st.move === "tracking" ? 2.6 : 1.8 };
  }

  step(t: number, dt: number): THREE.PerspectiveCamera {
    const fx = this.spec.fixed;
    if (fx) {
      const u = fx.to ? Math.min(1, Math.max(0, t / Math.max(1e-3, this.duration))) : 0, e = u * u * (3 - 2 * u);
      const P = new THREE.Vector3(...fx.position), L = new THREE.Vector3(...fx.lookAt);
      if (fx.to) { P.lerp(new THREE.Vector3(...fx.to.position), e); L.lerp(new THREE.Vector3(...fx.to.lookAt), e); }
      this.camera.position.copy(P); this.camera.lookAt(L);
      this.camera.fov = fx.fov ?? FRAMINGS[this.spec.shot].fov; this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld(true);
      return this.camera;
    }
    let j = 0;
    for (let i = 1; i < this.timeline.length; i++) if (t >= this.timeline[i]!.at) j = i;
    const seg = this.timeline[j]!;
    const goal = this.compose(t, seg.state);
    if (!goal) return this.camera;
    let pose: Pose;
    if (j > 0 && t < seg.at + seg.blend) {
      // a designed move: from where the camera was when the move began (or, on the shot's first frame, the composition it
      // opens on) to the new composition, eased in and out. It arcs around what it looks at: the offset from the look point
      // turns and changes length rather than cutting straight through the subject
      if (!this.moveFrom || this.moveFrom.index !== j) {
        const from = this.out ?? this.compose(t, this.timeline[j - 1]!.state) ?? goal;
        this.moveFrom = { index: j, pose: { P: from.P.clone(), L: from.L.clone(), fov: from.fov } };
      }
      // the look leads the travel (an operator pans to the new subject, then the dolly arrives): it reaches its target at 65 %
      // of the move, so whoever the move is going to is in frame early (a line starting with the move is not spoken off-screen)
      const u = (t - seg.at) / seg.blend, a = this.moveFrom.pose, e = smoother(u), eL = smoother(u / 0.65);
      const L = a.L.clone().lerp(goal.L, eL);
      const da = a.P.clone().sub(a.L), db = goal.P.clone().sub(goal.L);
      const la = da.length(), lb = db.length();
      const q = new THREE.Quaternion().setFromUnitVectors(da.normalize(), db.normalize());
      const dir = da.applyQuaternion(new THREE.Quaternion().slerp(q, e));
      const P = L.clone().addScaledVector(dir, la + (lb - la) * e);
      this.clamp?.(P);
      pose = { P, L, fov: a.fov + (goal.fov - a.fov) * e };
      // the springs ride along, so a follow camera picks up from here at rest when the move ends
      if (this.pos && this.look) { this.pos.x.copy(P); this.pos.v.set(0, 0, 0); this.look.x.copy(L); this.look.v.set(0, 0, 0); this.pos.omega = goal.stiff; this.look.omega = goal.stiff * 1.6; }
      else { this.pos = new Spring(P.clone(), goal.stiff); this.look = new Spring(L.clone(), goal.stiff * 1.6); }
      this.fov = pose.fov;
    } else {
      if (!this.pos) { this.pos = new Spring(goal.P.clone(), goal.stiff); this.look = new Spring(goal.L.clone(), goal.stiff * 1.6); this.fov = goal.fov; }
      this.pos.omega = goal.stiff; this.look!.omega = goal.stiff * 1.6;
      // the lens eases toward the composition's at a fixed time constant (frame-rate independent)
      this.fov += (goal.fov - this.fov) * (1 - Math.exp(-3 * dt));
      // a designed move (push-in, pull-out, pan, tilt) already follows an eased curve over the shot: through the spring it
      // lagged ~0.9 m behind and never arrived, so the next shot could not open where it ended. Only following a subject
      // (follow, tracking, handheld) needs the spring; the look still goes through one (a head bobs, the frame must not)
      // (a static camera stands exactly on its held composition too: after a move it lands there, no spring tail)
      const designed = seg.state.move === "push_in" || seg.state.move === "pull_out" || seg.state.move === "pan" || seg.state.move === "tilt" || seg.state.move === "static";
      const P = this.pos.step(goal.P, dt).clone();
      if (designed) { P.copy(goal.P); this.pos.x.copy(P); this.pos.v.set(0, 0, 0); this.fov = goal.fov; }
      pose = { P, L: this.look!.step(goal.L, dt).clone(), fov: this.fov };
    }
    this.out = pose;
    // handheld: slow breathing drift + small jitter, never a shake unless asked
    const hh = this.spec.handheld ?? (seg.state.move === "handheld" ? 1 : 0.35);
    const n = (a: number, b: number): number => Math.sin(t * a + b) * 0.6 + Math.sin(t * a * 2.13 + b * 1.7) * 0.4;
    this.camera.position.copy(pose.P).add(new THREE.Vector3(n(0.9, 1) * 0.018 * hh, n(1.1, 2) * 0.014 * hh, n(0.7, 3) * 0.012 * hh));
    this.camera.lookAt(pose.L.clone().add(new THREE.Vector3(n(0.6, 4) * 0.01 * hh, n(0.8, 5) * 0.008 * hh, 0)));
    this.camera.fov = pose.fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    return this.camera;
  }

  /** A short camera kick (reaction): roll + vertical jolt that decays. */
  kick(t: number, at: number, amount = 1): void {
    const u = t - at;
    if (u < 0 || u > 0.6) return;
    const d = Math.exp(-u * 7) * amount;
    this.camera.rotateZ(0.012 * Math.sin(u * 38) * d);
    this.camera.position.y += 0.02 * Math.sin(u * 31) * d;
  }
}
