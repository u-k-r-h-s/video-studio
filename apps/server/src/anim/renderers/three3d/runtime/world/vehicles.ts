import * as THREE from "three";
import { mulberry } from "./noise";
import { buildVehicle, Kit, type VehicleKind, type VehicleModel } from "./vehicle-models";
import { vehicleFx, type FxOptions } from "./vehicle-fx";

/**
 * Vehicles as actors: original procedural models (car, auto-rickshaw, bus, scooter and motorcycle with riders, bicycle with
 * a pedalling rider) that drive along lanes.
 *
 * Motion: every lane runs the Intelligent Driver Model (IDM) for all its vehicles: each accelerates toward its own desired
 * speed, keeps a safe time gap to the one ahead (no overlaps, no tailgating), brakes smoothly for it or for a planned stop
 * (a bus stopping at the stop), and leaves at the far end. The whole trajectory is simulated ONCE when the set is built,
 * with a fixed step from before the shot starts (the road is already busy at t = 0); each frame then just looks up the
 * arc length s(t). So any frame (and any chunk of frames) is the same whichever way it is rendered.
 * Pose: position and heading from the lane's path at s (continuous, aligned with the road), wheels turned by s / radius,
 * a two-wheeler leans slightly into curves, the bicycle's pedals and the rider's legs follow the wheel.
 */
export type { VehicleKind } from "./vehicle-models";
export interface Lane { path: THREE.Curve<THREE.Vector3>; length: number }
export interface TrafficOptions {
  lanes: Lane[];
  mix: VehicleKind[];
  /** Vehicles per minute per lane. */
  rate: number;
  duration: number;
  seed: number;
  night: boolean;
  wet: number;
  /** A vehicle (the first of `kind` on lane `lane`) that stops at arc length s for `dwell` seconds (a bus at its stop). */
  stop?: { lane: number; kind: VehicleKind; s: number; dwell: number };
  /** Vehicles standing still off the lanes (parked at the kerb; also a line-up for inspecting the models). */
  parked?: { kind: VehicleKind; x: number; z: number; heading: number }[];
  /** Secondary effects (exhaust, dust, spray, beams): what the place and weather allow. */
  fx?: FxOptions;
}

const SPEC: Record<VehicleKind, { v0: number; a: number; b: number; len: number; wheelR: number }> = {
  car: { v0: 11, a: 1.8, b: 2.6, len: 4.4, wheelR: 0.32 }, auto: { v0: 8, a: 1.4, b: 2.2, len: 2.9, wheelR: 0.24 }, bus: { v0: 9, a: 1.0, b: 1.8, len: 10.9, wheelR: 0.5 },
  scooter: { v0: 9.5, a: 2.2, b: 3.0, len: 1.8, wheelR: 0.27 }, motorcycle: { v0: 11, a: 2.6, b: 3.2, len: 2.1, wheelR: 0.31 }, bicycle: { v0: 4.6, a: 1.0, b: 2.0, len: 1.75, wheelR: 0.34 },
};

// ---------- traffic ----------
interface Car { kind: VehicleKind; lane: number; enter: number; model: VehicleModel; s: Float32Array; v: Float32Array; lean: number }
export interface Traffic { vehicles: { kind: VehicleKind; lane: number }[]; update(t: number, cam?: THREE.Vector3): void; group: THREE.Group }

export function traffic(o: TrafficOptions): Traffic {
  const kit = new Kit(o.night, o.wet);
  const r = mulberry(o.seed), group = new THREE.Group();
  const model = (kind: VehicleKind): VehicleModel => {
    const m = buildVehicle(kind, kit, Math.floor(r() * 1e9));
    // a wheel mounted mirrored (spokes facing out on the left) spins the other way about its own axle
    for (const w of m.wheels) w.userData.spin = Math.abs(w.rotation.y) > 1 ? -1 : 1;
    return m;
  };
  const DT = 1 / 60, WARM = 40, steps = Math.ceil((o.duration + WARM) / DT) + 2;
  const cars: Car[] = [];
  o.lanes.forEach((lane, li) => {
    // arrivals: exponential gaps; the queue is simulated together on the lane
    const list: { kind: VehicleKind; enter: number }[] = [];
    let at = -WARM + r() * 4;
    while (at < o.duration) { list.push({ kind: o.mix[Math.floor(r() * o.mix.length)]!, enter: at }); at += Math.max(2.2, -Math.log(1 - r()) * (60 / o.rate)); }
    // the stopping vehicle is timed to pull in early in the shot (~ (s / v0) + braking after it enters), dwell, and leave
    if (o.stop && o.stop.lane === li) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.kind === o.stop.kind) list.splice(i, 1);
      const arrive = Math.min(2.5, o.duration * 0.2), enter = arrive - (o.stop.s / SPEC[o.stop.kind].v0) - 5;
      // keep the lane clear just ahead of it so it is not held up on the way in
      for (let i = list.length - 1; i >= 0; i--) if (Math.abs(list[i]!.enter - enter) < 5) list.splice(i, 1);
      list.push({ kind: o.stop.kind, enter });
    }
    list.sort((a, b) => a.enter - b.enter);
    const idx = list.map((x) => {
      const c: Car = { kind: x.kind, lane: li, enter: x.enter, model: model(x.kind), s: new Float32Array(steps), v: new Float32Array(steps), lean: 0 };
      cars.push(c); group.add(c.model.root); c.model.root.visible = false;
      return c;
    });
    const stopCar = o.stop && o.stop.lane === li ? idx.find((c) => c.kind === o.stop!.kind) : undefined;
    let stoppedAt = -1;
    const state = idx.map(() => ({ s: -1e9, v: 0, live: false, done: false }));
    for (let k = 0; k < steps; k++) {
      const t = -WARM + k * DT;
      idx.forEach((c, i) => {
        const st = state[i]!, P = SPEC[c.kind];
        if (!st.live && !st.done && t >= c.enter) { // enters at the lane start if there is room
          const ahead = state.slice(0, i).reverse().find((x) => x.live);
          if (!ahead || ahead.s - SPEC[idx[state.indexOf(ahead)]!.kind].len > 6) { st.live = true; st.s = 0; st.v = P.v0 * 0.85; } else c.enter = t + 0.5;
        }
        if (st.live) {
          // IDM: free-road acceleration minus the interaction with the leader (or with the stop line)
          const ahead = state.slice(0, i).reverse().find((x) => x.live);
          let gap = Infinity, dv = 0;
          if (ahead) { gap = ahead.s - SPEC[idx[state.indexOf(ahead)]!.kind].len - st.s; dv = st.v - ahead.v; }
          if (c === stopCar && o.stop) {
            // stopped at the stop: standing within the car-following gap of the line (IDM halts s0 short of it)
            // (IDM only creeps the last metre to a halt, so "slow at the line" counts as arrived; it then stands still)
            if (stoppedAt < 0 && st.v < 0.4 && o.stop.s - st.s < 2.2 + 2 && o.stop.s - st.s > -1) stoppedAt = t;
            if (stoppedAt >= 0 && t < stoppedAt + o.stop.dwell) { st.v = Math.max(0, st.v - 3 * DT); st.s += st.v * DT; c.s[k] = st.s; c.v[k] = st.v; return; } // advance, then record (as below)
            if (stoppedAt < 0) { const g2 = o.stop.s - st.s; if (g2 > -1 && g2 < gap) { gap = Math.max(0.05, g2); dv = st.v; } }
          }
          const s0 = 2.2, T = 1.4, sStar = s0 + Math.max(0, st.v * T + (st.v * dv) / (2 * Math.sqrt(P.a * P.b)));
          const acc = P.a * (1 - (st.v / P.v0) ** 4 - (gap === Infinity ? 0 : (sStar / Math.max(0.1, gap)) ** 2));
          st.v = Math.max(0, st.v + Math.max(-8, acc) * DT); st.s += st.v * DT;
          if (st.s > lane.length + 5) { st.live = false; st.done = true; }
        }
        c.s[k] = st.live ? st.s : st.done ? 1e9 : -1e9; c.v[k] = st.v;
      });
    }
  });
  // parked vehicles: still, lights as the time of day has them
  const parked = (o.parked ?? []).map((pk) => { const m = model(pk.kind); m.root.position.set(pk.x, 0.04, pk.z); m.root.rotation.y = pk.heading; group.add(m.root); if (m.legs) m.legs.update(0); return { ...pk, model: m }; });
  // per-vehicle state at any time from the simulated table (pure function of t): arc length, speed, acceleration
  const at = (c: Car, t: number): { s: number; v: number; a: number; ok: boolean } => {
    const kf = (t + WARM) / DT, k0 = Math.max(0, Math.min(steps - 2, Math.floor(kf))), u = kf - k0;
    const a0 = c.s[k0]!, b0 = c.s[k0 + 1]!;
    if (a0 < -1e8 || a0 > 1e8 || b0 < -1e8 || b0 > 1e8) return { s: 0, v: 0, a: 0, ok: false };
    const kb = Math.max(0, k0 - 15), v = c.v[k0]! + (c.v[k0 + 1]! - c.v[k0]!) * u;
    return { s: a0 + (b0 - a0) * u, v, a: (v - c.v[kb]!) / ((k0 - kb) * DT || 1), ok: true };
  };
  const pose = (c: Car, s: number, out: { p: THREE.Vector3; yaw: number }): void => {
    const lane = o.lanes[c.lane]!, f = Math.min(1, Math.max(0, s / lane.length));
    lane.path.getPointAt(f, out.p); lane.path.getTangentAt(f, tan); out.yaw = Math.atan2(-tan.z, tan.x);
  };
  const fx = o.fx ? vehicleFx(o.fx, cars.map((c) => ({ kind: c.kind, model: c.model, state: (t: number) => { const st = at(c, t); if (!st.ok) return null; const lane = o.lanes[c.lane]!; if (st.s < 0 || st.s > lane.length) return null; const q = { p: new THREE.Vector3(), yaw: 0 }; pose(c, st.s, q); return { ...q, v: st.v, a: st.a }; } })), parked.map((pk) => pk.model)) : null;
  if (fx) group.add(fx.group);
  const p = new THREE.Vector3(), tan = new THREE.Vector3();
  return {
    group,
    vehicles: cars.map((c) => ({ kind: c.kind, lane: c.lane })),
    update(t: number, cam?: THREE.Vector3): void {
      const kf = (t + WARM) / DT, k0 = Math.max(0, Math.min(steps - 2, Math.floor(kf))), u = kf - k0;
      for (const c of cars) {
        const a = c.s[k0]!, b = c.s[k0 + 1]!;
        const lane = o.lanes[c.lane]!;
        if (a < -1e8 || a > 1e8 || b < -1e8 || b > 1e8) { c.model.root.visible = false; continue; }
        const s = a + (b - a) * u;
        if (s < 0 || s > lane.length) { c.model.root.visible = false; continue; }
        c.model.root.visible = true;
        const f = s / lane.length;
        lane.path.getPointAt(f, p); lane.path.getTangentAt(f, tan); tan.y = 0; tan.normalize();
        c.model.root.position.copy(p);
        // heading is a pure yaw from the road's direction (a vehicle never rolls over on a lane that runs the other way)
        c.model.root.rotation.set(0, Math.atan2(-tan.z, tan.x), 0);
        // two-wheelers lean into a curve (curvature from the tangent change ahead), smoothly
        if (c.kind === "scooter" || c.kind === "motorcycle" || c.kind === "bicycle") {
          const t2 = lane.path.getTangentAt(Math.min(1, f + 2 / lane.length)).setY(0).normalize();
          const turn = Math.atan2(tan.x * t2.z - tan.z * t2.x, tan.dot(t2)), v = c.v[k0]!;
          c.model.root.rotateX(Math.max(-0.35, Math.min(0.35, -turn * v * 0.9)));
        }
        // wheels roll without slipping: angle = distance / radius (clockwise seen from the right side when going forward)
        const spin = -s / c.model.wheelR;
        for (const w of c.model.wheels) w.rotation.z = spin * (w.userData.spin as number);
        if (c.model.pedals && c.model.legs) { const crank = spin * 0.42; c.model.pedals.rotation.z = crank; c.model.legs.update(-crank); }
        // brake lights: brighter while slowing (deceleration from the simulated speed over the last quarter second)
        const st = at(c, t), brake = Math.min(1, Math.max(0, (-st.a - 0.4) / 1.2));
        for (const l of c.model.tail) (l.material as THREE.MeshStandardMaterial).emissiveIntensity = (o.night ? 1.6 : 0.2) + brake * (o.night ? 5 : 3.5);
      }
      fx?.update(t, cam);
    },
  };
}

/** A straight lane along +x or -x at depth z (centre of the lane), from x0 to x1. */
export function straightLane(x0: number, x1: number, z: number, y = 0.04): Lane {
  const path = new THREE.LineCurve3(new THREE.Vector3(x0, y, z), new THREE.Vector3(x1, y, z));
  return { path, length: Math.abs(x1 - x0) };
}
