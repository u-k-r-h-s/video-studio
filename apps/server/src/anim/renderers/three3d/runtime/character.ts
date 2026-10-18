import * as THREE from "three";
import type { Action3D, CharacterEvent3D, CharacterSpec3D, Cue3D, Expression, Target } from "../spec";
import { LocomotionStateMachine, type LocoWeights } from "./locomotion";
import { makeProp, placeProp, type Prop3D } from "./props";
import { contactShadow, presentModel } from "./presentation";
import { FaceRig } from "./face";
import { Damp, DampAngle } from "./motion";
import { chainMotion, findBones, findClips, inPlace, loopSeam, maskClip, seamlessLoop, type BoneRole, type ClipRole } from "./rig";

/**
 * A skinned 3D character driven by semantic actions. Body motion is skeletal: clips (idle/walk/run/wave/interact/react)
 * cross-faded by an AnimationMixer and a locomotion state machine; on top come small procedural layers that make the clips
 * fit the scene: look at a target (neck + head), hold/raise/aim a prop toward a target (shoulder + elbow), lean, flinch.
 * Orientation is a real rotation of the whole model toward a movement direction / target / the camera.
 * All of it is a deterministic function of the frame sequence: call update() once per frame, in order.
 */
export interface GLTFLike { scene: THREE.Object3D; animations: THREE.AnimationClip[] }
export interface World {
  /** Resolves a named target ("door", "camera", another character) to a world point. */
  resolve(t: Target): THREE.Vector3 | null;
}

const TAU = Math.PI * 2;
const wrap = (a: number): number => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const smooth = (x: number): number => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
const env = (t: number, a: number, d: number, fadeIn = 0.25, fadeOut = 0.35): number => (t < a ? 0 : t > a + d + fadeOut ? 0 : Math.min(smooth((t - a) / fadeIn), 1 - smooth((t - a - d) / fadeOut)));

interface MoveSeg { start: number; to: THREE.Vector3; mode: "walk" | "run" | "back"; done: boolean }

export class Character3D {
  readonly root = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  readonly bones: Partial<Record<BoneRole, THREE.Bone>>;
  readonly clips: Partial<Record<ClipRole, THREE.AnimationClip>>;
  readonly props: Prop3D[] = [];
  readonly loco: LocomotionStateMachine;
  readonly cues: Cue3D[] = [];
  readonly height: number;
  readonly presentation: ReturnType<typeof presentModel>;
  /** The face (visemes / expression shapes / jaw), or a rig that reports it has none. */
  readonly face: FaceRig;
  /** Evidence: frames in which this character's mouth was driven by speech, and how wide it opened. */
  readonly faceStats = { talkingFrames: 0, maxOpen: 0 };
  /** Talking / listening gesture clips (upper body over idle or walk), when the model has them. */
  private readonly gestures: { name: string; kind: "talk" | "listen"; action: THREE.AnimationAction; w: number }[] = [];
  private readonly contact: THREE.Mesh;
  expression: Expression = "neutral";
  /** Calibrated ground speed of the walk / run clips (m/s): the feet do not slide. */
  readonly walkSpeed: number;
  readonly runSpeed: number;
  private readonly act: Partial<Record<"idle" | "walk" | "run" | "wave" | "interact" | "react", THREE.AnimationAction>> = {};
  private readonly events: CharacterEvent3D[];
  private heading: number;
  private turnRate = 0;
  private faceTarget: number | null = null;
  private lookAt: { target: Target; from: number; until: number; fadeIn: number } | null = null;
  private lookAround: { from: number; until: number } | null = null;
  private moves: MoveSeg[] = [];
  private speed = 0;
  private lastLoco: LocoWeights = { idle: 1, walk: 0, run: 0, walkRate: 1, runRate: 1 };
  private contacts: { walk: number[]; run: number[] } = { walk: [0, 0.5], run: [0, 0.5] };
  private startPhase = { walk: 0, run: 0 };
  /** Foot locking: a foot the animation has put down stays where it landed (leg IK) until the clip lifts it again. */
  private feet: { side: "L" | "R"; restY: number; lock: THREE.Vector3 | null; w: Damp }[] = [];
  private lastPhase = { walk: 0, run: 0 };
  private readonly rest: [THREE.Object3D, THREE.Quaternion][] = [];
  /** The mixer's output last frame (the animated pose under the procedural layers). */
  private base: [THREE.Object3D, THREE.Quaternion][] = [];
  private hold = new Map<string, { raise: number; rising: { from: number; to: number; t0: number; dur: number } | null }>();
  /** When each prop went into the hand (-Infinity: from the start; null: still resting in the world, see PropSpec3D.restAt). */
  private attachedAt = new Map<string, number | null>();
  private restPose = new Map<string, { position: THREE.Vector3; quaternion: THREE.Quaternion }>();

  constructor(readonly spec: CharacterSpec3D, gltf: GLTFLike, private readonly world: World) {
    this.model = gltf.scene;
    this.bones = findBones(this.model);
    this.clips = findClips(gltf.animations);
    if (!this.clips.idle || !this.clips.walk) throw new Error(`character ${spec.id}: the model needs at least an Idle and a Walk clip (has: ${gltf.animations.map((a) => a.name).join(", ")})`);
    if (spec.scale) this.model.scale.multiplyScalar(spec.scale);
    // dress the base model for the story: colour overrides per material name
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach((mt, i) => {
        const want = spec.wardrobe?.[mt.name];
        if (!want) return;
        const c = (mt as THREE.MeshStandardMaterial).clone(); c.color = new THREE.Color(want);
        if (Array.isArray(m.material)) (m.material as THREE.Material[])[i] = c; else m.material = c;
      });
    });
    this.presentation = presentModel(this.model);
    this.root.add(this.model);
    this.root.name = `character:${spec.id}`;
    this.contact = contactShadow(0.95);
    this.root.add(this.contact);
    this.model.updateMatrixWorld(true);
    // make the root's +Z the character's forward (from the foot: the toe is in front of the ankle)
    const foot = this.bones.footR ?? this.bones.footL;
    const toe = foot?.children.find((c) => (c as THREE.Bone).isBone);
    if (foot && toe) {
      const a = foot.getWorldPosition(new THREE.Vector3()), b = toe.getWorldPosition(new THREE.Vector3());
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      if (Math.abs(b.x - a.x) + Math.abs(b.z - a.z) > 1e-4) this.model.rotation.y -= yaw;
    }
    let box = new THREE.Box3().setFromObject(this.model);
    // models from different packs come in different units (a 4.6 m tall export): an implausible human height is scaled to
    // a standard adult; a plausible one is left exactly as it is
    const raw = (box.max.y - box.min.y) / (spec.scale ?? 1);
    if (raw > 0 && (raw < 1.2 || raw > 2.3)) {
      this.model.scale.multiplyScalar(1.72 / raw);
      this.model.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(this.model);
    }
    this.height = box.max.y - box.min.y;

    // rest pose of every bone: procedural layers are applied on top of the clips each frame, and a bone no clip animates
    // must go back to rest first, or the layers would accumulate from frame to frame
    this.model.traverse((o) => { if ((o as THREE.Bone).isBone) this.rest.push([o, o.quaternion.clone()]); });
    this.base = this.rest.map(([b, q]) => [b, q.clone()]);
    this.mixer = new THREE.AnimationMixer(this.model);
    const hips = this.bones.hips;
    // a clip that repeats must actually loop: a trimmed performance (its last pose far from its first) is cross-faded into
    // a seamless cycle, or every wrap would snap the body (measured: up to 125 degrees on a forearm in one frame)
    const looped = (c: THREE.AnimationClip): THREE.AnimationClip => (loopSeam(c) > 3 ? seamlessLoop(c) : c);
    const add = (key: keyof Character3D["act"], clip: THREE.AnimationClip | undefined, loop = true): void => {
      if (!clip) return;
      if (loop) clip = looped(clip);
      const a = this.mixer.clipAction(clip);
      a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      a.clampWhenFinished = !loop;
      a.enabled = true; a.setEffectiveWeight(0); a.play();
      this.act[key] = a;
    };
    add("idle", this.clips.idle);
    add("walk", inPlace(this.clips.walk, hips));
    add("run", this.clips.run ? inPlace(this.clips.run, hips) : undefined);
    // a one-arm gesture is masked to the arm the clip actually moves (some rigs wave with the left hand)
    const shR = this.bones.shoulderR ?? this.bones.upperArmR, shL = this.bones.shoulderL ?? this.bones.upperArmL;
    const waveArm = this.clips.wave && chainMotion(this.clips.wave, shL) > chainMotion(this.clips.wave, shR) ? shL : shR;
    const armR = [waveArm].filter(Boolean) as THREE.Object3D[];
    const arms = [this.bones.shoulderR ?? this.bones.upperArmR, this.bones.shoulderL ?? this.bones.upperArmL].filter(Boolean) as THREE.Object3D[];
    add("wave", this.clips.wave ? maskClip(this.clips.wave, armR, "wave-arm") : undefined, true);
    add("interact", this.clips.interact ? maskClip(this.clips.interact, arms, "interact-arms") : undefined, false);
    add("react", this.clips.react, false);
    // conversation: talking and listening gestures from the body above the hips, each character at its own phase
    const torso = this.bones.spine ?? this.bones.chest;
    const phase = [...spec.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    if (torso) for (const clip of gltf.animations) {
      const kind = /^talk/i.test(clip.name) ? "talk" : /^listen/i.test(clip.name) ? "listen" : null;
      if (!kind) continue;
      const a = this.mixer.clipAction(maskClip(looped(clip), [torso], `${clip.name}-upper`, [this.bones.upperLegL, this.bones.upperLegR].filter(Boolean) as THREE.Object3D[]));
      a.setLoop(THREE.LoopRepeat, Infinity); a.enabled = true; a.setEffectiveWeight(0); a.play();
      a.time = (phase % 997) / 997 * a.getClip().duration;
      this.gestures.push({ name: clip.name, kind, action: a, w: 0 });
    }
    this.face = new FaceRig(this.model, phase);
    this.act.idle!.setEffectiveWeight(1);
    // the walk clip decides where "forward" is: the body must travel the way the planted foot pushes, or it crab-walks
    // (measured: the Rocketbox walk travels 16 degrees off the bind pose's toe direction, the stance foot slid 0.3 m/s)
    const travel = this.stance("walk");
    if (travel && Math.abs(travel.yaw) > 0.01) {
      this.model.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -travel.yaw));
      this.model.updateMatrixWorld(true);
    }
    this.walkSpeed = this.stance("walk")?.speed ?? 1.35;
    this.runSpeed = this.clips.run ? this.stance("run")?.speed ?? 3.6 : this.walkSpeed * 2.4;
    this.loco = new LocomotionStateMachine({ walkSpeed: this.walkSpeed, runSpeed: this.runSpeed });

    for (const ps of spec.props ?? []) {
      const p = makeProp(ps); this.props.push(p); this.hold.set(p.id, { raise: 0, rising: null });
      this.attachedAt.set(p.id, ps.restAt ? null : -Infinity);
      if (ps.restAt) this.restPose.set(p.id, { position: new THREE.Vector3(ps.restAt.x, ps.restAt.y, ps.restAt.z), quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ps.restAt.rotation ?? 0) });
    }
    this.events = [...spec.events].sort((a, b) => a.at - b.at);
    if (this.bones.footL && this.bones.footR && this.bones.upperLegL && this.bones.lowerLegL && this.bones.upperLegR && this.bones.lowerLegR) {
      this.model.updateMatrixWorld(true);
      for (const side of ["L", "R"] as const) this.feet.push({ side, restY: this.bones[`foot${side}`]!.getWorldPosition(new THREE.Vector3()).y, lock: null, w: new Damp(0, 0.12) });
    }
    this.root.position.set(spec.start.x, 0, spec.start.z);
    const h = spec.start.heading;
    this.heading = typeof h === "number" ? h : h !== undefined ? this.headingTo(h) ?? 0 : 0;
    this.root.rotation.y = this.heading;
    this.expression = spec.expression ?? "neutral";
  }

  /**
   * Ground travel of a locomotion clip, measured from the planted foot: played in place, the foot that carries the weight
   * slides backward under the body at exactly the speed (and in exactly the direction opposite to) the way the body must
   * move for that foot to stay put. Returns the speed along the travel direction and that direction's yaw from +Z.
   */
  private stance(kind: "walk" | "run"): { speed: number; yaw: number } | null {
    const clip = this.clips[kind], fl = this.bones.footL, fr = this.bones.footR;
    if (!clip || !fl || !fr) return null;
    const m = new THREE.AnimationMixer(this.model), a = m.clipAction(kind === "walk" || kind === "run" ? inPlace(clip, this.bones.hips) : clip);
    a.play();
    const N = 96, dt = clip.duration / N, L: THREE.Vector3[] = [], R: THREE.Vector3[] = [];
    for (let i = 0; i <= N; i++) {
      m.setTime(i * dt);
      this.model.updateMatrixWorld(true);
      L.push(fl.getWorldPosition(new THREE.Vector3())); R.push(fr.getWorldPosition(new THREE.Vector3()));
    }
    m.stopAllAction(); m.uncacheRoot(this.model);
    this.model.updateMatrixWorld(true);
    const lowL = Math.min(...L.map((p) => p.y)), lowR = Math.min(...R.map((p) => p.y));
    // the phase that looks most like standing (feet closest together): a walk started from idle begins here
    let best = 0, bestD = Infinity;
    for (let i = 0; i < N; i++) { const d = Math.hypot(L[i]!.x - R[i]!.x, L[i]!.z - R[i]!.z) + 4 * Math.abs(L[i]!.y - lowL - (R[i]!.y - lowR)); if (d < bestD) { bestD = d; best = i; } }
    this.startPhase[kind] = best / N;
    // foot contact phases: where each foot is lowest
    this.contacts[kind] = [L.findIndex((p) => p.y === lowL) / N, R.findIndex((p) => p.y === lowR) / N];
    let vx = 0, vz = 0, n = 0;
    for (let i = 1; i < N; i++) {
      // the planted foot: the lower one, within 3 cm of its lowest point
      const left = L[i]!.y - lowL <= R[i]!.y - lowR, P = left ? L : R, low = left ? lowL : lowR;
      if (P[i]!.y - low > 0.03 * this.height / 1.8) continue;
      vx += (P[i + 1]!.x - P[i - 1]!.x) / (2 * dt); vz += (P[i + 1]!.z - P[i - 1]!.z) / (2 * dt); n++;
    }
    if (n < 4) return null;
    vx /= n; vz /= n;
    const speed = Math.hypot(vx, vz);
    return speed > 0.2 && speed < 9 ? { speed, yaw: Math.atan2(-vx, -vz) } : null;
  }

  private headingTo(t: Target): number | null {
    const p = this.world.resolve(t);
    if (!p) return null;
    return Math.atan2(p.x - this.root.position.x, p.z - this.root.position.z);
  }

  /** Bones/sockets for prop placement. */
  private sockets(hand: "R" | "L"): Parameters<typeof placeProp>[1] {
    return { hand: hand === "R" ? this.bones.handR : this.bones.handL, elbow: hand === "R" ? this.bones.lowerArmR : this.bones.lowerArmL, chest: this.bones.chest, hips: this.bones.hips, root: this.root };
  }

  /** Rotates `b` (world space) so the direction to `child` points along `dir`, blended by w. Works for any bone axes. */
  private aim(b: THREE.Object3D | undefined, child: THREE.Object3D | undefined, dir: THREE.Vector3, w: number): void {
    if (!b || !child || w <= 0.0005) return;
    b.updateWorldMatrix(true, false);
    child.updateWorldMatrix(false, false);
    const p0 = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld), p1 = new THREE.Vector3().setFromMatrixPosition(child.matrixWorld);
    const cur = p1.sub(p0).normalize();
    const delta = new THREE.Quaternion().setFromUnitVectors(cur, dir.clone().normalize());
    const wq = b.getWorldQuaternion(new THREE.Quaternion());
    const pq = b.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
    const target = pq.multiply(delta.multiply(wq));
    b.quaternion.slerp(target, Math.min(1, w));
    b.updateWorldMatrix(false, true);
  }

  /** Extra world-space rotation of a bone (yaw about world up, pitch about the character's right axis). */
  private turnBone(b: THREE.Object3D | undefined, yaw: number, pitch: number, roll = 0): void {
    if (!b || (Math.abs(yaw) + Math.abs(pitch) + Math.abs(roll) < 1e-5)) return;
    b.updateWorldMatrix(true, false);
    const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.heading);
    const fwd = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.heading);
    const d = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, pitch))
      .multiply(new THREE.Quaternion().setFromAxisAngle(fwd, roll));
    const wq = b.getWorldQuaternion(new THREE.Quaternion());
    const pq = b.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
    b.quaternion.copy(pq.multiply(d.multiply(wq)));
    b.updateWorldMatrix(false, true);
  }

  private fwd(): THREE.Vector3 { return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading)); }

  /** When each event actually starts. Hand actions wait until a walk has ended and the body has settled (walk -> slow ->
   *  settle -> look -> pause -> act): the Director's `when` is a wish, the body decides the exact moment. */
  private startAt = new Map<CharacterEvent3D, number>();
  private arrivedAt: number | null = null;
  private static readonly AFTER_ARRIVAL = new Set<Action3D>(["raise", "push", "pull", "reach", "wave", "point", "react", "surprise", "fear", "lower", "press", "adjust", "hesitate"]);
  private holdUntil = -1;
  private eventStart(e: CharacterEvent3D): number | undefined { return this.startAt.get(e); }

  private trigger(t: number): void {
    const moving = this.moves.some((m) => !m.done && m.start <= t) || this.speed > 0.15;
    for (const e of this.events) {
      if (e.at > t || this.startAt.has(e)) continue;
      // picking a prop up (it rests in the world) waits for the stop like any hand action
      const pickup = e.action === "hold" && this.attachedAt.get(e.prop ?? this.props[0]?.id ?? "") === null;
      if (pickup && (moving || (this.arrivedAt !== null && t < this.arrivedAt + 0.38))) continue;
      if (Character3D.AFTER_ARRIVAL.has(e.action) && moving && e.action !== "react" && e.action !== "surprise" && e.action !== "fear") continue; // wait for the stop
      if (Character3D.AFTER_ARRIVAL.has(e.action) && this.arrivedAt !== null && t < this.arrivedAt + 0.38) continue; // settle + a beat
      if (Character3D.AFTER_ARRIVAL.has(e.action) && t < this.holdUntil && e.action !== "react" && e.action !== "surprise" && e.action !== "fear") continue; // still hesitating
      if ((e.action === "walk" || e.action === "run") && t < this.holdUntil) continue;
      // an event timed before the shot (a cut INTO an action: a hand already on the pump) is under way at the first frame
      this.startAt.set(e, e.at < 0 ? e.at : t);
      switch (e.action) {
        case "walk": case "run": {
          const p = e.target !== undefined ? this.world.resolve(e.target) : null;
          if (p) { this.moves.push({ start: t, to: new THREE.Vector3(p.x, 0, p.z), mode: e.action, done: false }); this.arrivedAt = null; }
          break;
        }
        case "step-back": {
          const d = (e.duration ?? 0.9) * this.walkSpeed * 0.5;
          this.moves.push({ start: t + 0.12, to: this.root.position.clone().addScaledVector(this.fwd(), -d), mode: "back", done: false });
          break;
        }
        case "stop": for (const m of this.moves) m.done = true; break;
        case "turn": this.faceTarget = e.target !== undefined ? this.headingTo(e.target) : null; break;
        case "look": { const on = !!this.lookAt && t <= this.lookAt.until; this.lookAt = { target: e.target ?? "camera", from: t, until: t + (e.duration ?? 1.5), fadeIn: on || e.at <= 0 ? 1e-3 : 0.3 }; break; }
        case "look-around": this.lookAround = { from: t, until: t + (e.duration ?? 2) }; break;
        case "hold": {
          const k = e.prop ?? this.props[0]?.id ?? "", p = this.hold.get(k);
          if (p) p.rising = { from: p.raise, to: 0, t0: t, dur: 0.01 };
          if (this.attachedAt.get(k) === null) this.attachedAt.set(k, t);
          break;
        }
        case "raise": { const k = e.prop ?? this.props.find((x) => x.socket === "rightHand")?.id ?? ""; const p = this.hold.get(k); if (p) p.rising = { from: p.raise, to: 1, t0: t + 0.08, dur: e.duration ?? 0.6 }; if (e.target !== undefined) { this.lookAt = { target: e.target, from: t - 0.1, until: t + 30, fadeIn: 0.3 }; this.aimAt = e.target; } break; }
        case "lower": { const k = e.prop ?? this.props.find((x) => x.socket === "rightHand")?.id ?? ""; const p = this.hold.get(k); if (p) p.rising = { from: p.raise, to: 0, t0: t, dur: e.duration ?? 0.5 }; break; }
        case "push": case "pull": case "reach": case "point": case "press": if (e.target !== undefined) this.lookAt = { target: e.target, from: t - 0.25, until: t + (e.duration ?? 1) + 0.7, fadeIn: 0.3 }; break;
        case "hesitate": this.holdUntil = t + (e.duration ?? 0.8); break;
        case "react": case "surprise": case "fear": this.expression = e.action === "fear" ? "fear" : "surprised"; this.cues.push({ kind: "impact", at: t, volume: 0.5 }); break;
        default: break;
      }
    }
  }

  /** A prop that is in the character's hand now (not one still resting in the world). */
  private inHand(socket: "rightHand" | "leftHand"): boolean { return this.props.some((p) => p.socket === socket && this.attachedAt.get(p.id) !== null); }

  /** The next thing the character will act on (to look at it while still approaching). */
  private upcomingTarget(t: number): Target | null {
    const next = this.events.find((e) => !this.startAt.has(e) && e.target !== undefined && Character3D.AFTER_ARRIVAL.has(e.action) && e.at < t + 3);
    return next?.target ?? null;
  }

  private aimAt: Target | null = null;
  // procedural inputs that can step are followed by critically damped springs (see motion.ts): the bones never jump
  private readonly leanAccel = new Damp(0, 0.35);
  // ~0.3 s: a 110-degree change of target is crossed in about half a second, like a head turn (0.2 s whipped at 14 deg/frame)
  private readonly lookYawD = new DampAngle(0, 0.3);
  private readonly lookPitchD = new Damp(0, 0.3);
  private readonly gestureD = new Map<string, Damp>();
  private aimTarget: THREE.Vector3 | null = null;
  private wasMoving = false;
  private lastSpeed = 0;

  /** Two-bone IK: put the hand at `target` with the elbow bending toward `pole` (world space). Works for any bone axes. */
  private ik(upper: THREE.Object3D | undefined, lower: THREE.Object3D | undefined, hand: THREE.Object3D | undefined, target: THREE.Vector3, pole: THREE.Vector3, w: number): void {
    if (!upper || !lower || !hand || w <= 0.001) return;
    upper.updateWorldMatrix(true, true);
    const S = upper.getWorldPosition(new THREE.Vector3()), E = lower.getWorldPosition(new THREE.Vector3()), H = hand.getWorldPosition(new THREE.Vector3());
    const a = S.distanceTo(E), b = E.distanceTo(H);
    const toT = target.clone().sub(S);
    const d = Math.min(a + b - 0.002, Math.max(Math.abs(a - b) + 0.002, toT.length()));
    const u = toT.normalize();
    const v = pole.clone().sub(u.clone().multiplyScalar(pole.dot(u))).normalize();
    const cosA = (a * a + d * d - b * b) / (2 * a * d), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const elbow = S.clone().addScaledVector(u, a * cosA).addScaledVector(v, a * sinA);
    this.aim(upper, lower, elbow.clone().sub(S), w);
    const E2 = lower.getWorldPosition(new THREE.Vector3());
    this.aim(lower, hand, S.clone().addScaledVector(u, d).sub(E2), w);
  }

  /** Advance to time t (call once per frame, in order). */
  update(t: number, dt: number): void {
    this.trigger(t);
    // --- locomotion along the active move segment (accelerate, cruise, slow down early, arrive exactly)
    const seg = this.moves.find((m) => !m.done && m.start <= t);
    let targetSpeed = 0, dir: THREE.Vector3 | null = null, backward = false, distLeft = 0;
    if (seg) {
      const to = seg.to.clone().sub(this.root.position); to.y = 0;
      distLeft = to.length();
      if (distLeft < 0.03) { seg.done = true; }
      else {
        dir = to.normalize();
        backward = seg.mode === "back";
        const cruise = seg.mode === "run" ? this.runSpeed : seg.mode === "back" ? this.walkSpeed * 0.5 : this.walkSpeed;
        // a person slows over the last metre or two (not a car braking at the line)
        const decel = seg.mode === "run" ? 2.6 : 1.05;
        targetSpeed = Math.min(cruise, Math.sqrt(2 * decel * distLeft) + 0.04);
        // a target behind: turn first (a step or two on the spot), then walk; never walk sideways or backward into it
        if (!backward) targetSpeed *= Math.max(0.12, Math.cos(Math.min(Math.PI / 2, Math.abs(wrap(Math.atan2(dir.x, dir.z) - this.heading)))));
      }
    }
    const accel = targetSpeed > this.speed ? (seg?.mode === "run" ? 4 : 2.0) : 3.2;
    this.speed += Math.max(-accel * dt, Math.min(accel * dt, targetSpeed - this.speed));
    if (this.speed < 0.005 && !dir) this.speed = 0;
    if (dir && this.speed > 0) {
      let go = dir;
      if (!backward && distLeft > 0.5) {
        const facing = this.heading, want = Math.atan2(dir.x, dir.z), off = wrap(want - facing), lim = 0.35;
        const a = facing + Math.max(-lim, Math.min(lim, off));
        go = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      }
      this.root.position.addScaledVector(go, Math.min(this.speed * dt, this.root.position.distanceTo(seg!.to)));
    }
    const moving = this.speed > 0.12;
    if (this.wasMoving && !moving && !backward) this.arrivedAt = t;
    this.wasMoving = moving;
    const accelNow = dt > 0 ? (this.speed - this.lastSpeed) / dt : 0;
    this.lastSpeed = this.speed;

    // --- orientation: toward the movement (not when stepping back), else toward the turn target
    let want = this.heading;
    if (dir && !backward && this.speed > 0.05) want = Math.atan2(dir.x, dir.z);
    else if (this.faceTarget !== null) want = this.faceTarget;
    const err = wrap(want - this.heading);
    const maxRate = this.speed > 0.4 ? 3.0 : 4.0;
    const rate = Math.max(-maxRate, Math.min(maxRate, err * 5));
    this.turnRate += (rate - this.turnRate) * Math.min(1, dt * 6); // a turn eases in (no full-rate start)
    this.heading = wrap(this.heading + this.turnRate * dt);
    this.root.rotation.y = this.heading;

    // --- clips: locomotion state machine (cross-fades) and layered one-shots
    const was = this.lastLoco;
    const lw = this.loco.step(t, dt, this.speed, this.turnRate);
    // setting off from standing: the cycle starts at its most standing-like phase, not wherever it had run to at weight 0
    for (const kind of ["walk", "run"] as const) {
      const a = this.act[kind];
      if (a && was[kind] < 0.02 && lw[kind] >= 0.02 && was.walk + was.run < 0.05) a.time = this.startPhase[kind] * a.getClip().duration;
    }
    this.lastLoco = lw;
    const A = this.act;
    A.idle?.setEffectiveWeight(lw.idle);
    A.walk?.setEffectiveWeight(lw.walk); A.walk?.setEffectiveTimeScale(backward ? -0.75 : lw.walkRate);
    if (A.run) { A.run.setEffectiveWeight(lw.run); A.run.setEffectiveTimeScale(lw.runRate); }
    else if (lw.run > 0 && A.walk) A.walk.setEffectiveWeight(lw.walk + lw.run);
    // a layered one-shot takes exactly `influence` of the pose: its weight is set against the sum of the weights it shares
    // the bones with (a bare k/(1-k) against unknown competitors packed most of a 0.25 s fade into its last 3 frames)
    let base = lw.idle + lw.walk + lw.run;
    for (const g of this.gestures) { const k = Math.min(0.95, Math.max(0, g.w)); base += k / (1 - k); }
    const layer = (a: THREE.AnimationAction | undefined, influence: number, restartAt?: number): void => {
      if (!a) return;
      if (restartAt !== undefined && t >= restartAt && t - dt < restartAt) { a.reset(); a.play(); }
      const k = Math.min(0.985, Math.max(0, influence));
      a.setEffectiveWeight((k / (1 - k)) * Math.max(1, base));
    };
    let wave = 0, interact = 0, react = 0, interactStart: number | undefined, reactStart: number | undefined;
    for (const e of this.events) {
      const s0 = this.eventStart(e);
      if (s0 === undefined) continue;
      if (e.action === "wave") wave = Math.max(wave, env(t, s0, e.duration ?? 1.6, 0.35, 0.45));
      if (e.action === "pull") { const w = env(t, s0, e.duration ?? 0.9, 0.2, 0.4); if (w > interact) { interact = w; interactStart = s0; } }
      if (e.action === "react" || e.action === "surprise") { const w = env(t, s0 + 0.12, Math.max(0.45, e.duration ?? 0.6), 0.08, 0.6); if (w > react) { react = w; reactStart = s0 + 0.12; } }
    }
    // conversation gestures: the talking clip that fits the line's mood while this character speaks, a listening clip while
    // someone else in the shot speaks; softened while walking (the arms swing), eased in and out
    if (this.gestures.length) {
      const sp = FaceRig.speaking(this.spec.speech, t);
      const lineIx = sp.line ? (this.spec.speech ?? []).indexOf(sp.line) : -1;
      const near = (ws: { at: number; duration: number }[] | undefined): boolean => (ws ?? []).some((w) => t >= w.at - 0.25 && t <= w.at + w.duration + 0.35);
      const talking = near(this.spec.speech), listening = !talking && near(this.spec.listen);
      const mood = this.exprAt(t);
      const pick = (kind: "talk" | "listen"): string | undefined => {
        const names = this.gestures.filter((g) => g.kind === kind).map((g) => g.name);
        const want = mood === "sad" || mood === "worried" ? /sad/i : mood === "happy" || mood === "surprised" || mood === "angry" ? /excited|angry|accept/i : /neutral/i;
        const fit = names.filter((n) => want.test(n));
        const list = fit.length ? fit : names.filter((n) => /neutral/i.test(n)).length ? names.filter((n) => /neutral/i.test(n)) : names;
        return list[Math.max(0, lineIx) % Math.max(1, list.length)];
      };
      const active = talking ? pick("talk") : listening ? pick("listen") : undefined;
      const moving = Math.min(1, lw.walk + lw.run);
      for (const g of this.gestures) {
        const want = g.name === active ? (g.kind === "talk" ? 0.85 : 0.7) * (1 - 0.7 * moving) : 0;
        let d = this.gestureD.get(g.name);
        if (!d) { d = new Damp(0, 0.5); this.gestureD.set(g.name, d); }
        g.w = Math.max(0, d.step(want, dt));
        const k = Math.min(0.95, Math.max(0, g.w));
        g.action.setEffectiveWeight(k / (1 - k));
      }
    }
    base = lw.idle + lw.walk + lw.run;
    for (const g of this.gestures) { const k = Math.min(0.95, Math.max(0, g.w)); base += k / (1 - k); }
    layer(A.wave, wave);
    layer(A.interact, interact * 0.85, interactStart);
    layer(A.react, react * 0.7, reactStart);
    // start from the pose the mixer produced last frame (not the rest pose): three.js only writes a bone when its blended
    // value changed since the previous frame, so a bone a clip holds perfectly still would otherwise be left at rest for a
    // frame (measured: the low-poly walk's Body bone snapped 27 degrees). Procedural offsets never accumulate either way.
    for (const [b, q] of this.base) b.quaternion.copy(q);
    this.mixer.update(dt);
    for (const [b, q] of this.base) q.copy(b.quaternion);
    this.root.updateMatrixWorld(true);

    // footsteps: a cue whenever a locomotion clip passes a foot-contact phase
    for (const kind of ["walk", "run"] as const) {
      const a = A[kind], w = kind === "walk" ? lw.walk : lw.run;
      if (!a) continue;
      const ph = ((a.time / a.getClip().duration) % 1 + 1) % 1;
      if (w > 0.35 && this.speed > 0.15) for (const c of this.contacts[kind]) {
        const prev = this.lastPhase[kind];
        if ((prev <= c && ph > c) || (prev > ph && (c >= prev || c < ph))) this.cues.push({ kind: "footsteps", at: t, volume: kind === "run" ? 0.6 : 0.45 });
      }
      this.lastPhase[kind] = ph;
    }

    // ===== acting layer (procedural, over the clips) =====
    const B = this.bones;
    const idle = Math.max(0, lw.idle - lw.walk * 0.5);
    // idle life: breathing, a slow weight shift from foot to foot, small head drift
    const breath = Math.sin((2 * Math.PI * t) / 3.6);
    this.turnBone(B.chest, 0, 0.018 * breath * idle, 0);
    this.turnBone(B.hips, 0.03 * Math.sin(t * 0.55) * idle, 0, 0.035 * Math.sin(t * 0.55 + 0.4) * idle);
    this.turnBone(B.spine, -0.02 * Math.sin(t * 0.55) * idle, 0, -0.03 * Math.sin(t * 0.55 + 0.4) * idle);
    this.turnBone(B.head, 0.05 * Math.sin(t * 0.37 + 1) * idle, 0.02 * Math.sin(t * 0.29) * idle, 0);
    // walking: a little lean into acceleration, back on braking; settle after the stop (hips dip, spine overshoots and returns)
    const lean = 0.05 * lw.walk + 0.13 * lw.run + Math.max(-0.08, Math.min(0.08, this.leanAccel.step(accelNow, dt) * 0.035));
    this.turnBone(B.spine, 0, lean, 0);
    if (this.arrivedAt !== null) {
      const u = t - this.arrivedAt;
      if (u >= 0 && u < 1.2) { const k = Math.exp(-u * 4.2) * Math.sin(u * 9); this.turnBone(B.spine, 0, 0.07 * k, 0); this.turnBone(B.head, 0, -0.05 * k, 0); }
    }

    // anticipation + action timing for hand actions
    let push = 0, pushPre = 0, startle = 0, headJerk = 0, pullBack = 0, hesit = 0, adjust = 0, reachW = 0;
    let reachTarget: Target | undefined, reachKind: Action3D = "reach";
    for (const e of this.events) {
      const s0 = this.eventStart(e);
      if (s0 === undefined) continue;
      const u = t - s0;
      if (e.action === "push") { push = Math.max(push, env(t, s0 + 0.18, e.duration ?? 0.9, 0.22, 0.45)); pushPre = Math.max(pushPre, u >= 0 && u < 0.25 ? Math.sin((u / 0.25) * Math.PI) : 0); }
      if (e.action === "hesitate") hesit = Math.max(hesit, env(t, s0, (e.duration ?? 0.8) - 0.2, 0.2, 0.3));
      if (e.action === "adjust") adjust = Math.max(adjust, u >= 0 && u < 0.6 ? Math.sin((u / 0.6) * Math.PI) * (u < 0.3 ? 1 : 0.6) : 0);
      if (e.action === "reach" || e.action === "press" || e.action === "point") { const w = env(t, s0 + 0.1, e.duration ?? (e.action === "press" ? 0.5 : 0.9), 0.3, 0.4); if (w > reachW) { reachW = w; reachTarget = e.target; reachKind = e.action; } }
      if (e.action === "react" || e.action === "surprise" || e.action === "fear") {
        // the head reacts first, then the torso pulls back, then the step (step-back event); it all settles over a second
        const rise = e.action === "surprise" ? 0.16 : 0.07;
        headJerk = Math.max(headJerk, u >= 0 ? smooth(u / rise) * Math.exp(-Math.max(0, u - rise) * 2.2) : 0);
        pullBack = Math.max(pullBack, u >= 0.08 ? smooth((u - 0.08) / 0.22) * Math.exp(-Math.max(0, u - 0.3) * 1.3) : 0);
        startle = Math.max(startle, env(t, s0, e.duration ?? 0.8, 0.08, 0.9));
      }
    }
    // reaching for something low (a parcel on a crate) bends the upper body toward it
    let lowBend = 0;
    if (reachW > 0.01 && reachTarget !== undefined) {
      const tp = this.world.resolve(reachTarget), ch = (B.chest ?? this.root).getWorldPosition(new THREE.Vector3());
      if (tp) lowBend = reachW * Math.min(1, Math.max(0, (ch.y - tp.y - 0.25 * this.height / 1.8) / (0.7 * this.height / 1.8)));
    }
    this.turnBone(B.spine, 0, -0.05 * pushPre + 0.1 * push - 0.16 * pullBack - 0.05 * hesit + 0.04 * reachW + 0.28 * lowBend, 0);
    if (lowBend > 0) this.turnBone(B.chest, 0, 0.16 * lowBend, 0);
    this.turnBone(B.head, 0, 0.08 * hesit, 0.05 * hesit); // a hesitation: weight back, head lowered and tilted
    this.turnBone(B.chest, 0, -0.1 * pullBack, 0);
    this.turnBone(B.head, 0, -0.22 * headJerk, 0);
    // listening gestures: a nod (two dips of the head) and a head shake (three swings), eased in and out
    for (const e of this.events) {
      const s0 = this.eventStart(e);
      if (s0 === undefined || (e.action !== "nod" && e.action !== "shake-head")) continue;
      const d = e.duration ?? (e.action === "nod" ? 1.0 : 1.2), u = t - s0;
      if (u < 0 || u > d) continue;
      const w = Math.sin((u / d) * Math.PI); // 0 -> 1 -> 0, no step at either end
      if (e.action === "nod") { const p = 0.13 * w * Math.sin((u / d) * 4 * Math.PI); this.turnBone(B.neck, 0, p * 0.4, 0); this.turnBone(B.head, 0, p * 0.6, 0); }
      else { const y = 0.2 * w * Math.sin((u / d) * 5 * Math.PI); this.turnBone(B.neck, y * 0.4, 0, 0); this.turnBone(B.head, y * 0.6, 0, 0); }
    }
    const fearPosture = this.expression === "fear" || this.expression === "worried" ? 1 : 0;
    this.turnBone(B.spine, 0, -0.05 * fearPosture * (1 - startle), 0);

    // looking: at a target (incl. the next thing it will act on while approaching), or scanning around; head leads the chest
    let lookYaw = 0, lookPitch = 0, lookW = 0;
    if (this.lookAround && t >= this.lookAround.from && t <= this.lookAround.until + 0.5) {
      const u = t - this.lookAround.from, w = env(t, this.lookAround.from, this.lookAround.until - this.lookAround.from, 0.4, 0.5);
      // look one way, hold, look the other way: discrete glances read better than a smooth sweep
      const glance = Math.tanh(Math.sin(u * 1.6) * 3);
      lookYaw = 0.6 * glance * w; lookPitch = 0.06 * Math.sin(u * 0.9 + 1) * w; lookW = w;
    }
    let lookTarget: Target | null = this.lookAt && t >= this.lookAt.from && t <= this.lookAt.until + 0.6 ? this.lookAt.target : null;
    let lw2 = lookTarget ? env(t, this.lookAt!.from, this.lookAt!.until - this.lookAt!.from, this.lookAt!.fadeIn, 0.6) : 0;
    const next = this.upcomingTarget(t);
    if (!lookTarget && next && seg && distLeft < 3) { lookTarget = next; lw2 = Math.min(1, (3 - distLeft) / 1.5); }
    if (lookTarget) {
      const p = this.world.resolve(lookTarget);
      if (p) {
        const head = (B.head ?? this.root).getWorldPosition(new THREE.Vector3());
        const d = p.clone().sub(head);
        const yaw = wrap(Math.atan2(d.x, d.z) - this.heading), pitch = -Math.atan2(d.y, Math.hypot(d.x, d.z));
        lookYaw = lookYaw * (1 - lw2) + Math.max(-1.3, Math.min(1.3, yaw)) * lw2;
        lookPitch = lookPitch * (1 - lw2) + Math.max(-0.5, Math.min(0.45, pitch)) * lw2; lookW = Math.max(lookW, lw2);
      }
    }
    if (this.aimAt !== null) this.aimTarget = this.world.resolve(this.aimAt);
    // the head turns before the body: while turning, the neck already looks where the body is going
    const lead = Math.max(-0.5, Math.min(0.5, err)) * 0.6;
    lookYaw += lead * (1 - lookW);
    // a new target / a turn that starts makes these inputs step: the head follows them like a head does (eases in, no snap)
    lookYaw = this.lookYawD.step(lookYaw, dt); lookPitch = this.lookPitchD.step(lookPitch, dt);
    this.terms = { lookYaw, lookPitch, lookW, lead, err, headJerk, pullBack, startle, wave, reachW, push, speed: this.speed, turnRate: this.turnRate, ...Object.fromEntries(this.gestures.map((g) => [`g:${g.name}`, g.w])) };
    if (Math.abs(lookYaw) + Math.abs(lookPitch) > 1e-4) {
      this.turnBone(B.chest, lookYaw * 0.22, 0, 0);
      this.turnBone(B.neck, lookYaw * 0.33, lookPitch * 0.4, 0);
      this.turnBone(B.head, lookYaw * 0.45, lookPitch * 0.6, 0);
    }

    // hands: props are held and aimed with two-bone IK (elbow bent, hand where it should be); push puts both hands on the door
    const up = new THREE.Vector3(0, 1, 0), f = this.fwd();
    const right = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading)).multiplyScalar(-1); // character's right
    const chest = (B.chest ?? this.root).getWorldPosition(new THREE.Vector3());
    const hipsP = (B.hips ?? this.root).getWorldPosition(new THREE.Vector3());
    const H = this.height;
    const swingDamp = 1 - Math.min(1, lw.walk + lw.run) * 0.55;
    for (const p of this.props) {
      const h = this.hold.get(p.id)!;
      if (h.rising) { const u = smooth((t - h.rising.t0) / h.rising.dur); h.raise = h.rising.from + (h.rising.to - h.rising.from) * u; if (u >= 1) h.rising = null; }
      if (p.socket !== "rightHand" && p.socket !== "leftHand") continue;
      const since = this.attachedAt.get(p.id);
      if (since === null || since === undefined) continue; // still resting where it was put
      const R = p.socket === "rightHand", side = R ? right : right.clone().negate();
      const upper = R ? B.upperArmR : B.upperArmL, lower = R ? B.lowerArmR : B.lowerArmL, hand = R ? B.handR : B.handL;
      // carried: hand at the hip, a little forward, elbow relaxed; raised: hand in front of the chest toward the target, elbow bent
      const holdPos = hipsP.clone().addScaledVector(side, 0.17 * H / 1.8).addScaledVector(f, 0.16 * H / 1.8).addScaledVector(up, 0.02);
      const tgt = this.aimTarget ?? chest.clone().addScaledVector(f, 4);
      const aimDir = tgt.clone().sub(chest).normalize();
      // a comfortable arm's length with the elbow bent, never past the target itself (a parcel looked at up close)
      const reach = Math.min(0.42 * H / 1.8, tgt.distanceTo(chest) * 0.85);
      const raisePos = chest.clone().addScaledVector(side, 0.12 * H / 1.8).addScaledVector(up, -0.06).addScaledVector(aimDir, reach);
      // a startle jolts the hand (the torch beam swings) and pulls it in
      const jolt = new THREE.Vector3(Math.sin(t * 31) * 0.04, Math.sin(t * 23 + 1) * 0.05, 0).multiplyScalar(startle).addScaledVector(f, -0.12 * pullBack);
      // a carried box sits in front of the belly; "adjust" hitches it up and it settles back
      if (p.kind === "box") holdPos.addScaledVector(f, 0.2).addScaledVector(up, 0.3).addScaledVector(side, -0.14);
      const pos = holdPos.lerp(raisePos, h.raise).add(jolt).addScaledVector(up, 0.07 * adjust);
      const pole = new THREE.Vector3().addScaledVector(side, 0.8).addScaledVector(up, -0.6).addScaledVector(f, -0.25);
      // just picked up: the hand travels from where it took the prop to the carry position
      const grab = smooth((t - since) / 0.55);
      this.ik(upper, lower, hand, pos, pole, 0.95 * Math.max(swingDamp, h.raise) * grab);
      p.aimDir = h.raise > 0.3 ? aimDir.clone().addScaledVector(new THREE.Vector3(Math.sin(t * 29), Math.sin(t * 19), 0), 0.12 * startle).normalize() : null;
      p.aimWeight = h.raise;
    }
    // push: the free hand(s) on the door
    if (push > 0.01) {
      const door = this.lookAt ? this.world.resolve(this.lookAt.target) : null;
      const handFree = this.inHand("rightHand") ? "L" : "R";
      const target = door ?? chest.clone().addScaledVector(f, 0.55);
      const side = handFree === "R" ? right : right.clone().negate();
      const pole = new THREE.Vector3().addScaledVector(side, 0.7).addScaledVector(up, -0.7);
      if (handFree === "L") this.ik(B.upperArmL, B.lowerArmL, B.handL, target, pole, push);
      else this.ik(B.upperArmR, B.lowerArmR, B.handR, target, pole, push);
    }
    // reach / press / point with the free hand: the hand goes to the target (press: the fingertip on the button)
    if (reachW > 0.01 && reachTarget !== undefined) {
      const tp = this.world.resolve(reachTarget);
      // the hand that will take a resting prop does the reaching; otherwise the free hand
      const resting = this.props.find((p) => this.attachedAt.get(p.id) === null && (p.socket === "rightHand" || p.socket === "leftHand"));
      const freeR = resting ? resting.socket === "rightHand" : !this.inHand("rightHand");
      if (tp) {
        const sh = ((freeR ? B.upperArmR : B.upperArmL) ?? this.root).getWorldPosition(new THREE.Vector3());
        let goal = tp.clone();
        if (reachKind === "point" || sh.distanceTo(tp) > 0.62 * H / 1.8) goal = sh.clone().addScaledVector(tp.clone().sub(sh).normalize(), Math.min(sh.distanceTo(tp), 0.6 * H / 1.8));
        const side = freeR ? right : right.clone().negate();
        const pole = new THREE.Vector3().addScaledVector(side, 0.8).addScaledVector(up, -0.7);
        if (freeR) this.ik(B.upperArmR, B.lowerArmR, B.handR, goal, pole, reachW); else this.ik(B.upperArmL, B.lowerArmL, B.handL, goal, pole, reachW);
      }
    }
    // a startle lifts the free arm defensively
    if (pullBack > 0.01 && !this.inHand("leftHand")) {
      const target = chest.clone().addScaledVector(f, 0.25).addScaledVector(up, 0.12).addScaledVector(right, -0.15);
      this.ik(B.upperArmL, B.lowerArmL, B.handL, target, new THREE.Vector3().addScaledVector(right, -0.8).addScaledVector(up, -0.5), 0.8 * pullBack);
    }

    for (const p of this.props) {
      const since = this.attachedAt.get(p.id), rest = this.restPose.get(p.id);
      if (since === null && rest) { p.object.position.copy(rest.position); p.object.quaternion.copy(rest.quaternion); p.object.updateMatrixWorld(true); continue; }
      placeProp(p, this.sockets(p.socket === "leftHand" ? "L" : "R"));
      // the moment it is taken it is still where it lay: blend into the grip instead of popping
      if (rest && since !== null && since !== undefined && t - since < 0.3) {
        const k = smooth((t - since) / 0.3);
        p.object.position.lerpVectors(rest.position, p.object.position, k); p.object.quaternion.slerpQuaternions(rest.quaternion, p.object.quaternion.clone(), k); p.object.updateMatrixWorld(true);
      }
      // a box that was picked up is steadied by the other hand when that hand has nothing else to do
      if (p.kind === "box" && rest && since !== null && since !== undefined && (p.socket === "rightHand" || p.socket === "leftHand")) {
        const otherR = p.socket === "leftHand", busy = this.inHand(otherR ? "rightHand" : "leftHand") || push > 0.01 || pullBack > 0.01;
        if (!busy) {
          const sideO = otherR ? right : right.clone().negate();
          const target = p.object.position.clone().add(new THREE.Vector3(0.12, 0, 0).applyQuaternion(p.object.quaternion)).addScaledVector(sideO, 0.17).addScaledVector(up, -0.03);
          const pole = new THREE.Vector3().addScaledVector(sideO, 0.8).addScaledVector(up, -0.6).addScaledVector(f, -0.2);
          const w = 0.9 * smooth((t - since - 0.25) / 0.5) * (1 - reachW);
          if (otherR) this.ik(B.upperArmR, B.lowerArmR, B.handR, target, pole, w); else this.ik(B.upperArmL, B.lowerArmL, B.handL, target, pole, w);
        }
      }
    }
    // foot locking (only while the body moves slowly: setting off, stopping, stepping round; at cruise the calibrated clip
    // already keeps the planted foot still). Engage and release are eased: the IK never pops the leg
    const slow = (this.speed < this.walkSpeed * 0.75 || lw.walk < 0.92) && lw.run < 0.05;
    for (const ft of this.feet) {
      const foot = B[`foot${ft.side}`]!, F = foot.getWorldPosition(new THREE.Vector3());
      const down = F.y <= ft.restY + 0.025 * this.height / 1.8;
      // a new lock only while slow; a foot already locked stays put until the clip lifts it (toe-off), so letting go
      // happens as the foot rises anyway, never while it is flat on the ground
      if (slow && down && !ft.lock) ft.lock = F.clone();
      const engaged = !!ft.lock && down && F.distanceTo(ft.lock) < 0.22 * this.height / 1.8;
      const w = ft.w.step(engaged ? 1 : 0, dt);
      if (ft.lock && w > 0.001) {
        const knee = this.fwd().add(new THREE.Vector3(0, 0.15, 0));
        this.ik(B[`upperLeg${ft.side}`], B[`lowerLeg${ft.side}`], foot, ft.lock, knee, w);
      }
      if (!engaged && w < 0.02) ft.lock = null;
    }
    // contact shadow between the feet, a little wider when the stride is long
    if (B.footL && B.footR) {
      const a = B.footL.getWorldPosition(new THREE.Vector3()), b2 = B.footR.getWorldPosition(new THREE.Vector3());
      const mid = a.clone().add(b2).multiplyScalar(0.5);
      this.contact.position.set(mid.x - this.root.position.x, 0.012, mid.z - this.root.position.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.heading);
      const spread = a.distanceTo(b2);
      this.contact.scale.set(1 + spread * 0.4, 1 + spread * 0.9, 1);
    }
    // a light prop switches on when raised (unless the shot says otherwise)
    for (const p of this.props) if (p.kind === "flashlight") {
      const on = [...this.startAt.entries()].some(([e, s0]) => e.action === "raise" && (e.prop === undefined || e.prop === p.id) && t >= s0 + 0.25);
      p.setOn(on ? 1 - 0.25 * startle * (Math.sin(t * 60) > 0 ? 1 : 0) : 0);
    }
    // the face: lips on the voice, the expression of the moment, blinks
    const face = this.face.update(t, dt, this.spec.speech, this.exprAt(t));
    if (face.talking) { this.faceStats.talkingFrames++; this.faceStats.maxOpen = Math.max(this.faceStats.maxOpen, face.open); }
  }

  /** The expression at shot time t: the line being spoken, else the latest change, else the shot's. */
  exprAt(t: number): Expression {
    const sp = FaceRig.speaking(this.spec.speech, t);
    if (sp.line?.expression) return sp.line.expression;
    let e: Expression = this.expression;
    for (const x of this.spec.expressions ?? []) if (x.at <= t) e = x.expression;
    return e;
  }

  /** The procedural layer's inputs on the last frame (diagnostics: what drove the pose). */
  terms: Record<string, number> = {};
  /** Current locomotion weights (for tests / logs). */
  get locomotion(): LocoWeights { return this.lastLoco; }
  get currentSpeed(): number { return this.speed; }
  get currentHeading(): number { return this.heading; }
  /** World point of the head (camera framing) and of the chest. */
  headPosition(): THREE.Vector3 { return (this.bones.head ?? this.root).getWorldPosition(new THREE.Vector3()); }
  /** Sets an expression. Uses morph targets when the model has them (by name), else the posture layer above only. */
  setExpression(e: Expression): void {
    this.expression = e;
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.morphTargetDictionary || !m.morphTargetInfluences) return;
      for (const [name, i] of Object.entries(m.morphTargetDictionary)) m.morphTargetInfluences[i] = name.toLowerCase().includes(e) ? 1 : 0;
    });
  }
}
