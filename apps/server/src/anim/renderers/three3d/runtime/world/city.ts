import * as THREE from "three";
import type { KitCtx, Clamp } from "../kits";
import { mulberry } from "./noise";
import { straightLane, type Lane } from "./vehicles";

/**
 * An Indian city street. The action is on the near pavement (z -0.8 .. 5, the stage at z ~2.6, the camera in front of it);
 * the road runs BEHIND the actors (z -12 .. -0.8, two lanes each way), so traffic crosses the background and never the
 * camera. Across the road: a far pavement and a row of multi-storey buildings (shop fronts with Hindi / English boards,
 * shutters, balconies, AC units, water tanks, wires), streetlights on both pavements. Wet: the asphalt darkens and
 * smooths and the lights streak on it. Night: lit windows (a seeded pattern), lit shops and signs, sodium streetlights.
 */
export interface CityLayout { clamp: Clamp; lanes: Lane[]; sidewalk: { z: number; x0: number; x1: number } }

const std = (o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial(o);
function tex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t;
}
const SHOPS = [["मेडिकल स्टोर", "#1f6f4a"], ["CHAI CORNER", "#7a1f2b"], ["मोबाइल रिपेयर", "#1f3f8a"], ["SWEETS", "#b8571f"], ["किराना", "#8a6a1f"], ["TAILOR", "#4a2a6a"], ["फोटो स्टूडियो", "#2a6a6a"], ["BOOK DEPOT", "#6a2a2a"]] as const;

/** A facade texture: storeys of windows (frames, curtains, some lit at night) over a shop front with a board. */
function facade(r: () => number, wall: string, floors: number, bays: number, night: boolean, shop: readonly [string, string]): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const W = 128 * bays, H = 128 * (floors + 1);
  const lit: boolean[] = Array.from({ length: floors * bays }, () => night && r() < 0.45);
  const draw = (emit: boolean) => (g: CanvasRenderingContext2D): void => {
    g.fillStyle = emit ? "#000" : wall; g.fillRect(0, 0, W, H);
    if (!emit) for (let i = 0; i < 600; i++) { g.fillStyle = `rgba(${r() < 0.5 ? "0,0,0" : "255,255,255"},${r() * 0.07})`; g.fillRect(r() * W, r() * H, 3 + r() * 30, 2 + r() * 40); }
    for (let f = 0; f < floors; f++) for (let b = 0; b < bays; b++) {
      const x = b * 128 + 26, y = f * 128 + 24, on = lit[f * bays + b]!;
      if (emit) { if (on) { g.fillStyle = r() < 0.5 ? "#ffd9a0" : "#e8f0ff"; g.fillRect(x + 4, y + 4, 68, 74); } continue; }
      g.fillStyle = "#e9e4da"; g.fillRect(x - 4, y - 4, 84, 90);
      g.fillStyle = on ? "#f1cf8a" : "#2c3440"; g.fillRect(x + 4, y + 4, 68, 74);
      g.fillStyle = ["#a33", "#36a", "#c8a24a", "#5a8a5a"][Math.floor(r() * 4)]!; if (r() < 0.6) g.fillRect(x + 4, y + 4, 22 + r() * 20, 74);
      g.fillStyle = "#e9e4da"; g.fillRect(x + 36, y + 4, 4, 74);
    }
    // the shop: a lit interior or a rolling shutter, and the board above it
    const sy = floors * 128;
    if (!emit) { g.fillStyle = "#3a3a3a"; g.fillRect(0, sy, W, 128); }
    for (let b = 0; b < bays; b++) {
      const open = (b + floors) % 3 !== 0, x = b * 128 + 8;
      if (emit) { if (open && night) { g.fillStyle = "#ffd8a0"; g.fillRect(x, sy + 40, 112, 84); } continue; }
      if (open) { g.fillStyle = "#c9a878"; g.fillRect(x, sy + 40, 112, 84); for (let k = 0; k < 14; k++) { g.fillStyle = ["#c33", "#3a3", "#33c", "#cc3", "#c6c"][k % 5]!; g.fillRect(x + 6 + (k % 7) * 15, sy + 50 + Math.floor(k / 7) * 34, 10, 22); } }
      else { g.fillStyle = "#8a8f94"; g.fillRect(x, sy + 40, 112, 84); for (let k = 0; k < 14; k++) { g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(x, sy + 44 + k * 6, 112, 2); } }
    }
    g.fillStyle = emit ? (night ? "#ffffff" : "#000") : shop[1]; g.fillRect(4, sy + 4, W - 8, 34);
    if (!emit) { g.fillStyle = "#fff6e0"; g.font = "bold 26px 'Kohinoor Devanagari', 'Devanagari Sangam MN', Helvetica"; g.textAlign = "center"; g.fillText(shop[0], W / 2, sy + 31); }
  };
  const map = tex(W, H, draw(false)), emissive = tex(W, H, draw(true));
  return { map, emissive };
}

export function cityKit(ctx: KitCtx, o: { lanes: 1 | 2 | 4; streetlights: boolean }): CityLayout {
  const { r, day, wet, add, group } = ctx, night = !day;
  const rr = mulberry(97);
  // the road surface is the set's asphalt ground (wet-aware): markings, a zebra crossing, kerbs, pavements
  const roadZ0 = -12, roadZ1 = -0.8;
  const paint = std({ color: "#e8e6dc", roughness: 0.6, emissive: night ? "#2a2a26" : "#000000" });
  for (let x = -70; x < 70; x += 6) add(new THREE.Mesh(new THREE.BoxGeometry(3, 0.012, 0.14), paint), false).position.set(x, 0.008, (roadZ0 + roadZ1) / 2);
  for (const z of [-3.6, -9.2]) for (let x = -70; x < 70; x += 4) add(new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.012, 0.1), paint), false).position.set(x, 0.008, z);
  for (let k = 0; k < 9; k++) add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.013, 10.6), paint), false).position.set(9 + k * 0.9, 0.009, (roadZ0 + roadZ1) / 2);
  const paveTex = tex(256, 256, (g) => { g.fillStyle = "#9c968c"; g.fillRect(0, 0, 256, 256); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { g.fillStyle = `rgba(${rr() < 0.5 ? "0,0,0" : "255,255,255"},${0.04 + rr() * 0.06})`; g.fillRect(i * 64 + 2, j * 64 + 2, 60, 60); } g.strokeStyle = "rgba(40,40,40,0.5)"; for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, 256); g.moveTo(0, i * 64); g.lineTo(256, i * 64); g.stroke(); } });
  paveTex.repeat.set(70, 3);
  const pave = std({ map: paveTex, roughness: Math.max(0.25, 0.85 - 0.55 * wet), metalness: 0.02 });
  const kerb = std({ color: "#c9c2b4", roughness: 0.7 });
  for (const [z0, z1] of [[roadZ1, 6.5], [-16, roadZ0]] as const) {
    add(new THREE.Mesh(new THREE.BoxGeometry(140, 0.16, z1 - z0), pave), false).position.set(0, 0.08, (z0 + z1) / 2);
    add(new THREE.Mesh(new THREE.BoxGeometry(140, 0.18, 0.22), kerb), false).position.set(0, 0.09, z0 === roadZ1 ? roadZ1 : roadZ0);
  }
  // buildings across the road, and a row behind the camera (seen in reverse angles)
  const walls = ["#d9c9a8", "#c8a68a", "#b8c4c8", "#e2d4b8", "#c9b0b0", "#a8b89a", "#d8b878"];
  const row = (z: number, face: 1 | -1, x0: number, x1: number): void => {
    for (let x = x0; x < x1;) {
      const bays = 2 + Math.floor(r() * 3), w = bays * 3.2, floors = 2 + Math.floor(r() * 4), h = (floors + 1) * 3.2, d = 10;
      const f = facade(r, walls[Math.floor(r() * walls.length)]!, floors, bays, night, SHOPS[Math.floor(r() * SHOPS.length)]!);
      const front = std({ map: f.map, emissiveMap: f.emissive, emissive: night ? "#ffffff" : "#000000", emissiveIntensity: night ? 1.2 : 0, roughness: Math.max(0.35, 0.9 - 0.4 * wet) });
      const side = std({ color: walls[Math.floor(r() * walls.length)]!, roughness: 0.9 });
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, side, side, face > 0 ? front : side, face > 0 ? side : front]);
      b.position.set(x + w / 2, h / 2, z - (face * d) / 2); add(b);
      // balconies with railings, AC units, a water tank and a dish on the roof
      for (let fl = 1; fl < floors; fl++) if (r() < 0.6) { const bx = x + 1.6 + Math.floor(r() * bays) * 3.2; add(new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 0.9), side)).position.set(bx, (floors - fl) * 3.2 + 3.2 * 0.95, z + face * 0.45); add(new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 0.04), std({ color: "#2a2a2a", roughness: 0.5, metalness: 0.6, wireframe: false }))).position.set(bx, (floors - fl) * 3.2 + 3.2 * 0.95 + 0.5, z + face * 0.88); }
      for (let k = 0; k < bays; k++) if (r() < 0.5) add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.45), std({ color: "#e8e8e2", roughness: 0.5 }))).position.set(x + 1 + k * 3.2, 3.2 * (2 + Math.floor(r() * floors)) - 0.6, z + face * 0.25);
      if (r() < 0.8) add(new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.4, 16), std({ color: "#2a2a2a", roughness: 0.6 }))).position.set(x + w * (0.3 + r() * 0.4), h + 0.7, z - face * 3);
      x += w + 0.15;
    }
  };
  row(-16.2, 1, -72, 72);
  row(13.5, -1, -72, 72);
  // overhead cables across the far pavement poles
  const poleM = std({ color: "#5a5a58", roughness: 0.8, metalness: 0.4 });
  // streetlights: tall poles with an arm; lit heads at night (two real lights near the action, glows elsewhere)
  if (o.streetlights) {
    const headM = std({ color: night ? "#ffd59a" : "#d8d8d0", emissive: night ? "#ffb14a" : "#000000", emissiveIntensity: night ? 3 : 0, roughness: 0.3 });
    let lights = 0;
    for (const [z, face] of [[-0.3, -1], [-12.6, 1]] as const) for (let x = -56; x <= 56; x += 16) {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 7.5, 10), poleM)).position.set(x, 3.75, z);
      add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 1.8), poleM)).position.set(x, 7.4, z + face * 0.9);
      const head = add(new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.6), headM)); head.position.set(x, 7.3, z + face * 1.7);
      if (night && Math.abs(x) <= 16 && lights < 3) { const l = new THREE.SpotLight("#ffbf6a", 160, 22, 0.9, 0.7, 1.6); l.position.copy(head.position); l.target.position.set(x, 0, z + face * 3); group.add(l, l.target); lights++; }
    }
  }
  // wet night: the lights streak on the road (cheap fake reflections that read like the real thing on a phone)
  if (night && wet > 0.3) {
    const streakTex = tex(32, 256, (g) => { const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(0.5, "rgba(255,255,255,0.9)"); gr.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = gr; g.fillRect(8, 0, 16, 256); });
    for (const [z, face] of [[-0.3, -1], [-12.6, 1]] as const) for (let x = -56; x <= 56; x += 16) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 6), new THREE.MeshBasicMaterial({ map: streakTex, color: "#ffb35a", transparent: true, opacity: 0.55 * wet, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.rotation.x = -Math.PI / 2; s.position.set(x, 0.02, z + face * 4.5); group.add(s);
    }
  }
  // lanes: two each way; +x on the near side, -x on the far side
  const lanes: Lane[] = [];
  const zs = o.lanes === 4 ? [[-2.2, 1], [-5.0, 1], [-7.8, -1], [-10.6, -1]] : o.lanes === 2 ? [[-3.6, 1], [-9.2, -1]] : [[-4.5, 1]];
  for (const [z, d] of zs as [number, 1 | -1][]) lanes.push(d > 0 ? straightLane(-75, 75, z) : straightLane(75, -75, z));
  return { lanes, sidewalk: { z: -14, x0: -45, x1: 45 }, clamp: (p) => { if (p.z < 0.2) p.z = 0.2; if (p.z > 12.5) p.z = 12.5; if (p.y < 0.4) p.y = 0.4; } };
}
