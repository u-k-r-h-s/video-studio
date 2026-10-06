import * as THREE from "three";
import type { CameraSpec3D } from "../spec";

/**
 * Cinematic camera. The Director names an intention (shot size + movement + subject); this turns it into a camera that
 * frames the subject by shot size, sits on one side / behind it, and moves with a critically damped spring so nothing is
 * robotic: follow lags a little, a push-in eases, handheld breathes. Deterministic: step(t, dt) once per frame, in order.
 */
export interface Framing { distance: number; height: number; lookHeight: number; fov: number }
export const FRAMINGS: Record<CameraSpec3D["shot"], Framing> = {
  wide: { distance: 6.5, height: 1.55, lookHeight: 1.1, fov: 42 },
  medium: { distance: 3.2, height: 1.55, lookHeight: 1.3, fov: 36 },
  closeup: { distance: 1.35, height: 1.62, lookHeight: 1.58, fov: 30 },
  over_shoulder: { distance: 2.5, height: 1.78, lookHeight: 1.5, fov: 44 },
};

export interface CameraSubject { position: THREE.Vector3; heading: number; height: number }

/** Critically damped spring toward a goal (Unity-style SmoothDamp): smooth, no overshoot. `omega` = 2 / smoothing time. */
class Spring {
  v = new THREE.Vector3();
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

export class CinematicCamera {
  readonly camera: THREE.PerspectiveCamera;
  private pos: Spring | null = null;
  private look: Spring | null = null;
  private fov: number;
  private autoSide: number | null = null;
  constructor(readonly spec: CameraSpec3D, aspect: number, private readonly duration: number, private readonly resolve: (id: string) => CameraSubject | null, private readonly clamp?: (p: THREE.Vector3) => void) {
    this.camera = new THREE.PerspectiveCamera(FRAMINGS[spec.shot].fov, aspect, 0.05, 300);
    this.fov = FRAMINGS[spec.shot].fov;
  }

  /** The framing in force at time t (keys blend from one framing to the next). */
  private framingAt(t: number): { f: Framing; target: string; behind: boolean; side: number } {
    let f = { ...FRAMINGS[this.spec.shot] }, target = this.spec.target, behind = !!this.spec.behind, side = this.spec.side ?? 1;
    for (const k of this.spec.keys ?? []) {
      if (t < k.at) break;
      const u = Math.min(1, (t - k.at) / Math.max(0.01, k.blend ?? 1.2)), e = u * u * (3 - 2 * u);
      if (k.shot) { const g = FRAMINGS[k.shot]; f = { distance: f.distance + (g.distance - f.distance) * e, height: f.height + (g.height - f.height) * e, lookHeight: f.lookHeight + (g.lookHeight - f.lookHeight) * e, fov: f.fov + (g.fov - f.fov) * e }; }
      if (k.target && u > 0.5) target = k.target;
      if (k.behind !== undefined) behind = k.behind;
      if (k.side !== undefined) side = k.side;
    }
    return { f, target, behind, side };
  }

  step(t: number, dt: number): THREE.PerspectiveCamera {
    const { f, target, behind } = this.framingAt(t);
    const subj = this.resolve(target);
    if (!subj) return this.camera;
    const u = t / this.duration, ease = u * u * (3 - 2 * u);
    let dist = f.distance, fov = f.fov, yawOffset = 0, tilt = 0;
    switch (this.spec.move) {
      case "push_in": dist *= 1 - 0.28 * ease; fov -= 3 * ease; break;
      case "pull_out": dist *= 1 + 0.35 * ease; break;
      case "pan": yawOffset = -0.35 + 0.7 * ease; break;
      case "tilt": tilt = -0.25 + 0.4 * ease; break;
      default: break;
    }
    // where the camera sits: around the subject at an angle (three-quarter from the front, or over the shoulder from behind)
    // which side of the subject: the one where the camera stays in the open (needs no collision clamp), decided once
    if (this.autoSide === null) {
      const test = (sd: number): number => { const a = subj.heading + (this.spec.angle ?? (behind ? Math.PI - 0.38 : 0.62)) * sd; const p = subj.position.clone().add(new THREE.Vector3(Math.sin(a) * dist, f.height, Math.cos(a) * dist)); const q = p.clone(); this.clamp?.(q); return q.distanceTo(p); };
      this.autoSide = this.spec.side !== undefined && test(this.spec.side) < 0.01 ? this.spec.side : test(1) <= test(-1) ? 1 : -1;
    }
    const sideUse = this.autoSide;
    const ang = subj.heading + (this.spec.angle !== undefined ? this.spec.angle * sideUse : behind ? Math.PI - 0.38 * sideUse : 0.62 * sideUse) + yawOffset;
    const lookAt = subj.position.clone().add(new THREE.Vector3(0, f.lookHeight * (subj.height / 1.8) + tilt, 0));
    // the look point leads a little ahead of a moving subject: the frame leaves room in front of it
    const fwd = new THREE.Vector3(Math.sin(subj.heading), 0, Math.cos(subj.heading));
    const right = new THREE.Vector3(Math.cos(subj.heading), 0, -Math.sin(subj.heading));
    lookAt.addScaledVector(fwd, behind ? 1.2 : 0.25);
    // over the shoulder: the camera sits behind one shoulder and looks past the character at what it faces
    const ots = this.spec.shot === "over_shoulder" || (behind && f.distance < 2.5);
    if (ots) lookAt.copy(subj.position).addScaledVector(fwd, 4).setY(1.45);
    if (this.spec.toward) {
      const tw = this.resolve(this.spec.toward);
      if (tw) lookAt.lerp(tw.position.clone().add(new THREE.Vector3(0, 1.4, 0)), (f.distance > 4 ? 0.35 : 0) * (this.spec.move === "push_in" ? ease : 0.5));
    }
    const goal = ots
      ? subj.position.clone().addScaledVector(fwd, -dist).addScaledVector(right, -0.6 * sideUse).setY(f.height * (subj.height / 1.8))
      : subj.position.clone().add(new THREE.Vector3(Math.sin(ang) * dist, f.height * (subj.height / 1.8), Math.cos(ang) * dist));
    this.clamp?.(goal);
    if (this.spec.move === "static" && this.pos) goal.copy(this.pos.x);
    const stiff = this.spec.move === "follow" || this.spec.move === "tracking" ? 2.6 : 1.8;
    if (!this.pos) { this.pos = new Spring(goal.clone(), stiff); this.look = new Spring(lookAt.clone(), stiff * 1.6); }
    const p = this.pos.step(goal, dt), l = this.look!.step(lookAt, dt);
    // handheld: slow breathing drift + small jitter, never a shake unless asked
    const hh = this.spec.handheld ?? (this.spec.move === "handheld" ? 1 : 0.35);
    const n = (a: number, b: number): number => Math.sin(t * a + b) * 0.6 + Math.sin(t * a * 2.13 + b * 1.7) * 0.4;
    this.camera.position.copy(p).add(new THREE.Vector3(n(0.9, 1) * 0.018 * hh, n(1.1, 2) * 0.014 * hh, n(0.7, 3) * 0.012 * hh));
    this.camera.lookAt(l.clone().add(new THREE.Vector3(n(0.6, 4) * 0.01 * hh, n(0.8, 5) * 0.008 * hh, 0)));
    this.fov += (fov - this.fov) * Math.min(1, dt * 3);
    this.camera.fov = this.fov;
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
