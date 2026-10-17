import * as THREE from "three";
import { mulberry } from "./noise";

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
export type VehicleKind = "car" | "auto" | "bus" | "scooter" | "motorcycle" | "bicycle";
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
}

const SPEC: Record<VehicleKind, { v0: number; a: number; b: number; len: number; wheelR: number }> = {
  car: { v0: 11, a: 1.8, b: 2.6, len: 4.2, wheelR: 0.33 }, auto: { v0: 8, a: 1.4, b: 2.2, len: 2.9, wheelR: 0.24 }, bus: { v0: 9, a: 1.0, b: 1.8, len: 10.5, wheelR: 0.5 },
  scooter: { v0: 9.5, a: 2.2, b: 3.0, len: 1.8, wheelR: 0.27 }, motorcycle: { v0: 11, a: 2.6, b: 3.2, len: 2.1, wheelR: 0.31 }, bicycle: { v0: 4.6, a: 1.0, b: 2.0, len: 1.75, wheelR: 0.34 },
};

// ---------- models (built once per kind and cloned; meshes share geometry and materials) ----------
interface Model { root: THREE.Group; wheels: THREE.Object3D[]; pedals?: THREE.Object3D; legs?: { thighL: THREE.Object3D; shinL: THREE.Object3D; thighR: THREE.Object3D; shinR: THREE.Object3D }; lights?: THREE.Object3D[] }
// shared within one set (one traffic() call), never across shots: a material kept from an earlier shot keeps its lower id,
// which changes three.js's draw order and so the anti-aliasing of a few edge pixels (a shot must not depend on the page's
// history, or chunks rendered in different pages would differ)
let mats = new Map<string, THREE.Material>();
const mat = (key: string, make: () => THREE.Material): THREE.Material => { let m = mats.get(key); if (!m) { m = make(); mats.set(key, m); } return m; };
const std = (c: string, rough = 0.6, metal = 0.1, extra: THREE.MeshStandardMaterialParameters = {}): THREE.Material => mat(`${c}|${rough}|${metal}|${JSON.stringify(extra)}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal, ...extra }));
const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; return o; };

/** A wheel: tyre, rim and spokes (so the turning reads), on a pivot that spins about its axle (local Z). */
function wheel(r: number, width: number, spokes = 5): THREE.Group {
  const g = new THREE.Group();
  const tyre = mesh(new THREE.TorusGeometry(r * 0.78, r * 0.24, 10, 24), std("#151515", 0.85)); tyre.scale.z = width / (r * 0.48); g.add(tyre);
  g.add(mesh(new THREE.CylinderGeometry(r * 0.5, r * 0.5, width * 0.6, 18).rotateX(Math.PI / 2), std("#9aa0a6", 0.35, 0.8)));
  for (let i = 0; i < spokes; i++) { const s = mesh(new THREE.BoxGeometry(r * 1.05, r * 0.08, width * 0.3), std("#c9ced3", 0.3, 0.9)); s.rotation.z = (i / spokes) * Math.PI; g.add(s); }
  return g;
}
/** Side profile (x forward, y up) extruded across the width, with bevelled edges: a car body that is not a box. */
function profileBody(points: [number, number][], width: number, material: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: width - 0.12, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 3, curveSegments: 8 });
  g.translate(0, 0, -(width - 0.12) / 2);
  return mesh(g, material);
}
function lamp(color: string, w: number, h: number, intensity: number): THREE.Mesh {
  return mesh(new THREE.BoxGeometry(0.05, h, w), mat(`lamp${color}${intensity}`, () => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.2 })));
}
/** A seated rider: helmet, torso, arms to the handlebar, legs (thigh + shin pivots, for pedalling). */
function rider(shirt: string, helmet: boolean, seatX: number, seatY: number, handX: number, handY: number): { g: THREE.Group; legs: NonNullable<Model["legs"]> } {
  const g = new THREE.Group(), skin = std("#8a5a3c", 0.7), cloth = std(shirt, 0.85), pants = std("#2c2f38", 0.9);
  const torso = mesh(new THREE.CapsuleGeometry(0.17, 0.42, 4, 10), cloth, seatX + 0.05, seatY + 0.42, 0); torso.rotation.z = -0.25; g.add(torso);
  g.add(mesh(new THREE.SphereGeometry(0.12, 14, 10), skin, seatX + 0.16, seatY + 0.86, 0));
  if (helmet) g.add(mesh(new THREE.SphereGeometry(0.15, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), std("#b02a2a", 0.3, 0.2), seatX + 0.16, seatY + 0.9, 0));
  for (const z of [-0.16, 0.16]) {
    const arm = mesh(new THREE.CapsuleGeometry(0.05, Math.hypot(handX - seatX, handY - seatY - 0.62) - 0.05, 4, 8), cloth);
    arm.position.set((seatX + 0.1 + handX) / 2, (seatY + 0.66 + handY) / 2, z * 1.1); arm.rotation.z = -Math.atan2(handX - seatX - 0.1, handY - seatY - 0.66) + Math.PI; g.add(arm);
  }
  const leg = (z: number): { thigh: THREE.Object3D; shin: THREE.Object3D } => {
    const thigh = new THREE.Group(); thigh.position.set(seatX, seatY + 0.02, z); g.add(thigh);
    thigh.add(mesh(new THREE.CapsuleGeometry(0.07, 0.36, 4, 8).translate(0, -0.22, 0), pants));
    const shin = new THREE.Group(); shin.position.set(0, -0.44, 0); thigh.add(shin);
    shin.add(mesh(new THREE.CapsuleGeometry(0.055, 0.34, 4, 8).translate(0, -0.21, 0), pants));
    shin.add(mesh(new THREE.BoxGeometry(0.22, 0.07, 0.1), std("#1d1d1d", 0.8), 0.06, -0.44, 0));
    return { thigh, shin };
  };
  const L = leg(0.14), R = leg(-0.14);
  return { g, legs: { thighL: L.thigh, shinL: L.shin, thighR: R.thigh, shinR: R.shin } };
}

function buildModel(kind: VehicleKind, r: () => number, night: boolean): Model {
  const root = new THREE.Group(), wheels: THREE.Object3D[] = [], lights: THREE.Object3D[] = [];
  const glass = std("#1b2633", 0.06, 0.9, { envMapIntensity: 1.4 });
  const head = (x: number, y: number, z: number, w = 0.22, h = 0.12) => { const l = lamp("#fff3d6", w, h, night ? 3 : 0.4); l.position.set(x, y, z); root.add(l); lights.push(l); };
  const tail = (x: number, y: number, z: number) => { const l = lamp("#ff2a1a", 0.2, 0.1, night ? 2.5 : 0.5); l.position.set(x, y, z); root.add(l); };
  if (kind === "car") {
    const paint = std(["#b8312f", "#e8e8e8", "#2d6fa8", "#3a3a3a", "#c9a13a", "#5a7a5a"][Math.floor(r() * 6)]!, 0.28, 0.55, { envMapIntensity: 1.3 });
    root.add(profileBody([[-2.1, 0.32], [2.1, 0.32], [2.15, 0.62], [1.9, 0.86], [0.9, 0.95], [0.25, 1.42], [-1.25, 1.44], [-1.95, 1.0], [-2.15, 0.9]], 1.76, paint));
    const cab = profileBody([[0.82, 0.98], [0.2, 1.36], [-1.2, 1.38], [-1.8, 1.0]], 1.62, glass); cab.position.y = 0.02; root.add(cab);
    for (const [x, z] of [[1.33, 0.82], [1.33, -0.82], [-1.38, 0.82], [-1.38, -0.82]] as const) { const w = wheel(0.33, 0.22); w.position.set(x, 0.33, z); root.add(w); wheels.push(w); }
    for (const z of [-0.6, 0.6]) { head(2.18, 0.68, z); tail(-2.18, 0.78, z); }
    root.add(mesh(new THREE.BoxGeometry(0.12, 0.16, 1.7), std("#222", 0.5, 0.4), 2.16, 0.42, 0), mesh(new THREE.BoxGeometry(0.12, 0.16, 1.7), std("#222", 0.5, 0.4), -2.16, 0.42, 0));
    root.add(mesh(new THREE.SphereGeometry(0.11, 10, 8), std("#6b4a3a", 0.8), -0.1, 1.15, 0.35)); // the driver behind the glass
  } else if (kind === "auto") {
    const body = std("#2f7a3a", 0.45, 0.3), top = std("#e7c632", 0.5, 0.2), canvas = std("#1d1d1d", 0.9);
    root.add(profileBody([[-1.3, 0.3], [1.35, 0.3], [1.45, 0.8], [1.2, 1.0], [-1.3, 1.0]], 1.3, body));
    root.add(mesh(new THREE.BoxGeometry(2.4, 0.08, 1.36), top, -0.05, 1.82, 0));
    for (const z of [-0.63, 0.63]) root.add(mesh(new THREE.BoxGeometry(2.3, 0.82, 0.04), canvas, -0.1, 1.4, z));
    root.add(mesh(new THREE.BoxGeometry(0.04, 0.6, 1.2), glass, 1.2, 1.35, 0));
    for (const [x, z] of [[1.15, 0], [-0.95, 0.58], [-0.95, -0.58]] as const) { const w = wheel(0.24, 0.16); w.position.set(x, 0.24, z); root.add(w); wheels.push(w); }
    head(1.47, 0.8, 0, 0.18, 0.18); for (const z of [-0.5, 0.5]) tail(-1.32, 0.7, z);
  } else if (kind === "bus") {
    const paint = std(["#c43a2a", "#2a6ac4", "#e2a72a"][Math.floor(r() * 3)]!, 0.4, 0.3), white = std("#efeee8", 0.5, 0.1);
    root.add(profileBody([[-5.25, 0.45], [5.25, 0.45], [5.3, 2.9], [5.0, 3.15], [-5.25, 3.15]], 2.5, paint));
    root.add(mesh(new THREE.BoxGeometry(10.3, 0.5, 2.52), white, 0, 2.2, 0));
    for (let i = 0; i < 8; i++) root.add(mesh(new THREE.BoxGeometry(1.1, 0.8, 2.54), glass, -4.3 + i * 1.22, 2.05, 0));
    root.add(mesh(new THREE.BoxGeometry(0.06, 1.3, 2.2), glass, 5.28, 2.1, 0));
    for (const [x, z] of [[3.6, 1.1], [3.6, -1.1], [-3.4, 1.1], [-3.4, -1.1]] as const) { const w = wheel(0.5, 0.32, 6); w.position.set(x, 0.5, z); root.add(w); wheels.push(w); }
    for (const z of [-0.9, 0.9]) { head(5.32, 0.95, z, 0.3, 0.16); tail(-5.28, 1.0, z); }
  } else {
    // two-wheelers: frame, wheels, handlebar, seat, a rider
    const bicycle = kind === "bicycle", wr = SPEC[kind].wheelR, wb = bicycle ? 1.05 : kind === "scooter" ? 1.25 : 1.4;
    const frame = std(bicycle ? "#2a5a8a" : ["#c43a2a", "#1d1d1d", "#e8e8e8", "#2a6ac4"][Math.floor(r() * 4)]!, 0.35, 0.5);
    for (const x of [wb / 2, -wb / 2]) { const w = wheel(wr, bicycle ? 0.05 : 0.12, bicycle ? 12 : 5); w.position.set(x, wr, 0); root.add(w); wheels.push(w); }
    if (bicycle) {
      const tube = (a: [number, number], b: [number, number]) => { const len = Math.hypot(b[0] - a[0], b[1] - a[1]); const m = mesh(new THREE.CylinderGeometry(0.022, 0.022, len, 6), frame, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0); m.rotation.z = -Math.atan2(b[0] - a[0], b[1] - a[1]); root.add(m); };
      tube([-0.52, wr], [-0.05, wr]); tube([-0.05, wr], [-0.2, 0.95]); tube([-0.2, 0.95], [0.42, 0.92]); tube([0.42, 0.92], [-0.05, wr]); tube([0.42, 0.92], [0.52, wr]); tube([-0.52, wr], [-0.2, 0.95]); tube([0.42, 0.92], [0.4, 1.1]);
      root.add(mesh(new THREE.BoxGeometry(0.06, 0.03, 0.5), frame, 0.38, 1.12, 0), mesh(new THREE.BoxGeometry(0.24, 0.05, 0.12), std("#1d1d1d", 0.8), -0.22, 0.98, 0));
      const pedals = new THREE.Group(); pedals.position.set(-0.05, wr, 0); root.add(pedals);
      for (const s of [1, -1]) { const crank = mesh(new THREE.BoxGeometry(0.03, 0.17, 0.03), std("#888", 0.4, 0.8), 0, -0.085 * s, 0.09 * s); pedals.add(crank); }
      const rd = rider(["#d8572a", "#2a8ad8", "#ffffff"][Math.floor(r() * 3)]!, false, -0.22, 1.0, 0.36, 1.12); root.add(rd.g);
      return { root, wheels, pedals, legs: rd.legs, lights };
    }
    root.add(profileBody(kind === "scooter" ? [[-0.75, 0.3], [0.45, 0.3], [0.6, 0.95], [0.45, 1.0], [0.25, 0.45], [-0.3, 0.45], [-0.3, 0.7], [-0.8, 0.72]] : [[-0.7, 0.45], [0.5, 0.45], [0.55, 0.85], [-0.1, 0.95], [-0.75, 0.82]], kind === "scooter" ? 0.42 : 0.36, frame));
    root.add(mesh(new THREE.BoxGeometry(0.7, 0.1, 0.32), std("#1d1d1d", 0.8), -0.4, 0.78, 0));
    root.add(mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.62, 6).rotateX(Math.PI / 2), std("#333", 0.4, 0.8), 0.5, 1.1, 0));
    head(0.66, 0.95, 0, 0.16, 0.14); tail(-0.82, 0.78, 0);
    const rd = rider(["#2a6ac4", "#d8d8d8", "#8a2a2a", "#3a7a3a"][Math.floor(r() * 4)]!, true, -0.4, 0.82, 0.48, 1.1); root.add(rd.g);
    // feet on the footboard, knees bent
    rd.legs.thighL.rotation.z = rd.legs.thighR.rotation.z = 1.25; rd.legs.shinL.rotation.z = rd.legs.shinR.rotation.z = -1.3;
  }
  return { root, wheels, lights };
}

// ---------- traffic ----------
interface Car { kind: VehicleKind; lane: number; enter: number; model: Model; s: Float32Array; v: Float32Array; lean: number }
export interface Traffic { vehicles: { kind: VehicleKind; lane: number }[]; update(t: number): void; group: THREE.Group }

export function traffic(o: TrafficOptions): Traffic {
  mats = new Map();
  const r = mulberry(o.seed), group = new THREE.Group();
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
      const c: Car = { kind: x.kind, lane: li, enter: x.enter, model: buildModel(x.kind, r, o.night), s: new Float32Array(steps), v: new Float32Array(steps), lean: 0 };
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
  const p = new THREE.Vector3(), tan = new THREE.Vector3();
  return {
    group,
    vehicles: cars.map((c) => ({ kind: c.kind, lane: c.lane })),
    update(t: number): void {
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
        const spin = -s / SPEC[c.kind].wheelR;
        for (const w of c.model.wheels) w.rotation.z = spin;
        if (c.model.pedals && c.model.legs) {
          // pedals turn with the rear wheel (gear ratio ~0.4); the legs follow the pedals (two-joint chain)
          const crank = spin * 0.42; c.model.pedals.rotation.z = crank;
          const L = c.model.legs;
          L.thighL.rotation.z = 0.95 + 0.38 * Math.sin(crank); L.shinL.rotation.z = -1.05 + 0.45 * Math.cos(crank);
          L.thighR.rotation.z = 0.95 - 0.38 * Math.sin(crank); L.shinR.rotation.z = -1.05 - 0.45 * Math.cos(crank);
        }
      }
    },
  };
}

/** A straight lane along +x or -x at depth z (centre of the lane), from x0 to x1. */
export function straightLane(x0: number, x1: number, z: number, y = 0.04): Lane {
  const path = new THREE.LineCurve3(new THREE.Vector3(x0, y, z), new THREE.Vector3(x1, y, z));
  return { path, length: Math.abs(x1 - x0) };
}
