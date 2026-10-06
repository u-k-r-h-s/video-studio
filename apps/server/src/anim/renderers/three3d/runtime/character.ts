import * as THREE from "three";
import type { CharacterEvent3D, CharacterSpec3D, Cue3D, Expression, Target } from "../spec";
import { LocomotionStateMachine, type LocoWeights } from "./locomotion";
import { makeProp, placeProp, type Prop3D } from "./props";
import { chainMotion, findBones, findClips, inPlace, maskClip, type BoneRole, type ClipRole } from "./rig";

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
  expression: Expression = "neutral";
  /** Calibrated ground speed of the walk / run clips (m/s): the feet do not slide. */
  readonly walkSpeed: number;
  readonly runSpeed: number;
  private readonly act: Partial<Record<"idle" | "walk" | "run" | "wave" | "interact" | "react", THREE.AnimationAction>> = {};
  private readonly events: CharacterEvent3D[];
  private heading: number;
  private turnRate = 0;
  private faceTarget: number | null = null;
  private lookAt: { target: Target; from: number; until: number } | null = null;
  private lookAround: { from: number; until: number } | null = null;
  private moves: MoveSeg[] = [];
  private speed = 0;
  private lastLoco: LocoWeights = { idle: 1, walk: 0, run: 0, walkRate: 1, runRate: 1 };
  private contacts: { walk: number[]; run: number[] } = { walk: [0, 0.5], run: [0, 0.5] };
  private lastPhase = { walk: 0, run: 0 };
  private readonly rest: [THREE.Object3D, THREE.Quaternion][] = [];
  private hold = new Map<string, { raise: number; rising: { from: number; to: number; t0: number; dur: number } | null }>();

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
    this.root.add(this.model);
    this.root.name = `character:${spec.id}`;
    this.model.updateMatrixWorld(true);
    // make the root's +Z the character's forward (from the foot: the toe is in front of the ankle)
    const foot = this.bones.footR ?? this.bones.footL;
    const toe = foot?.children.find((c) => (c as THREE.Bone).isBone);
    if (foot && toe) {
      const a = foot.getWorldPosition(new THREE.Vector3()), b = toe.getWorldPosition(new THREE.Vector3());
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      if (Math.abs(b.x - a.x) + Math.abs(b.z - a.z) > 1e-4) this.model.rotation.y -= yaw;
    }
    const box = new THREE.Box3().setFromObject(this.model);
    this.height = box.max.y - box.min.y;

    // rest pose of every bone: procedural layers are applied on top of the clips each frame, and a bone no clip animates
    // must go back to rest first, or the layers would accumulate from frame to frame
    this.model.traverse((o) => { if ((o as THREE.Bone).isBone) this.rest.push([o, o.quaternion.clone()]); });
    this.mixer = new THREE.AnimationMixer(this.model);
    const hips = this.bones.hips;
    const add = (key: keyof Character3D["act"], clip: THREE.AnimationClip | undefined, loop = true): void => {
      if (!clip) return;
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
    this.act.idle!.setEffectiveWeight(1);
    this.walkSpeed = this.calibrate("walk") ?? 1.35;
    this.runSpeed = this.clips.run ? this.calibrate("run") ?? 3.6 : this.walkSpeed * 2.4;
    this.loco = new LocomotionStateMachine({ walkSpeed: this.walkSpeed, runSpeed: this.runSpeed });

    for (const ps of spec.props ?? []) { const p = makeProp(ps); this.props.push(p); this.hold.set(p.id, { raise: 0, rising: null }); }
    this.events = [...spec.events].sort((a, b) => a.at - b.at);
    this.root.position.set(spec.start.x, 0, spec.start.z);
    const h = spec.start.heading;
    this.heading = typeof h === "number" ? h : h !== undefined ? this.headingTo(h) ?? 0 : 0;
    this.root.rotation.y = this.heading;
    this.expression = spec.expression ?? "neutral";
  }

  /** Ground speed of a locomotion clip, measured from how far a foot travels relative to the hips over one cycle. */
  private calibrate(kind: "walk" | "run"): number | null {
    const clip = this.clips[kind], foot = this.bones.footR, footL = this.bones.footL, hips = this.bones.hips;
    if (!clip || !foot || !hips) return null;
    const m = new THREE.AnimationMixer(this.model), a = m.clipAction(clip);
    a.play();
    let zmin = Infinity, zmax = -Infinity;
    const N = 48, heights: number[] = [], heightsL: number[] = [];
    const inv = new THREE.Matrix4();
    for (let i = 0; i < N; i++) {
      m.setTime((i / N) * clip.duration);
      this.model.updateMatrixWorld(true);
      inv.copy(this.model.matrixWorld).invert();
      const p = foot.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
      heights.push(p.y);
      if (footL) heightsL.push(footL.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).y);
      zmin = Math.min(zmin, p.z); zmax = Math.max(zmax, p.z);
    }
    m.stopAllAction(); m.uncacheRoot(this.model);
    this.model.updateMatrixWorld(true);
    // foot contact phases: where each foot is lowest
    const low = (h: number[]): number => h.indexOf(Math.min(...h)) / N;
    this.contacts[kind] = [low(heights), heightsL.length ? low(heightsL) : (low(heights) + 0.5) % 1];
    const scale = this.model.getWorldScale(new THREE.Vector3()).z;
    const stride = (zmax - zmin) * scale; // one foot's travel = one step length
    const speed = (2 * stride) / clip.duration;
    return speed > 0.2 && speed < 9 ? speed : null;
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

  /** Start events whose time has come (once). */
  private started = new Set<CharacterEvent3D>();
  private trigger(t: number): void {
    for (const e of this.events) {
      if (e.at > t || this.started.has(e)) continue;
      this.started.add(e);
      switch (e.action) {
        case "walk": case "run": {
          const p = e.target !== undefined ? this.world.resolve(e.target) : null;
          if (p) this.moves.push({ start: e.at, to: new THREE.Vector3(p.x, 0, p.z), mode: e.action, done: false });
          break;
        }
        case "step-back": {
          const d = (e.duration ?? 0.9) * this.walkSpeed * 0.55;
          this.moves.push({ start: e.at, to: this.root.position.clone().addScaledVector(this.fwd(), -d), mode: "back", done: false });
          break;
        }
        case "stop": for (const m of this.moves) m.done = true; break;
        case "turn": this.faceTarget = e.target !== undefined ? this.headingTo(e.target) : null; break;
        case "look": this.lookAt = { target: e.target ?? "camera", from: e.at, until: e.at + (e.duration ?? 1.5) }; break;
        case "look-around": this.lookAround = { from: e.at, until: e.at + (e.duration ?? 2) }; break;
        case "hold": { const p = this.hold.get(e.prop ?? this.props[0]?.id ?? ""); if (p) p.rising = { from: p.raise, to: 0, t0: e.at, dur: 0.01 }; break; }
        case "raise": { const k = e.prop ?? this.props.find((x) => x.socket === "rightHand")?.id ?? ""; const p = this.hold.get(k); if (p) p.rising = { from: p.raise, to: 1, t0: e.at, dur: e.duration ?? 0.55 }; if (e.target !== undefined) this.lookAt = { target: e.target, from: e.at, until: e.at + 30 }; break; }
        case "lower": { const k = e.prop ?? this.props.find((x) => x.socket === "rightHand")?.id ?? ""; const p = this.hold.get(k); if (p) p.rising = { from: p.raise, to: 0, t0: e.at, dur: e.duration ?? 0.5 }; break; }
        case "react": case "surprise": case "fear": this.expression = e.action === "react" ? "surprised" : e.action === "fear" ? "fear" : "surprised"; this.cues.push({ kind: "impact", at: e.at, volume: 0.5 }); break;
        default: break;
      }
    }
  }

  private aimTarget: THREE.Vector3 | null = null;
  /** Advance to time t (call once per frame, in order). */
  update(t: number, dt: number): void {
    this.trigger(t);
    // --- locomotion along the active move segment (accelerate, cruise, decelerate to arrive exactly)
    const seg = this.moves.find((m) => !m.done && m.start <= t);
    let targetSpeed = 0, dir: THREE.Vector3 | null = null, backward = false;
    if (seg) {
      const to = seg.to.clone().sub(this.root.position); to.y = 0;
      const dist = to.length();
      if (dist < 0.03) { seg.done = true; }
      else {
        dir = to.normalize();
        backward = seg.mode === "back";
        const cruise = seg.mode === "run" ? this.runSpeed : seg.mode === "back" ? this.walkSpeed * 0.55 : this.walkSpeed;
        const decel = seg.mode === "run" ? 3.2 : 1.6;
        targetSpeed = Math.min(cruise, Math.sqrt(2 * decel * dist) + 0.05);
      }
    }
    const accel = targetSpeed > this.speed ? (seg?.mode === "run" ? 4 : 2.2) : 3.5;
    this.speed += Math.max(-accel * dt, Math.min(accel * dt, targetSpeed - this.speed));
    if (this.speed < 0.005 && !dir) this.speed = 0;
    if (dir && this.speed > 0) this.root.position.addScaledVector(dir, Math.min(this.speed * dt, this.root.position.distanceTo(seg!.to)));

    // --- orientation: toward the movement (not when stepping back), else toward the turn target
    let want = this.heading;
    if (dir && !backward && this.speed > 0.05) want = Math.atan2(dir.x, dir.z);
    else if (this.faceTarget !== null) want = this.faceTarget;
    const err = wrap(want - this.heading);
    const maxRate = this.speed > 0.4 ? 3.2 : 4.5; // rad/s
    const rate = Math.max(-maxRate, Math.min(maxRate, err * 6));
    this.turnRate += (rate - this.turnRate) * Math.min(1, dt * 12);
    this.heading = wrap(this.heading + this.turnRate * dt);
    this.root.rotation.y = this.heading;

    // --- clips: locomotion state machine (cross-fades), upper-body layers
    const lw = this.loco.step(t, dt, this.speed, this.turnRate);
    this.lastLoco = lw;
    const A = this.act;
    A.idle?.setEffectiveWeight(lw.idle);
    A.walk?.setEffectiveWeight(lw.walk); A.walk?.setEffectiveTimeScale(backward ? -0.8 : lw.walkRate);
    if (A.run) { A.run.setEffectiveWeight(lw.run); A.run.setEffectiveTimeScale(lw.runRate); }
    else if (lw.run > 0 && A.walk) A.walk.setEffectiveWeight(lw.walk + lw.run);
    // one-shot / layered clips (a layer's effect = w/(1+w) over the locomotion, so a big weight overrides it)
    const layer = (a: THREE.AnimationAction | undefined, influence: number, restartAt?: number): void => {
      if (!a) return;
      if (restartAt !== undefined && t >= restartAt && t - dt < restartAt) { a.reset(); a.play(); }
      const k = Math.min(0.985, Math.max(0, influence));
      a.setEffectiveWeight(k / (1 - k));
    };
    let wave = 0, interact = 0, react = 0, interactStart: number | undefined, reactStart: number | undefined;
    for (const e of this.events) {
      if (e.action === "wave") wave = Math.max(wave, env(t, e.at, e.duration ?? 1.6));
      if (e.action === "push" || e.action === "pull" || e.action === "reach") { const w = env(t, e.at, e.duration ?? 0.9, 0.2, 0.4); if (w > interact) { interact = w; interactStart = e.at; } }
      if (e.action === "react" || e.action === "surprise") { const w = env(t, e.at, Math.max(0.5, e.duration ?? 0.6), 0.06, 0.55); if (w > react) { react = w; reactStart = e.at; } }
    }
    layer(A.wave, wave);
    layer(A.interact, interact * 0.9, interactStart);
    layer(A.react, react * 0.95, reactStart);
    for (const [b, q] of this.rest) b.quaternion.copy(q);
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);

    // footsteps: a cue whenever a locomotion clip passes a foot-contact phase
    for (const kind of ["walk", "run"] as const) {
      const a = A[kind], w = kind === "walk" ? lw.walk : lw.run;
      if (!a) continue;
      const ph = (a.time / a.getClip().duration) % 1;
      if (w > 0.35 && this.speed > 0.15) for (const c of this.contacts[kind]) {
        const prev = this.lastPhase[kind];
        if ((prev <= c && ph > c) || (prev > ph && (c >= prev || c < ph))) this.cues.push({ kind: "footsteps", at: t, volume: kind === "run" ? 0.6 : 0.45 });
      }
      this.lastPhase[kind] = ph;
    }

    // --- procedural layers (after the clips)
    const B = this.bones;
    // posture from the expression / reaction: shoulders up, weight back, head pulled in
    const fear = this.expression === "fear" || this.expression === "worried" ? 1 : 0;
    const startle = this.events.filter((e) => e.action === "react" || e.action === "surprise" || e.action === "fear").reduce((m, e) => Math.max(m, env(t, e.at, e.duration ?? 0.8, 0.08, 0.9)), 0);
    this.turnBone(B.spine, 0, -0.1 * Math.max(fear * 0.5, startle), 0);
    this.turnBone(B.chest, 0, -0.08 * startle, 0);
    // leaning into a run / a push
    const lean = 0.12 * lw.run + 0.05 * lw.walk + 0.14 * interact;
    this.turnBone(B.spine, 0, lean, 0);

    // looking: at a target, or around (scanning), with the head leading the neck
    let lookYaw = 0, lookPitch = 0, lookW = 0;
    if (this.lookAround && t >= this.lookAround.from && t <= this.lookAround.until + 0.5) {
      const u = t - this.lookAround.from, w = env(t, this.lookAround.from, this.lookAround.until - this.lookAround.from, 0.4, 0.5);
      lookYaw = 0.75 * Math.sin(u * 1.7) * w; lookPitch = 0.08 * Math.sin(u * 0.9 + 1) * w; lookW = w;
    }
    if (this.lookAt && t >= this.lookAt.from && t <= this.lookAt.until + 0.6) {
      const p = this.world.resolve(this.lookAt.target);
      if (p) {
        const head = (B.head ?? this.root).getWorldPosition(new THREE.Vector3());
        const d = p.clone().sub(head);
        const yaw = wrap(Math.atan2(d.x, d.z) - this.heading), pitch = -Math.atan2(d.y, Math.hypot(d.x, d.z));
        const w = env(t, this.lookAt.from, this.lookAt.until - this.lookAt.from, 0.35, 0.6);
        lookYaw = lookYaw * (1 - w) + Math.max(-1.2, Math.min(1.2, yaw)) * w;
        lookPitch = lookPitch * (1 - w) + Math.max(-0.5, Math.min(0.45, pitch)) * w; lookW = Math.max(lookW, w);
        this.aimTarget = p;
      }
    }
    if (lookW > 0) {
      this.turnBone(B.chest, lookYaw * 0.25, 0, 0);
      this.turnBone(B.neck, lookYaw * 0.3, lookPitch * 0.4, 0);
      this.turnBone(B.head, lookYaw * 0.45, lookPitch * 0.6, 0);
    }

    // props: hold low in front / raise and aim along the line of sight, then place every prop at its socket
    for (const p of this.props) {
      const h = this.hold.get(p.id)!;
      if (h.rising) { const u = smooth((t - h.rising.t0) / h.rising.dur); h.raise = h.rising.from + (h.rising.to - h.rising.from) * u; if (u >= 1) h.rising = null; }
      if (p.socket === "rightHand" || p.socket === "leftHand") {
        const R = p.socket === "rightHand";
        const upper = R ? B.upperArmR : B.upperArmL, lower = R ? B.lowerArmR : B.lowerArmL, hand = R ? B.handR : B.handL;
        const f = this.fwd(), side = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading)).multiplyScalar(R ? -1 : 1);
        // holding: upper arm hangs slightly forward, forearm points forward-down (the torch lights the ground ahead)
        const holdUpper = new THREE.Vector3(0, -1, 0).addScaledVector(f, 0.25).addScaledVector(side, 0.12);
        const holdLower = new THREE.Vector3(0, -0.55, 0).add(f).addScaledVector(side, -0.15);
        // raised: the whole arm points at the aim target (or straight ahead)
        const shoulder = (upper ?? this.root).getWorldPosition(new THREE.Vector3());
        const aimDir = this.aimTarget ? this.aimTarget.clone().sub(shoulder).normalize() : f.clone().add(new THREE.Vector3(0, -0.1, 0)).normalize();
        const r = h.raise, swing = 1 - Math.min(1, lw.walk + lw.run) * 0.5;
        // a raised arm is not a rod: the upper arm stays a little below the line of sight, the elbow bends slightly,
        // the forearm carries the aim (that is how people hold a torch up)
        const upAim = aimDir.clone().add(new THREE.Vector3(0, -0.42, 0)).addScaledVector(side, 0.18).normalize();
        const uDir = holdUpper.clone().lerp(upAim, r);
        const lDir = holdLower.clone().lerp(aimDir, r);
        // the chest turns a little toward what the torch points at
        if (r > 0.01) { const yaw = wrap(Math.atan2(aimDir.x, aimDir.z) - this.heading); this.turnBone(B.chest, Math.max(-0.5, Math.min(0.5, yaw)) * 0.35 * r, 0, 0); }
        this.aim(upper, lower, uDir, 0.92 * swing + 0.08);
        this.aim(lower, hand, lDir, 0.95);
      }
      placeProp(p, this.sockets(p.socket === "leftHand" ? "L" : "R"));
    }
    // a light prop switches on when raised (unless the shot says otherwise)
    for (const p of this.props) if (p.kind === "flashlight") {
      const evOn = this.events.filter((e) => (e.action === "raise") && (e.prop === undefined || e.prop === p.id)).some((e) => t >= e.at + 0.2);
      const flick = this.events.some((e) => e.action === "react" && t > e.at && t < e.at + 0.35) ? (Math.sin(t * 70) > 0 ? 1 : 0.35) : 1;
      p.setOn(evOn ? flick : 0);
    }
  }

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
