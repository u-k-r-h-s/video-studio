import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { mulberry } from "./noise";

/**
 * Original procedural vehicle models (no downloaded assets). Model space: forward +X, up +Y, right +Z, ground at y = 0.
 *
 * Bodies are LOFTED: a rounded cross-section (a squircle whose top can be narrower than its bottom: tumblehome) is swept
 * through stations along the length, so a car has a bonnet that falls toward the nose, a cabin narrower than the body, a
 * boot; a bus has rounded roof edges and a raked front. Glass is real (tinted, partly transparent) over a dark interior
 * with a driver. Details are separate shapes: wheel-arch liners, bumpers, grille slats, lamp clusters (lens + reflector),
 * mirrors, door seams and handles, Indian number plates. Wheels have a tyre with sidewall, a recessed rim and spokes that
 * stand out from it (the rotation reads on screen). Riders are jointed (helmet with visor, torso, upper arm + forearm to
 * the grips, thigh + shin to the pegs), posed by two-bone IK.
 *
 * Static parts of one model are merged per material (a few draw calls per vehicle); wheels, pedals, legs and lamps stay
 * separate because they move or change. A Kit (one per set) owns the materials: nothing is shared across shots.
 */
export type VehicleKind = "car" | "auto" | "bus" | "scooter" | "motorcycle" | "bicycle";
export interface VehicleModel {
  root: THREE.Group;
  wheels: THREE.Object3D[];
  wheelR: number;
  /** Lamps that change: head (night), tail (night + braking). Each model owns its tail material (per-vehicle brake). */
  head: THREE.Mesh[];
  tail: THREE.Mesh[];
  /** Local anchor points for effects. */
  anchors: { headlamps: THREE.Vector3[]; taillamps: THREE.Vector3[]; exhaust: THREE.Vector3 | null; rearWheels: THREE.Vector3[]; length: number; width: number };
  pedals?: THREE.Object3D;
  /** Pedalling legs (bicycle): updated from the crank angle by two-bone IK. */
  legs?: { update(crank: number): void };
}

// ---------------- materials (per set) ----------------
export class Kit {
  private cache = new Map<string, THREE.Material>();
  constructor(readonly night: boolean, readonly wet: number) {}
  get<T extends THREE.Material>(key: string, make: () => T): T { let m = this.cache.get(key) as T | undefined; if (!m) { m = make(); this.cache.set(key, m); } return m; }
  paint(c: string): THREE.MeshPhysicalMaterial { return this.get(`paint${c}`, () => new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.35, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.07, envMapIntensity: 1.25 })); }
  matte(c: string, rough = 0.7, metal = 0): THREE.MeshStandardMaterial { return this.get(`matte${c}${rough}${metal}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal })); }
  get glass(): THREE.MeshPhysicalMaterial { return this.get("glass", () => new THREE.MeshPhysicalMaterial({ color: "#2b3b48", metalness: 0.05, roughness: 0.04, transparent: true, opacity: this.night ? 0.62 : 0.55, envMapIntensity: 1.8, clearcoat: 1, clearcoatRoughness: 0.02 })); }
  get chrome(): THREE.MeshStandardMaterial { return this.get("chrome", () => new THREE.MeshStandardMaterial({ color: "#d9dde2", metalness: 1, roughness: 0.16, envMapIntensity: 1.4 })); }
  get rubber(): THREE.MeshStandardMaterial { return this.get("rubber", () => new THREE.MeshStandardMaterial({ color: "#16171a", roughness: 0.92 - 0.3 * this.wet, metalness: 0 })); }
  get trim(): THREE.MeshStandardMaterial { return this.get("trim", () => new THREE.MeshStandardMaterial({ color: "#1d1f22", roughness: 0.55, metalness: 0.2 })); }
  get interior(): THREE.MeshStandardMaterial { return this.get("interior", () => new THREE.MeshStandardMaterial({ color: "#2a2724", roughness: 0.9 })); }
  get rim(): THREE.MeshStandardMaterial { return this.get("rim", () => new THREE.MeshStandardMaterial({ color: "#aeb4bb", metalness: 0.9, roughness: 0.3 })); }
  get rimDark(): THREE.MeshStandardMaterial { return this.get("rimDark", () => new THREE.MeshStandardMaterial({ color: "#2c2f33", metalness: 0.6, roughness: 0.5 })); }
  get skin(): THREE.MeshStandardMaterial { return this.get("skin", () => new THREE.MeshStandardMaterial({ color: "#8d5b3e", roughness: 0.65 })); }
  headLens(): THREE.MeshStandardMaterial { return this.get("headlens", () => new THREE.MeshStandardMaterial({ color: "#f4f1e6", emissive: "#fff2d0", emissiveIntensity: this.night ? 4 : 0.15, metalness: 0.2, roughness: 0.08 })); }
  /** A tail lens per vehicle (its brightness carries that vehicle's braking). */
  tailLens(): THREE.MeshStandardMaterial { return new THREE.MeshStandardMaterial({ color: "#8a1410", emissive: "#ff2614", emissiveIntensity: this.night ? 1.6 : 0.2, metalness: 0.1, roughness: 0.15 }); }
  get indicator(): THREE.MeshStandardMaterial { return this.get("ind", () => new THREE.MeshStandardMaterial({ color: "#d98a1a", emissive: "#ff9a20", emissiveIntensity: 0.15, roughness: 0.2 })); }
  plate(text: string, commercial: boolean): THREE.Material {
    return this.get(`plate${text}${commercial}`, () => {
      if (typeof document === "undefined") return new THREE.MeshStandardMaterial({ color: commercial ? "#e8c21a" : "#f2f2ee", roughness: 0.5 });
      const c = document.createElement("canvas"); c.width = 256; c.height = 56; const g = c.getContext("2d")!;
      g.fillStyle = commercial ? "#f0c419" : "#f4f4f0"; g.fillRect(0, 0, 256, 56); g.strokeStyle = "#111"; g.lineWidth = 4; g.strokeRect(2, 2, 252, 52);
      g.fillStyle = "#111"; g.font = "bold 34px Helvetica"; g.textAlign = "center"; g.fillText(text, 128, 40);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.45, metalness: 0.1 });
    });
  }
}

// ---------------- geometry helpers ----------------
export interface Station { x: number; yb: number; yt: number; wb: number; wt?: number; n?: number }
/** Lofted body: rounded cross-sections (squircle, exponent n; half-width wb at the bottom, wt at the top) through stations
 *  along X, with closed ends. Normals are smooth. */
export function loft(stations: Station[], around = 28): THREE.BufferGeometry {
  const ring = (s: Station): THREE.Vector3[] => {
    const pts: THREE.Vector3[] = [], n = s.n ?? 5, yc = (s.yb + s.yt) / 2, h = (s.yt - s.yb) / 2;
    for (let i = 0; i < around; i++) {
      const a = (i / around) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      const y = yc + h * Math.sign(sn) * Math.abs(sn) ** (2 / n);
      const u = (y - s.yb) / Math.max(1e-6, s.yt - s.yb), w = s.wb + ((s.wt ?? s.wb) - s.wb) * u;
      pts.push(new THREE.Vector3(s.x, y, w * Math.sign(c) * Math.abs(c) ** (2 / n)));
    }
    return pts;
  };
  const rings = stations.map(ring), pos: number[] = [], idx: number[] = [];
  for (const r of rings) for (const p of r) pos.push(p.x, p.y, p.z);
  for (let k = 0; k < rings.length - 1; k++) for (let i = 0; i < around; i++) {
    const a = k * around + i, b = k * around + ((i + 1) % around), c = (k + 1) * around + i, d = (k + 1) * around + ((i + 1) % around);
    idx.push(a, c, b, b, c, d);
  }
  // end caps (fans from the centre of the first / last ring)
  for (const [k, flip] of [[0, true], [rings.length - 1, false]] as const) {
    const s = stations[k]!, ci = pos.length / 3; pos.push(s.x, (s.yb + s.yt) / 2, 0);
    for (let i = 0; i < around; i++) { const a = k * around + i, b = k * around + ((i + 1) % around); if (flip) idx.push(ci, a, b); else idx.push(ci, b, a); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/** A capsule from A to B (limbs, tubes). */
export function limb(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 8): THREE.BufferGeometry {
  const len = a.distanceTo(b), g = new THREE.CapsuleGeometry(r, Math.max(0.001, len), 3, seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}
export function tube(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 8): THREE.BufferGeometry {
  const len = a.distanceTo(b), g = new THREE.CylinderGeometry(r, r, len, seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}
/** Rounded box (for bumpers, lamps, seats): a loft with three stations. */
export function rbox(x0: number, x1: number, yb: number, yt: number, w: number, n = 6): THREE.BufferGeometry {
  const e = Math.min(0.03, (x1 - x0) * 0.2);
  return loft([{ x: x0, yb: yb + e, yt: yt - e, wb: w - e, n }, { x: x0 + e, yb, yt, wb: w, n }, { x: x1 - e, yb, yt, wb: w, n }, { x: x1, yb: yb + e, yt: yt - e, wb: w - e, n }], 16);
}
/** Two-bone IK in a plane: the middle joint for root A, end C, lengths a, b, bending toward `pole`. */
export function knee(A: THREE.Vector3, C: THREE.Vector3, a: number, b: number, pole: THREE.Vector3): THREE.Vector3 {
  const d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, A.distanceTo(C))), u = C.clone().sub(A).normalize();
  const v = pole.clone().sub(u.clone().multiplyScalar(pole.dot(u))).normalize();
  const cosA = (a * a + d * d - b * b) / (2 * a * d), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  return A.clone().addScaledVector(u, a * cosA).addScaledVector(v, a * sinA);
}

/** Collects parts per material and merges the static ones (one draw call per material per model). */
class Parts {
  private byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  readonly loose: THREE.Object3D[] = [];
  add(g: THREE.BufferGeometry, m: THREE.Material, at?: THREE.Matrix4): void {
    const geo = (g.index ? g.toNonIndexed() : g.clone());
    for (const k of Object.keys(geo.attributes)) if (k !== "position" && k !== "normal") geo.deleteAttribute(k);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (at) geo.applyMatrix4(at);
    (this.byMat.get(m) ?? this.byMat.set(m, []).get(m)!).push(geo);
  }
  build(root: THREE.Group): void {
    for (const [m, gs] of this.byMat) { const mesh = new THREE.Mesh(mergeGeometries(gs)!, m); mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh); }
    for (const o of this.loose) root.add(o);
  }
}
const M = (x = 0, y = 0, z = 0, ry = 0, rz = 0, rx = 0, s: number | [number, number, number] = 1): THREE.Matrix4 =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(...(typeof s === "number" ? [s, s, s] as const : s)));
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** A wheel group spinning about its axle (local Z): tyre with rounded sidewall, recessed rim, spokes standing proud. */
export function wheel(kit: Kit, r: number, width: number, style: "alloy" | "steel" | "wire" | "scooter"): THREE.Group {
  const g = new THREE.Group(); g.name = "wheel";
  const tyre = new THREE.Mesh(new THREE.TorusGeometry(r * 0.8, r * 0.2, 12, 36), kit.rubber); tyre.scale.z = width / (r * 0.4); tyre.castShadow = true; g.add(tyre);
  const rimR = r * 0.62, parts = new Parts();
  if (style === "wire") {
    parts.add(new THREE.TorusGeometry(rimR, 0.012, 6, 32), kit.chrome);
    for (let i = 0; i < 28; i++) { const a = (i / 28) * Math.PI * 2; parts.add(tube(V(0, 0, (i % 2 ? 1 : -1) * 0.03), V(Math.cos(a) * rimR, Math.sin(a) * rimR, 0), 0.0035, 3), kit.chrome); }
    parts.add(new THREE.CylinderGeometry(0.03, 0.03, 0.09, 10).rotateX(Math.PI / 2), kit.chrome);
  } else {
    // a dark recess behind the spokes, then 5-6 bright spokes and a hub: the rim reads as turning
    parts.add(new THREE.CylinderGeometry(rimR, rimR, width * 0.5, 24).rotateX(Math.PI / 2).translate(0, 0, -width * 0.12), kit.rimDark);
    parts.add(new THREE.TorusGeometry(rimR, r * 0.04, 6, 28).translate(0, 0, width * 0.16), kit.rim);
    const n = style === "steel" ? 8 : style === "scooter" ? 3 : 5, sw = style === "steel" ? r * 0.06 : r * 0.13;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, sp = new THREE.BoxGeometry(rimR * 0.95, sw, width * 0.12);
      sp.translate(rimR * 0.5, 0, width * 0.18); sp.rotateZ(a); parts.add(sp, style === "steel" ? kit.matte("#7d8085", 0.5, 0.5) : kit.rim);
    }
    parts.add(new THREE.CylinderGeometry(r * 0.16, r * 0.18, width * 0.3, 14).rotateX(Math.PI / 2).translate(0, 0, width * 0.2), kit.chrome);
  }
  parts.build(g);
  return g;
}
/** An arch liner over a wheel on both sides (a dark half-ring), so the body reads as cut around the wheel. */
function arches(parts: Parts, kit: Kit, x: number, r: number, zs: number[], tubeR = 0.05): void {
  // the liner frames the tyre (its inner edge clears the tread), it never crosses it
  for (const z of zs) parts.add(new THREE.TorusGeometry(r * 1.08 + tubeR + 0.03, tubeR, 6, 20, Math.PI).translate(x, r, z), kit.trim);
}
function plate(kit: Kit, text: string, commercial: boolean, x: number, y: number, facing: 1 | -1, w = 0.5): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.22), kit.plate(text, commercial));
  m.position.set(x, y, 0); m.rotation.y = facing > 0 ? Math.PI / 2 : -Math.PI / 2; return m;
}
/** A lamp: a lens (emissive) in a chrome/black reflector housing, facing +X (front) or -X (rear). */
function lampAt(parts: Parts, lens: THREE.Material, housing: THREE.Material, x: number, y: number, z: number, w: number, h: number, facing: 1 | -1, out: THREE.Mesh[], wrap = 0): void {
  parts.add(rbox(-0.03, 0.03, -h / 2 - 0.01, h / 2 + 0.01, w / 2 + 0.01).applyMatrix4(M(x - facing * 0.01, y, z, wrap)), housing);
  const l = new THREE.Mesh(rbox(-0.02, 0.02, -h / 2, h / 2, w / 2), lens); l.position.set(x + facing * 0.02, y, z); l.rotation.y = wrap; out.push(l);
}

// ---------------- riders and drivers ----------------
interface RiderPose { hip: THREE.Vector3; hands: [THREE.Vector3, THREE.Vector3]; feet: [THREE.Vector3, THREE.Vector3]; lean: number; helmet: boolean; shirt: string; pants: string; scale?: number }
/** A seated person (driver / rider), posed: torso leaning toward the bars, arms by IK to the grips, legs by IK to the pegs. */
function rider(kit: Kit, p: RiderPose, parts: Parts, dynamicLegs = false): { legs?: { thigh: THREE.Mesh[]; shin: THREE.Mesh[]; foot: THREE.Mesh[] } } {
  const s = p.scale ?? 1, cloth = kit.matte(p.shirt, 0.85), pants = kit.matte(p.pants, 0.9), shoe = kit.matte("#1b1b1b", 0.6);
  const up = V(0, 1, 0), fwd = V(1, 0, 0);
  const neck = p.hip.clone().add(V(Math.sin(p.lean) * 0.52 * s, Math.cos(p.lean) * 0.52 * s, 0));
  // torso: a tapered loft from the hips to the shoulders, leaning
  const torso = loft([{ x: 0, yb: -0.11 * s, yt: 0.11 * s, wb: 0.17 * s, n: 3 }, { x: 0.3 * s, yb: -0.1 * s, yt: 0.1 * s, wb: 0.19 * s, n: 3 }, { x: 0.5 * s, yb: -0.09 * s, yt: 0.09 * s, wb: 0.21 * s, n: 4 }, { x: 0.56 * s, yb: -0.06 * s, yt: 0.06 * s, wb: 0.12 * s, n: 3 }], 18);
  torso.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2 - p.lean)); torso.translate(p.hip.x, p.hip.y, p.hip.z);
  parts.add(torso, cloth);
  const head = neck.clone().add(V(0.03 * s, 0.14 * s, 0));
  parts.add(new THREE.SphereGeometry(0.105 * s, 16, 12).translate(head.x, head.y, head.z), kit.skin);
  parts.add(limb(neck, head.clone().add(V(0, -0.06 * s, 0)), 0.045 * s), kit.skin);
  if (p.helmet) {
    parts.add(new THREE.SphereGeometry(0.135 * s, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.62).translate(head.x - 0.01, head.y + 0.01, head.z), kit.paint(["#b8231d", "#1d1d1f", "#e8e8e8", "#1f4f9a"][Math.floor(Math.abs(head.x * 997) % 4)]!));
    parts.add(new THREE.SphereGeometry(0.128 * s, 16, 10, -Math.PI * 0.32, Math.PI * 0.64, Math.PI * 0.32, Math.PI * 0.26).rotateY(Math.PI / 2).translate(head.x + 0.005, head.y, head.z), kit.glass);
  } else parts.add(new THREE.SphereGeometry(0.11 * s, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(head.x - 0.01, head.y + 0.02, head.z), kit.matte("#151515", 0.8));
  // arms: shoulder -> elbow (IK, elbow out and down) -> hand on the grip
  for (const [i, side] of [[0, -1], [1, 1]] as const) {
    const sh = neck.clone().add(V(-0.03 * s, -0.05 * s, side * 0.2 * s)), hand = p.hands[i]!;
    // arm lengths with slack (the elbow always bends a little, never a straight rod), elbow out and down
    const el = knee(sh, hand, 0.33 * s, 0.31 * s, V(-0.2, -1, side * 0.9));
    parts.add(limb(sh, el, 0.05 * s), cloth); parts.add(limb(el, hand, 0.042 * s), cloth);
    parts.add(new THREE.SphereGeometry(0.045 * s, 10, 8).translate(hand.x, hand.y, hand.z), kit.skin);
  }
  // legs: hip -> knee (IK, knee forward and up) -> foot
  const legs = { thigh: [] as THREE.Mesh[], shin: [] as THREE.Mesh[], foot: [] as THREE.Mesh[] };
  for (const [i, side] of [[0, -1], [1, 1]] as const) {
    const hp = p.hip.clone().add(V(0, 0, side * 0.1 * s)), ft = p.feet[i]!;
    if (dynamicLegs) {
      const th = new THREE.Mesh(new THREE.CapsuleGeometry(0.065 * s, 0.4 * s, 3, 8), pants), sn = new THREE.Mesh(new THREE.CapsuleGeometry(0.05 * s, 0.38 * s, 3, 8), pants), fo = new THREE.Mesh(new THREE.BoxGeometry(0.22 * s, 0.07 * s, 0.1 * s), shoe);
      legs.thigh.push(th); legs.shin.push(sn); legs.foot.push(fo); parts.loose.push(th, sn, fo);
      continue;
    }
    const kn = knee(hp, ft, 0.44 * s, 0.42 * s, fwd.clone().add(up.clone().multiplyScalar(0.4)));
    parts.add(limb(hp, kn, 0.065 * s), pants); parts.add(limb(kn, ft.clone().add(V(0, 0.04, 0)), 0.05 * s), pants);
    parts.add(new THREE.BoxGeometry(0.24 * s, 0.08 * s, 0.1 * s).translate(ft.x + 0.06, ft.y, ft.z), shoe);
  }
  return dynamicLegs ? { legs } : {};
}

// ---------------- vehicles ----------------
const PAINTS = { car: ["#e9ebee", "#b9bec4", "#8a1c1c", "#2b3f6b", "#3a3d42", "#c9c3b2", "#1d1f22", "#6b7b8a"], bus: ["#2f7d4a", "#c4382a", "#2a5aa8", "#d89a22"], two: ["#b8231d", "#1d1d1f", "#2a52a0", "#e8e8e8", "#5a5f66"] };

function car(kit: Kit, r: () => number): VehicleModel {
  const hatch = r() < 0.45, L = hatch ? 3.85 : 4.35, hl = L / 2, color = PAINTS.car[Math.floor(r() * PAINTS.car.length)]!;
  const paint = kit.paint(color), parts = new Parts(), root = new THREE.Group(), head: THREE.Mesh[] = [], tail: THREE.Mesh[] = [];
  const W = 0.86; // body half-width
  // lower body: bonnet falling to the nose, a straight waist, a boot (sedan) or a short tail (hatch)
  const body: Station[] = hatch
    ? [{ x: -hl, yb: 0.36, yt: 0.86, wb: W - 0.08, n: 6 }, { x: -hl + 0.12, yb: 0.3, yt: 0.95, wb: W - 0.02, n: 7 }, { x: -hl + 0.6, yb: 0.27, yt: 0.98, wb: W, n: 8 }, { x: 0.4, yb: 0.27, yt: 0.98, wb: W, n: 8 }, { x: hl - 0.75, yb: 0.27, yt: 0.95, wb: W - 0.01, n: 8 }, { x: hl - 0.25, yb: 0.3, yt: 0.86, wb: W - 0.05, n: 7 }, { x: hl, yb: 0.36, yt: 0.72, wb: W - 0.12, n: 5 }]
    : [{ x: -hl, yb: 0.38, yt: 0.86, wb: W - 0.1, n: 5 }, { x: -hl + 0.15, yb: 0.31, yt: 0.95, wb: W - 0.03, n: 7 }, { x: -hl + 0.8, yb: 0.27, yt: 0.98, wb: W, n: 8 }, { x: 0.5, yb: 0.27, yt: 0.98, wb: W, n: 8 }, { x: hl - 0.8, yb: 0.27, yt: 0.94, wb: W - 0.01, n: 8 }, { x: hl - 0.25, yb: 0.3, yt: 0.84, wb: W - 0.05, n: 7 }, { x: hl, yb: 0.36, yt: 0.7, wb: W - 0.13, n: 5 }];
  parts.add(loft(body, 36), paint);
  // greenhouse: windscreen rake, roof, rear window (tumblehome: the top narrower than the waist)
  const g0 = hatch ? -hl + 0.12 : -hl + 0.95, g1 = hatch ? 0.95 : 1.05, roofY = hatch ? 1.5 : 1.45;
  const cabin: Station[] = [{ x: g0, yb: 0.95, yt: 1.0, wb: W - 0.04, wt: W - 0.08, n: 6 }, { x: g0 + (hatch ? 0.12 : 0.45), yb: 0.95, yt: roofY - 0.04, wb: W - 0.05, wt: W - 0.2, n: 6 }, { x: g0 + (hatch ? 0.35 : 0.7), yb: 0.95, yt: roofY, wb: W - 0.05, wt: W - 0.2, n: 6 }, { x: g1 - 0.75, yb: 0.95, yt: roofY, wb: W - 0.05, wt: W - 0.2, n: 6 }, { x: g1, yb: 0.95, yt: 0.99, wb: W - 0.05, wt: W - 0.1, n: 6 }];
  parts.add(loft(cabin, 32), kit.glass);
  // the roof skin (painted) over the middle of the glasshouse, and the pillars
  const rx0 = g0 + (hatch ? 0.3 : 0.65), rx1 = g1 - 0.78;
  parts.add(loft([{ x: rx0 - 0.05, yb: roofY - 0.06, yt: roofY + 0.012, wb: W - 0.19, n: 8 }, { x: rx0 + 0.05, yb: roofY - 0.06, yt: roofY + 0.022, wb: W - 0.19, n: 8 }, { x: rx1 - 0.05, yb: roofY - 0.06, yt: roofY + 0.022, wb: W - 0.19, n: 8 }, { x: rx1 + 0.05, yb: roofY - 0.06, yt: roofY + 0.012, wb: W - 0.19, n: 8 }], 24), paint);
  for (const z of [-1, 1]) {
    const zb = z * (W - 0.045), zt = z * (W - 0.195);
    parts.add(tube(V(g1 - 0.02, 0.97, zb), V(rx1 + 0.04, roofY - 0.01, zt), 0.035, 8), paint); // A pillar
    parts.add(tube(V(g0 + 0.04, 0.97, zb), V(rx0 - 0.03, roofY - 0.01, zt), hatch ? 0.07 : 0.045, 8), paint); // C pillar
    parts.add(new THREE.BoxGeometry(0.07, roofY - 1.0, 0.02).translate((rx0 + rx1) / 2 + 0.05, (roofY + 0.97) / 2, (Math.abs(zb) + Math.abs(zt)) / 2 * z), kit.trim); // B pillar
    // door seams, handles, a shoulder crease
    for (const x of [g1 - 0.05, (rx0 + rx1) / 2 + 0.05, hatch ? -hl + 0.95 : g0 + 0.25]) parts.add(new THREE.BoxGeometry(0.008, 0.62, 0.006).translate(x, 0.65, z * (W + 0.002)), kit.trim);
    for (const x of [(rx0 + rx1) / 2 - 0.15, hatch ? -hl + 0.8 : g0 + 0.15]) parts.add(rbox(x - 0.09, x + 0.09, 0.84, 0.875, 0.012).applyMatrix4(M(0, 0, z * (W + 0.006))), kit.chrome);
    parts.add(new THREE.BoxGeometry(L - 0.6, 0.012, 0.006).translate(0, 0.9, z * (W + 0.001)), kit.matte(new THREE.Color(color).multiplyScalar(0.8).getStyle(), 0.4));
    // mirror on a stalk at the base of the A pillar
    parts.add(tube(V(g1 - 0.08, 0.98, z * (W - 0.02)), V(g1 - 0.12, 1.02, z * (W + 0.1)), 0.015), kit.trim);
    parts.add(rbox(g1 - 0.2, g1 - 0.06, 0.98, 1.08, 0.07).applyMatrix4(M(0, 0, z * (W + 0.14))), paint);
    // side skirt
    parts.add(rbox(-hl + 0.6, hl - 0.75, 0.25, 0.33, 0.02).applyMatrix4(M(0, 0, z * (W - 0.01))), kit.trim);
  }
  // bumpers, grille, lamps, plates
  parts.add(rbox(hl - 0.1, hl + 0.06, 0.3, 0.5, W - 0.04).applyMatrix4(M()), kit.trim);
  parts.add(rbox(-hl - 0.06, -hl + 0.1, 0.32, 0.52, W - 0.06).applyMatrix4(M()), kit.trim);
  parts.add(new THREE.BoxGeometry(0.02, 0.15, 0.82).translate(hl + 0.005, 0.6, 0), kit.matte("#0e0f10", 0.5));
  for (let i = 0; i < 4; i++) parts.add(new THREE.BoxGeometry(0.02, 0.012, 0.8).translate(hl + 0.016, 0.545 + i * 0.035, 0), kit.chrome);
  parts.add(new THREE.BoxGeometry(0.025, 0.02, 0.86).translate(hl + 0.015, 0.68, 0), kit.chrome);
  const hlLens = kit.headLens(), tlLens = kit.tailLens();
  for (const z of [-1, 1]) {
    lampAt(parts, hlLens, kit.chrome, hl - 0.05, 0.66, z * (W - 0.24), 0.3, 0.1, 1, head, z * -0.25);
    parts.add(new THREE.BoxGeometry(0.03, 0.035, 0.12).translate(hl - 0.03, 0.42, z * (W - 0.18)), kit.indicator);
    lampAt(parts, tlLens, kit.trim, -hl + 0.04, 0.78, z * (W - 0.22), 0.26, 0.11, -1, tail, z * 0.3);
  }
  for (const [x, f] of [[hl + 0.075, 1], [-hl - 0.075, -1]] as const) root.add(plate(kit, `DL 3C ${(1000 + Math.floor(r() * 9000))}`, false, x, f > 0 ? 0.42 : 0.5, f));
  // inside: dash, seats, a driver with hands on the wheel (visible through the glass)
  parts.add(rbox(g1 - 0.45, g1 - 0.05, 0.75, 0.95, W - 0.12), kit.interior);
  for (const z of [-0.38, 0.38]) parts.add(rbox(-0.6, -0.25, 0.4, 1.15, 0.24).applyMatrix4(M(0, 0, z)), kit.interior);
  parts.add(new THREE.TorusGeometry(0.17, 0.02, 6, 20).rotateY(Math.PI / 2).rotateZ(0.5).translate(g1 - 0.45, 1.0, -0.38), kit.trim);
  rider(kit, { hip: V(-0.45, 0.62, -0.38), hands: [V(g1 - 0.42, 1.05, -0.5), V(g1 - 0.42, 1.05, -0.26)], feet: [V(g1 - 0.15, 0.32, -0.48), V(g1 - 0.15, 0.32, -0.28)], lean: 0.2, helmet: false, shirt: ["#e8e4dc", "#3a5a8a", "#5a4a3a"][Math.floor(r() * 3)]!, pants: "#2a2c33", scale: 0.92 }, parts);
  // wheels and arches
  const wr = 0.32, ax = hatch ? hl - 0.7 : hl - 0.82, rx = -hl + (hatch ? 0.62 : 0.85), wheels: THREE.Object3D[] = [];
  for (const x of [ax, rx]) { arches(parts, kit, x, wr, [-(W - 0.02), W - 0.02], 0.045); for (const z of [-1, 1]) { const w = wheel(kit, wr, 0.21, "alloy"); w.position.set(x, wr, z * (W - 0.11)); if (z < 0) w.rotation.y = Math.PI; wheels.push(w); root.add(w); } }
  parts.build(root); root.add(...head, ...tail);
  return { root, wheels, wheelR: wr, head, tail, anchors: { headlamps: [V(hl, 0.66, -0.6), V(hl, 0.66, 0.6)], taillamps: [V(-hl, 0.78, -0.62), V(-hl, 0.78, 0.62)], exhaust: V(-hl - 0.05, 0.3, 0.5), rearWheels: [V(rx, 0, -0.7), V(rx, 0, 0.7)], length: L, width: 2 * W } };
}

function auto(kit: Kit, r: () => number): VehicleModel {
  // Bajaj RE-style three-wheeler: green (CNG) or black lower body with a yellow canvas canopy, open sides
  const mumbai = r() < 0.4, lower = kit.paint(mumbai ? "#1a1b1d" : "#2f8a3a"), upper = kit.matte("#e9c21c", 0.75), canvas = kit.matte("#d8b31a", 0.85);
  const parts = new Parts(), root = new THREE.Group(), head: THREE.Mesh[] = [], tail: THREE.Mesh[] = [];
  // rear passenger tub (with its curved back), floor, front driver cowl with the headlamp, and a mudguarded front wheel
  parts.add(loft([{ x: -1.3, yb: 0.36, yt: 0.82, wb: 0.56, n: 4 }, { x: -1.2, yb: 0.3, yt: 0.9, wb: 0.64, n: 5 }, { x: -0.55, yb: 0.3, yt: 0.9, wb: 0.66, n: 6 }, { x: -0.38, yb: 0.3, yt: 0.62, wb: 0.66, n: 6 }], 28), lower);
  parts.add(rbox(-0.45, 0.85, 0.27, 0.36, 0.6), lower);
  parts.add(loft([{ x: 0.55, yb: 0.36, yt: 1.02, wb: 0.42, wt: 0.36, n: 4 }, { x: 0.95, yb: 0.38, yt: 1.02, wb: 0.38, wt: 0.3, n: 4 }, { x: 1.18, yb: 0.45, yt: 0.95, wb: 0.26, wt: 0.2, n: 3 }, { x: 1.25, yb: 0.58, yt: 0.85, wb: 0.14, n: 3 }], 24), lower);
  parts.add(new THREE.TorusGeometry(0.29, 0.05, 6, 16, Math.PI * 0.9).rotateZ(0.1).translate(1.05, 0.24, 0), lower);
  // windscreen (raked, framed) and the canopy over the whole cabin; canopy rails down to the tub
  const ws = loft([{ x: 0.86, yb: 1.0, yt: 1.03, wb: 0.6, n: 4 }, { x: 0.72, yb: 1.0, yt: 1.6, wb: 0.6, n: 4 }, { x: 0.7, yb: 1.58, yt: 1.6, wb: 0.6, n: 4 }], 16);
  ws.scale(1, 1, 1); parts.add(new THREE.BoxGeometry(0.02, 0.58, 1.12).applyMatrix4(M(0.79, 1.3, 0, 0, 0.22)), kit.glass);
  parts.add(new THREE.BoxGeometry(0.05, 0.62, 0.04).applyMatrix4(M(0.79, 1.3, -0.58, 0, 0.22)), kit.trim); parts.add(new THREE.BoxGeometry(0.05, 0.62, 0.04).applyMatrix4(M(0.79, 1.3, 0.58, 0, 0.22)), kit.trim);
  void ws;
  parts.add(loft([{ x: -1.38, yb: 1.5, yt: 1.66, wb: 0.66, n: 3 }, { x: -1.3, yb: 1.52, yt: 1.82, wb: 0.7, n: 3 }, { x: 0.55, yb: 1.56, yt: 1.82, wb: 0.7, n: 3 }, { x: 0.75, yb: 1.58, yt: 1.74, wb: 0.66, n: 3 }], 24), canvas);
  parts.add(new THREE.BoxGeometry(2.1, 0.06, 1.42).translate(-0.3, 1.57, 0), upper); // canopy rim band
  for (const x of [-1.2, -0.45, 0.62]) for (const z of [-0.66, 0.66]) parts.add(tube(V(x, x > 0 ? 1.0 : 0.88, z), V(x + (x > 0 ? 0.06 : 0), 1.56, z * 1.02), 0.018, 6), kit.trim);
  parts.add(new THREE.BoxGeometry(0.06, 0.62, 1.36).translate(-1.32, 1.2, 0), canvas); // rear canvas panel with a small window
  parts.add(new THREE.BoxGeometry(0.02, 0.18, 0.5).translate(-1.36, 1.28, 0), kit.glass);
  // rolled-up side curtains under the canopy edge
  for (const z of [-0.69, 0.69]) parts.add(new THREE.CylinderGeometry(0.035, 0.035, 1.6, 8).rotateZ(Math.PI / 2).translate(-0.35, 1.5, z), canvas);
  // passenger bench + backrest, driver seat, handlebar
  parts.add(rbox(-1.15, -0.55, 0.88, 1.0, 0.6), kit.matte("#2a2a2a", 0.8)); parts.add(rbox(-1.25, -1.13, 0.95, 1.38, 0.6), kit.matte("#2a2a2a", 0.8));
  parts.add(rbox(-0.1, 0.25, 0.86, 0.96, 0.24), kit.matte("#2a2a2a", 0.8));
  parts.add(tube(V(0.62, 1.12, -0.32), V(0.62, 1.12, 0.32), 0.016), kit.trim);
  parts.add(tube(V(0.8, 0.98, 0), V(0.62, 1.12, 0), 0.025), kit.trim);
  rider(kit, { hip: V(0.05, 0.98, 0), hands: [V(0.62, 1.12, -0.3), V(0.62, 1.12, 0.3)], feet: [V(0.62, 0.38, -0.18), V(0.62, 0.38, 0.18)], lean: 0.12, helmet: false, shirt: mumbai ? "#e8e2d2" : "#6b8fb8", pants: "#3a3530" }, parts);
  // lamps: one headlamp on the cowl, indicators, tail lamps on the tub corners, a yellow commercial plate
  const hlLens = kit.headLens(), tl = kit.tailLens();
  lampAt(parts, hlLens, kit.chrome, 1.22, 0.75, 0, 0.16, 0.16, 1, head);
  for (const z of [-0.5, 0.5]) { lampAt(parts, tl, kit.trim, -1.3, 0.62, z, 0.12, 0.1, -1, tail); parts.add(new THREE.BoxGeometry(0.03, 0.04, 0.08).translate(1.08, 0.95, z * 0.6), kit.indicator); }
  root.add(plate(kit, `DL 1RN ${1000 + Math.floor(r() * 9000)}`, true, -1.33, 0.48, -1, 0.42));
  const wr = 0.24, wheels: THREE.Object3D[] = [];
  const fw = wheel(kit, wr, 0.13, "steel"); fw.position.set(1.05, wr, 0); wheels.push(fw); root.add(fw);
  for (const z of [-0.56, 0.56]) { const w = wheel(kit, wr, 0.14, "steel"); w.position.set(-0.85, wr, z); if (z < 0) w.rotation.y = Math.PI; wheels.push(w); root.add(w); }
  arches(parts, kit, -0.85, wr, [-0.66, 0.66], 0.04);
  parts.build(root); root.add(...head, ...tail);
  return { root, wheels, wheelR: wr, head, tail, anchors: { headlamps: [V(1.25, 0.75, 0)], taillamps: [V(-1.32, 0.62, -0.5), V(-1.32, 0.62, 0.5)], exhaust: V(-1.1, 0.25, 0.4), rearWheels: [V(-0.85, 0, -0.56), V(-0.85, 0, 0.56)], length: 2.65, width: 1.4 } };
}

function bus(kit: Kit, r: () => number): VehicleModel {
  const color = PAINTS.bus[Math.floor(r() * PAINTS.bus.length)]!, paint = kit.paint(color), white = kit.paint("#ecebe6");
  const parts = new Parts(), root = new THREE.Group(), head: THREE.Mesh[] = [], tail: THREE.Mesh[] = [];
  const hl = 5.3, W = 1.27;
  // body: rounded roof edges, a raked and rounded front, skirts low over the road
  parts.add(loft([{ x: -hl, yb: 0.36, yt: 3.0, wb: W - 0.06, wt: W - 0.1, n: 7 }, { x: -hl + 0.12, yb: 0.32, yt: 3.12, wb: W, wt: W - 0.04, n: 8 }, { x: hl - 0.4, yb: 0.32, yt: 3.12, wb: W, wt: W - 0.04, n: 8 }, { x: hl - 0.08, yb: 0.32, yt: 3.0, wb: W - 0.02, wt: W - 0.08, n: 7 }, { x: hl, yb: 0.4, yt: 2.85, wb: W - 0.08, wt: W - 0.14, n: 6 }], 36), paint);
  // livery band and a white roof
  for (const z of [-1, 1]) parts.add(new THREE.BoxGeometry(2 * hl - 0.6, 0.22, 0.01).translate(-0.1, 1.25, z * (W + 0.004)), white);
  parts.add(loft([{ x: -hl + 0.2, yb: 3.06, yt: 3.15, wb: W - 0.12, n: 6 }, { x: hl - 0.5, yb: 3.06, yt: 3.15, wb: W - 0.12, n: 6 }], 20), white);
  // side windows: separate panes with black rubber frames and pillars; doors on the kerb side (left = -Z)
  const panes: [number, number][] = [];
  for (let x = -hl + 0.5; x < hl - 1.6; x += 1.22) panes.push([x, x + 1.08]);
  for (const z of [-1, 1]) for (const [x0, x1] of panes) {
    const door = z < 0 && ((x0 < -0.2 && x1 > -0.9) || x1 > hl - 2.9);
    if (door) continue;
    parts.add(new THREE.BoxGeometry(x1 - x0 + 0.06, 0.92, 0.012).translate((x0 + x1) / 2, 2.12, z * (W + 0.006)), kit.trim);
    parts.add(new THREE.BoxGeometry(x1 - x0, 0.84, 0.01).translate((x0 + x1) / 2, 2.12, z * (W + 0.014)), kit.glass);
  }
  // doors: front door behind the front wheel, a middle door; dark glazed leaves with a centre seam and a step
  for (const [x0, x1] of [[hl - 2.75, hl - 1.7], [-0.95, 0.15]] as const) {
    parts.add(new THREE.BoxGeometry(x1 - x0 + 0.08, 2.35, 0.014).translate((x0 + x1) / 2, 1.55, -(W + 0.006)), kit.trim);
    parts.add(new THREE.BoxGeometry(x1 - x0 - 0.06, 2.2, 0.01).translate((x0 + x1) / 2, 1.58, -(W + 0.016)), kit.glass);
    parts.add(new THREE.BoxGeometry(0.03, 2.2, 0.012).translate((x0 + x1) / 2, 1.58, -(W + 0.02)), kit.trim);
    parts.add(new THREE.BoxGeometry(x1 - x0, 0.06, 0.3).translate((x0 + x1) / 2, 0.42, -(W - 0.1)), kit.chrome);
  }
  // front: split windscreen, destination board, grille, bumper, quad lamps, big mirrors
  parts.add(new THREE.BoxGeometry(0.02, 1.4, 2.25).applyMatrix4(M(hl + 0.0, 2.02, 0, 0, -0.08)), kit.glass);
  parts.add(new THREE.BoxGeometry(0.03, 1.46, 0.05).applyMatrix4(M(hl + 0.01, 2.02, 0, 0, -0.08)), kit.trim);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.28), kit.get("busboard", () => {
    if (typeof document === "undefined") return new THREE.MeshStandardMaterial({ color: "#111" });
    const c = document.createElement("canvas"); c.width = 512; c.height = 76; const g = c.getContext("2d")!;
    g.fillStyle = "#0b0b0b"; g.fillRect(0, 0, 512, 76); g.fillStyle = "#ff8a1a"; g.font = "bold 44px Helvetica"; g.textAlign = "center"; g.fillText("502  नई दिल्ली", 256, 54);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map: t, emissive: "#ffffff", emissiveMap: t, emissiveIntensity: kit.night ? 1.4 : 0.6, roughness: 0.4 });
  }));
  board.position.set(hl + 0.012, 2.86, 0); board.rotation.y = Math.PI / 2; root.add(board);
  parts.add(rbox(hl - 0.02, hl + 0.14, 0.34, 0.66, W - 0.04), kit.trim);
  for (let i = 0; i < 5; i++) parts.add(new THREE.BoxGeometry(0.02, 0.03, 1.1).translate(hl + 0.012, 0.85 + i * 0.07, 0), kit.chrome);
  const hlLens = kit.headLens(), tl = kit.tailLens();
  for (const z of [-1, 1]) {
    for (const dz of [0.16, 0.42]) lampAt(parts, hlLens, kit.chrome, hl + 0.02, 0.88, z * (W - dz), 0.18, 0.18, 1, head);
    parts.add(tube(V(hl - 0.1, 2.5, z * (W - 0.05)), V(hl + 0.35, 2.6, z * (W + 0.28)), 0.025), kit.trim);
    parts.add(rbox(hl + 0.28, hl + 0.38, 2.2, 2.6, 0.1).applyMatrix4(M(0, 0, z * (W + 0.3))), kit.trim);
    for (const y of [0.8, 1.15]) lampAt(parts, tl, kit.trim, -hl - 0.01, y, z * (W - 0.2), 0.18, 0.2, -1, tail);
  }
  parts.add(rbox(-hl - 0.14, -hl + 0.02, 0.36, 0.64, W - 0.04), kit.trim);
  for (let i = 0; i < 6; i++) parts.add(new THREE.BoxGeometry(0.02, 0.025, 1.2).translate(-hl - 0.01, 1.5 + i * 0.07, 0), kit.trim); // engine vents
  parts.add(new THREE.BoxGeometry(0.02, 0.9, 2.1).translate(-hl - 0.005, 2.3, 0), kit.glass);
  for (const [x, f] of [[hl + 0.15, 1], [-hl - 0.15, -1]] as const) root.add(plate(kit, `DL 1PC ${1000 + Math.floor(r() * 9000)}`, true, x, 0.55, f, 0.55));
  // interior: seat backs seen through the windows
  for (let x = -hl + 0.8; x < hl - 2.2; x += 0.8) for (const z of [-0.75, 0.75]) parts.add(rbox(x - 0.05, x + 0.05, 1.2, 1.95, 0.4).applyMatrix4(M(0, 0, z)), kit.interior);
  const wr = 0.5, wheels: THREE.Object3D[] = [], fx = hl - 2.05, bx = -hl + 2.6;
  for (const x of [fx, bx]) { arches(parts, kit, x, wr, [-(W + 0.004), W + 0.004], 0.06); for (const z of [-1, 1]) { const w = wheel(kit, wr, 0.3, "steel"); w.position.set(x, wr, z * (W - 0.16)); if (z < 0) w.rotation.y = Math.PI; wheels.push(w); root.add(w); } }
  parts.build(root); root.add(...head, ...tail);
  return { root, wheels, wheelR: wr, head, tail, anchors: { headlamps: [V(hl, 0.88, -0.95), V(hl, 0.88, 0.95)], taillamps: [V(-hl, 1.0, -1.05), V(-hl, 1.0, 1.05)], exhaust: V(-hl + 0.4, 0.3, 1.0), rearWheels: [V(bx, 0, -1.1), V(bx, 0, 1.1)], length: 2 * hl, width: 2 * W } };
}

function motorcycle(kit: Kit, r: () => number, scooter: boolean): VehicleModel {
  const parts = new Parts(), root = new THREE.Group(), head: THREE.Mesh[] = [], tail: THREE.Mesh[] = [];
  const color = PAINTS.two[Math.floor(r() * PAINTS.two.length)]!, paint = kit.paint(color), black = kit.matte("#151515", 0.7);
  const wr = scooter ? 0.24 : 0.3, wb = scooter ? 1.26 : 1.3, fx = wb / 2, rx = -wb / 2;
  const steer = V(fx - (scooter ? 0.18 : 0.16), scooter ? 0.98 : 1.0, 0);
  // front fork from the steering head to the axle, front mudguard
  for (const z of [-0.07, 0.07]) parts.add(tube(steer.clone().add(V(0, 0, z)), V(fx, wr, z), 0.022), scooter ? black : kit.chrome);
  parts.add(new THREE.TorusGeometry(wr + 0.05, 0.035, 6, 16, Math.PI * 0.7).scale(1, 1, 2).rotateZ(0.35).translate(fx, wr, 0), scooter ? paint : kit.matte("#202020", 0.5));
  // handlebar with grips, mirrors, headlamp (+ speedo)
  const bar = steer.clone().add(V(-0.04, 0.1, 0));
  parts.add(tube(bar.clone().add(V(0, 0, -0.34)), bar.clone().add(V(0, 0, 0.34)), 0.016), kit.chrome);
  for (const z of [-0.36, 0.36]) { parts.add(tube(bar.clone().add(V(0, 0, z * 0.82)), bar.clone().add(V(0, 0, z)), 0.022), black); parts.add(tube(bar.clone().add(V(0, 0, z * 0.7)), bar.clone().add(V(-0.04, 0.24, z * 0.9)), 0.008), kit.chrome); parts.add(new THREE.SphereGeometry(0.045, 10, 8).scale(0.4, 0.7, 1).translate(bar.x - 0.04, bar.y + 0.26, z * 0.9), black); }
  const hlLens = kit.headLens(), tl = kit.tailLens();
  if (scooter) {
    // step-through: leg shield (apron), floorboard, rear cowl over the engine, seat; handlebar cowl with the headlamp
    parts.add(loft([{ x: steer.x - 0.06, yb: 0.32, yt: 0.95, wb: 0.2, wt: 0.12, n: 3 }, { x: steer.x + 0.06, yb: 0.36, yt: 0.92, wb: 0.24, wt: 0.14, n: 3 }], 18), paint);
    parts.add(rbox(-0.25, steer.x - 0.05, 0.3, 0.38, 0.17), black);
    parts.add(loft([{ x: -0.3, yb: 0.36, yt: 0.62, wb: 0.18, n: 4 }, { x: -0.15, yb: 0.32, yt: 0.82, wb: 0.2, n: 5 }, { x: -0.55, yb: 0.3, yt: 0.86, wb: 0.21, n: 5 }, { x: -0.88, yb: 0.45, yt: 0.8, wb: 0.15, n: 4 }, { x: -0.95, yb: 0.55, yt: 0.72, wb: 0.09, n: 3 }], 24), paint);
    parts.add(loft([{ x: -0.78, yb: 0.84, yt: 0.9, wb: 0.12, n: 4 }, { x: -0.7, yb: 0.84, yt: 0.95, wb: 0.15, n: 4 }, { x: -0.1, yb: 0.84, yt: 0.95, wb: 0.15, n: 4 }, { x: -0.02, yb: 0.84, yt: 0.9, wb: 0.12, n: 4 }], 18), black);
    parts.add(loft([{ x: bar.x - 0.1, yb: bar.y - 0.06, yt: bar.y + 0.05, wb: 0.12, n: 4 }, { x: bar.x + 0.1, yb: bar.y - 0.08, yt: bar.y + 0.03, wb: 0.14, n: 4 }], 14), paint);
    lampAt(parts, hlLens, kit.chrome, bar.x + 0.11, bar.y - 0.03, 0, 0.14, 0.07, 1, head);
    lampAt(parts, tl, kit.trim, -0.96, 0.66, 0, 0.12, 0.05, -1, tail);
    rider(kit, { hip: V(-0.42, 0.98, 0), hands: [bar.clone().add(V(0, 0, -0.3)), bar.clone().add(V(0, 0, 0.3))], feet: [V(0.05, 0.4, -0.13), V(0.05, 0.4, 0.13)], lean: 0.08, helmet: r() < 0.85, shirt: ["#e8e2d2", "#b8463a", "#3a6a9a", "#e8b8c8"][Math.floor(r() * 4)]!, pants: "#2a2c33" }, parts);
  } else {
    // frame: backbone and down tube; engine with cooling fins; tank; seat; side panel; rear shocks; chain guard; exhaust
    parts.add(tube(steer, V(-0.2, 0.82, 0), 0.03), black); parts.add(tube(steer, V(0.12, 0.38, 0), 0.03), black); parts.add(tube(V(-0.2, 0.82, 0), V(rx, wr + 0.05, 0), 0.025), black);
    parts.add(rbox(-0.2, 0.18, 0.3, 0.62, 0.13), kit.matte("#5f6368", 0.4, 0.6));
    for (let i = 0; i < 5; i++) parts.add(new THREE.BoxGeometry(0.2, 0.012, 0.22).translate(0.04, 0.48 + i * 0.035, 0), kit.matte("#8a8f95", 0.35, 0.7));
    parts.add(loft([{ x: -0.18, yb: 0.82, yt: 0.9, wb: 0.12, n: 3 }, { x: -0.08, yb: 0.8, yt: 1.03, wb: 0.17, n: 3 }, { x: 0.22, yb: 0.82, yt: 1.06, wb: 0.18, n: 3 }, { x: 0.4, yb: 0.88, yt: 1.0, wb: 0.12, n: 3 }], 22), paint);
    parts.add(loft([{ x: -0.72, yb: 0.86, yt: 0.9, wb: 0.08, n: 4 }, { x: -0.62, yb: 0.85, yt: 0.95, wb: 0.12, n: 4 }, { x: -0.2, yb: 0.85, yt: 0.96, wb: 0.13, n: 4 }, { x: -0.12, yb: 0.85, yt: 0.92, wb: 0.1, n: 4 }], 18), black);
    parts.add(loft([{ x: -0.5, yb: 0.62, yt: 0.82, wb: 0.12, n: 4 }, { x: -0.25, yb: 0.6, yt: 0.84, wb: 0.14, n: 4 }], 14), paint);
    for (const z of [-0.12, 0.12]) parts.add(tube(V(-0.42, 0.86, z), V(rx + 0.02, wr + 0.05, z), 0.022), kit.chrome);
    parts.add(rbox(rx, 0.0, 0.32, 0.4, 0.03).applyMatrix4(M(0, 0, -0.1)), black);
    parts.add(tube(V(0.12, 0.4, 0.08), V(-0.15, 0.3, 0.16), 0.03), kit.chrome);
    parts.add(loft([{ x: -0.15, yb: 0.27, yt: 0.33, wb: 0.03, n: 3 }, { x: -0.1, yb: 0.25, yt: 0.37, wb: 0.055, n: 3 }, { x: -0.6, yb: 0.32, yt: 0.44, wb: 0.055, n: 3 }, { x: -0.65, yb: 0.34, yt: 0.42, wb: 0.04, n: 3 }], 14).translate(0, 0, 0.17), kit.chrome);
    parts.add(new THREE.TorusGeometry(wr + 0.06, 0.04, 6, 14, Math.PI * 0.55).scale(1, 1, 2).rotateZ(1.25).translate(rx, wr, 0), black);
    // round headlamp in a chrome bezel, speedo, tail light and plate
    parts.add(new THREE.CylinderGeometry(0.1, 0.09, 0.08, 18).rotateZ(Math.PI / 2).translate(steer.x + 0.09, steer.y - 0.02, 0), kit.chrome);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.085, 18).rotateY(Math.PI / 2), hlLens); lens.position.set(steer.x + 0.135, steer.y - 0.02, 0); head.push(lens);
    parts.add(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 14).rotateZ(1.2).translate(steer.x, steer.y + 0.1, 0), black);
    lampAt(parts, tl, kit.trim, -0.78, 0.86, 0, 0.12, 0.06, -1, tail);
    rider(kit, { hip: V(-0.38, 1.0, 0), hands: [bar.clone().add(V(0, 0, -0.32)), bar.clone().add(V(0, 0, 0.32))], feet: [V(-0.02, 0.38, -0.2), V(-0.02, 0.38, 0.2)], lean: 0.26, helmet: r() < 0.85, shirt: ["#2c2f38", "#b8463a", "#e8e2d2", "#4a6a3a"][Math.floor(r() * 4)]!, pants: "#22252b" }, parts);
  }
  root.add(plate(kit, `DL ${4 + Math.floor(r() * 6)}S ${1000 + Math.floor(r() * 9000)}`, false, scooter ? -0.97 : -0.8, scooter ? 0.56 : 0.72, -1, 0.24));
  const wheels: THREE.Object3D[] = [];
  for (const x of [fx, rx]) { const w = wheel(kit, wr, scooter ? 0.1 : 0.11, scooter ? "scooter" : r() < 0.5 ? "wire" : "alloy"); w.position.set(x, wr, 0); wheels.push(w); root.add(w); }
  parts.build(root); root.add(...head, ...tail);
  return { root, wheels, wheelR: wr, head, tail, anchors: { headlamps: [V(steer.x + 0.14, steer.y, 0)], taillamps: [V(-0.8, 0.8, 0)], exhaust: scooter ? V(-0.75, 0.28, 0.15) : V(-0.66, 0.38, 0.17), rearWheels: [V(rx, 0, 0)], length: wb + 2 * wr, width: 0.75 } };
}

function bicycle(kit: Kit, r: () => number): VehicleModel {
  const parts = new Parts(), root = new THREE.Group(), frame = kit.paint(["#2a5a8a", "#8a2a2a", "#1d1d1f", "#3a6a3a"][Math.floor(r() * 4)]!), wr = 0.34, wb = 1.05;
  const BB = V(-0.02, wr, 0), seat = V(-0.24, 0.98, 0), headT = V(0.36, 0.92, 0), fx = wb / 2, rx = -wb / 2;
  for (const [a, b] of [[V(rx, wr, 0), BB], [BB, seat], [seat, headT], [headT, BB], [V(rx, wr, 0), seat]] as const) parts.add(tube(a, b, 0.017), frame);
  for (const z of [-0.04, 0.04]) parts.add(tube(headT.clone().add(V(0, 0, z)), V(fx, wr, z), 0.012), kit.chrome);
  parts.add(tube(headT, headT.clone().add(V(-0.04, 0.18, 0)), 0.014), kit.chrome);
  const bar = headT.clone().add(V(-0.05, 0.19, 0));
  parts.add(tube(bar.clone().add(V(0, 0, -0.27)), bar.clone().add(V(0, 0, 0.27)), 0.012), kit.chrome);
  parts.add(loft([{ x: seat.x - 0.1, yb: seat.y + 0.01, yt: seat.y + 0.05, wb: 0.07, n: 3 }, { x: seat.x + 0.12, yb: seat.y + 0.01, yt: seat.y + 0.04, wb: 0.03, n: 3 }], 12), kit.matte("#111", 0.6));
  parts.add(new THREE.TorusGeometry(0.1, 0.012, 6, 18).translate(BB.x, BB.y, 0.05), kit.chrome);
  const pedals = new THREE.Group(); pedals.position.copy(BB); root.add(pedals);
  for (const s of [1, -1]) { const c = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.17, 0.02), kit.chrome); c.position.set(0, -0.085 * s, 0.09 * s); pedals.add(c); const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.08), kit.trim); p.position.set(0, -0.17 * s, 0.13 * s); pedals.add(p); }
  const hip = seat.clone().add(V(0.02, 0.08, 0));
  const out = rider(kit, { hip, hands: [bar.clone().add(V(0, 0, -0.24)), bar.clone().add(V(0, 0, 0.24))], feet: [BB, BB], lean: 0.32, helmet: false, shirt: ["#d8572a", "#2a8ad8", "#ffffff", "#e8d24a"][Math.floor(r() * 4)]!, pants: "#2a2c33" }, parts, true);
  const legs = out.legs!;
  const wheels: THREE.Object3D[] = [];
  for (const x of [fx, rx]) { const w = wheel(kit, wr, 0.04, "wire"); w.position.set(x, wr, 0); wheels.push(w); root.add(w); }
  parts.build(root);
  const tmp = new THREE.Quaternion(), Y = V(0, 1, 0);
  const place = (m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void => { m.position.copy(a).add(b).multiplyScalar(0.5); m.quaternion.copy(tmp.setFromUnitVectors(Y, b.clone().sub(a).normalize())); };
  return {
    root, wheels, wheelR: wr, head: [], tail: [], pedals,
    anchors: { headlamps: [], taillamps: [], exhaust: null, rearWheels: [V(rx, 0, 0)], length: wb + 2 * wr, width: 0.6 },
    legs: {
      // each foot on its pedal (crank 0.17 m), the knee by IK toward the front: a real pedal stroke
      update(crank: number): void {
        for (const [i, s] of [[0, 1], [1, -1]] as const) {
          const a = crank + (s > 0 ? 0 : Math.PI), ft = V(BB.x + Math.sin(a) * 0.17, BB.y - Math.cos(a) * 0.17, 0.13 * s), hp = hip.clone().add(V(0, 0, 0.1 * s));
          const kn = knee(hp, ft, 0.47, 0.44, V(1, 0.6, 0));
          place(legs.thigh[i]!, hp, kn); place(legs.shin[i]!, kn, ft); legs.foot[i]!.position.copy(ft).add(V(0.05, 0, 0));
        }
      },
    },
  };
}

/** Builds a fresh model of a kind (seeded variety: body style, colours, livery). */
export function buildVehicle(kind: VehicleKind, kit: Kit, seed: number): VehicleModel {
  const r = mulberry(seed);
  const m = kind === "car" ? car(kit, r) : kind === "auto" ? auto(kit, r) : kind === "bus" ? bus(kit, r) : kind === "bicycle" ? bicycle(kit, r) : motorcycle(kit, r, kind === "scooter");
  m.root.name = `vehicle:${kind}`;
  return m;
}
