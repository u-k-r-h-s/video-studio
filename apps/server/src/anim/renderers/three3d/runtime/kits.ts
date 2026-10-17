import * as THREE from "three";
import type { EnvironmentSpec3D } from "../spec";

/**
 * More set kits: an Indian village lane, a bazaar, a home interior and a country road. Same contract as the street and the
 * warehouse (environment.ts): a facade at z = DZ with a working door (`doorway`), the action area in front of it, and the
 * named points the compiler stages against (door, door-front, approach, address, doorbell). Every kit lights itself at
 * night (bulbs, string lights, a tube light, a candle in a power cut): the story's time of day decides, not the kit.
 */
export interface KitCtx {
  spec: EnvironmentSpec3D;
  group: THREE.Group;
  ground: THREE.Mesh;
  r: () => number;
  day: boolean;
  wet: number;
  DX: number;
  DZ: number;
  add: <T extends THREE.Object3D>(o: T, cast?: boolean) => T;
  mark: (id: string, p: THREE.Vector3) => void;
  doorway: (o: { dw: number; dh: number; leafColor: string; leafTex?: THREE.Texture; frameColor: string; glow: string; cold: string; inside: string }) => void;
  updates: ((t: number, dt: number, cam: THREE.Vector3) => void)[];
}
export type Clamp = (p: THREE.Vector3) => void;

const std = (o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial(o);
function tex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const box = (w: number, h: number, d: number, m: THREE.Material): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
const shade = (hex: string, k: number): string => { const c = new THREE.Color(hex); c.multiplyScalar(k); return `#${c.getHexString()}`; };

/** Lime / mud plaster: a base colour with blotches, cracks and a darker plinth. */
function plaster(color: string, r: () => number): THREE.CanvasTexture {
  return tex(512, 512, (g) => {
    g.fillStyle = color; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(${r() < 0.5 ? "60,40,20" : "255,250,235"},${r() * 0.06})`; const s = 4 + r() * 40; g.beginPath(); g.arc(r() * 512, r() * 512, s, 0, 7); g.fill(); }
    g.strokeStyle = "rgba(60,40,25,0.25)"; g.lineWidth = 1;
    for (let i = 0; i < 14; i++) { g.beginPath(); let x = r() * 512, y = r() * 512; g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 40; y += r() * 30; g.lineTo(x, y); } g.stroke(); }
    const grd = g.createLinearGradient(0, 420, 0, 512); grd.addColorStop(0, "rgba(70,45,25,0)"); grd.addColorStop(1, "rgba(70,45,25,0.45)"); g.fillStyle = grd; g.fillRect(0, 420, 512, 92);
  });
}
/** Packed earth with footprints, pebbles and (wet) dark patches. */
function dirt(r: () => number, wet: number): THREE.CanvasTexture {
  return tex(1024, 1024, (g) => {
    g.fillStyle = wet > 0.4 ? "#5e4a36" : "#a8865f"; g.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 4000; i++) { const v = r(); g.fillStyle = `rgba(${v < 0.5 ? "70,50,30" : "200,175,140"},${0.05 + r() * 0.12})`; g.fillRect(r() * 1024, r() * 1024, 2 + r() * 6, 2 + r() * 6); }
    if (wet > 0.3) for (let i = 0; i < 30; i++) { g.fillStyle = `rgba(30,25,20,${0.25 * wet})`; g.beginPath(); g.ellipse(r() * 1024, r() * 1024, 20 + r() * 80, 10 + r() * 30, r() * 3, 0, 7); g.fill(); }
  });
}
function tiles(a: string, b: string, n = 8): THREE.CanvasTexture {
  return tex(512, 512, (g) => { const s = 512 / n; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { g.fillStyle = (i + j) % 2 ? a : b; g.fillRect(i * s, j * s, s, s); g.strokeStyle = "rgba(0,0,0,0.15)"; g.strokeRect(i * s, j * s, s, s); } });
}
function sign(text: string, bg: string, fg: string): THREE.CanvasTexture {
  return tex(512, 160, (g) => { g.fillStyle = bg; g.fillRect(0, 0, 512, 160); g.strokeStyle = fg; g.lineWidth = 6; g.strokeRect(8, 8, 496, 144); g.fillStyle = fg; g.font = "bold 84px 'Kohinoor Devanagari', 'Devanagari Sangam MN', sans-serif"; g.textAlign = "center"; g.fillText(text, 256, 112); });
}
/** A warm practical light with a visible glowing source (bulb, lantern, string bulb). */
function practical(ctx: KitCtx, p: THREE.Vector3, color: string, intensity: number, range: number, size = 0.07, flicker = 0): THREE.PointLight {
  const l = new THREE.PointLight(color, intensity, range, 1.8); l.position.copy(p); ctx.group.add(l);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), new THREE.MeshBasicMaterial({ color })); bulb.position.copy(p); ctx.group.add(bulb);
  if (flicker) ctx.updates.push((t) => { l.intensity = intensity * (1 - flicker * 0.5 + flicker * 0.5 * (Math.sin(t * 17) * Math.sin(t * 7.3 + 1) * 0.5 + 0.5)); });
  return l;
}
function tree(ctx: KitCtx, x: number, z: number, s: number, leaf = "#3f6b2e"): void {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.scale.setScalar(s);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.28, 3.2, 10), std({ color: "#5b4632", roughness: 0.95 })); trunk.position.y = 1.6; g.add(trunk);
  const crown = new THREE.Group(); crown.position.y = 3.6; g.add(crown);
  for (let i = 0; i < 7; i++) { const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9 + ctx.r() * 0.7, 1), std({ color: shade(leaf, 0.8 + ctx.r() * 0.35), roughness: 0.9, flatShading: true })); b.position.set((ctx.r() - 0.5) * 2.4, (ctx.r() - 0.3) * 1.4, (ctx.r() - 0.5) * 2.4); crown.add(b); }
  ctx.add(g);
  const wind = ctx.spec.weather?.wind ?? 0.4, ph = ctx.r() * 6;
  ctx.updates.push((t) => { crown.rotation.z = Math.sin(t * 0.8 + ph) * 0.03 * wind; crown.rotation.x = Math.sin(t * 0.6 + ph) * 0.02 * wind; });
}
/** Distant flat-coloured silhouettes (houses, hills, tree lines): depth without detail. */
function far(ctx: KitCtx, color: string, z: number, n: number, hmin: number, hmax: number): void {
  for (let i = 0; i < n; i++) { const h = hmin + ctx.r() * (hmax - hmin), w = 3 + ctx.r() * 6; ctx.add(box(w, h, 2, std({ color, roughness: 1 })), false).position.set(-50 + (i / n) * 100 + ctx.r() * 3, h / 2, z - ctx.r() * 6); }
}

/** An Indian village lane: plastered houses with flat roofs and parapets, a tiled and a thatched neighbour, a charpai, pots, a hand pump, a neem tree, fields beyond. */
export function villageKit(ctx: KitCtx): Clamp {
  const { DX, DZ, r, day, wet, add, spec } = ctx;
  const pal = spec.palette ?? {};
  const wall = pal.wall ?? ["#d9b26f", "#cf8f5c", "#9fb7c9", "#e3d5b8", "#c98f9a"][Math.floor(r() * 5)]!, doorC = pal.door ?? ["#2f5d8a", "#7a3b2a", "#2e6b4f", "#6b4a8a"][Math.floor(r() * 4)]!, trim = pal.trim ?? "#f1e7d2";
  const dirtTex = dirt(r, wet); dirtTex.repeat.set(10, 10);
  (ctx.ground.material as THREE.MeshStandardMaterial).map = dirtTex; (ctx.ground.material as THREE.MeshStandardMaterial).color.set(day ? "#ffffff" : "#b9b0a6"); (ctx.ground.material as THREE.MeshStandardMaterial).roughnessMap = null;
  const wallMat = std({ map: plaster(wall, r), roughness: 0.95 }); (wallMat.map as THREE.Texture).repeat.set(2, 1);
  // the main house: front wall with the door, flat roof with a parapet, two shuttered windows, a raised platform (chabutra) and steps
  const hw = 9, hh = 3.4, hd = 7, dw = 1.15, dh = 2.1;
  const lw = hw / 2 + DX - dw / 2, rw = hw / 2 - DX - dw / 2;
  add(box(lw, hh, 0.3, wallMat)).position.set(DX - dw / 2 - lw / 2, hh / 2, DZ);
  add(box(rw, hh, 0.3, wallMat)).position.set(DX + dw / 2 + rw / 2, hh / 2, DZ);
  add(box(dw, hh - dh, 0.3, wallMat)).position.set(DX, dh + (hh - dh) / 2, DZ);
  add(box(hw, hh, hd, wallMat)).position.set(DX, hh / 2, DZ - hd / 2 - 0.16);
  const parapet = std({ color: shade(wall, 0.88), roughness: 0.95 });
  add(box(hw + 0.2, 0.45, 0.2, parapet)).position.set(DX, hh + 0.22, DZ + 0.02);
  add(box(hw + 0.3, 0.12, hd + 0.3, std({ color: "#8a7a66", roughness: 1 }))).position.set(DX, hh + 0.02, DZ - hd / 2);
  const wood = std({ color: shade(doorC, 0.9), roughness: 0.8 });
  for (const x of [DX - 2.8, DX + 2.8]) {
    add(box(1.0, 1.1, 0.12, std({ color: "#1e1a16", roughness: 0.9 }))).position.set(x, 1.7, DZ + 0.13);
    for (const sx of [-1, 1]) { const sh = add(box(0.5, 1.1, 0.06, wood)); sh.position.set(x + sx * 0.78, 1.7, DZ + 0.2); sh.rotation.y = sx * 0.5; }
    for (let k = -2; k <= 2; k++) add(box(0.03, 1.1, 0.05, std({ color: "#3a3a3a", metalness: 0.8, roughness: 0.4 }))).position.set(x + k * 0.18, 1.7, DZ + 0.19);
  }
  // a low plinth along the wall and one step at the door (people stand in front of it, not in it)
  add(box(hw, 0.22, 0.45, std({ color: shade(wall, 0.75), roughness: 1 }))).position.set(DX, 0.11, DZ + 0.38);
  add(box(1.4, 0.12, 0.35, std({ color: shade(wall, 0.7), roughness: 1 }))).position.set(DX, 0.06, DZ + 0.75);
  // a painted name and number by the door (the "address"), a bell rope / switch (the "doorbell")
  const nameplate = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.28), std({ map: sign("घर 7", "#f2e6c8", "#7a2a1a"), roughness: 0.7 })); nameplate.position.set(DX + dw / 2 + 0.75, 2.35, DZ + 0.16); ctx.group.add(nameplate);
  ctx.mark("address", nameplate.position.clone());
  const bell = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.03), std({ color: "#d8d2c0", roughness: 0.6 })); bell.position.set(DX + dw / 2 + 0.2, 1.35, DZ + 0.16); ctx.group.add(bell);
  ctx.mark("doorbell", bell.position.clone());
  ctx.doorway({ dw, dh, leafColor: doorC, frameColor: trim, glow: "#ffcf8a", cold: "#ffe2b0", inside: "#6a5642" });
  // a bare bulb over the door: the light of the lane at night
  if (!day) practical(ctx, new THREE.Vector3(DX, dh + 0.45, DZ + 0.35), "#ffc87a", 22, 9, 0.06);
  // neighbours: a clay-tiled house and a thatched hut, set back; a low boundary wall
  const tileRoof = std({ color: "#9a4a32", roughness: 0.85, flatShading: true });
  const nb = (x: number, color: string, kind: "tile" | "thatch"): void => {
    const m = std({ map: plaster(color, r), roughness: 0.95 });
    add(box(6, 2.9, 6, m)).position.set(x, 1.45, DZ - 3.5);
    if (kind === "tile") { const g = new THREE.CylinderGeometry(0.01, 4.6, 1.6, 4, 1); g.rotateY(Math.PI / 4); g.scale(1, 1, 1.05); add(new THREE.Mesh(g, tileRoof)).position.set(x, 3.7, DZ - 3.5); }
    else add(new THREE.Mesh(new THREE.ConeGeometry(4.6, 2.2, 10), std({ color: "#b39463", roughness: 1, flatShading: true }))).position.set(x, 4.0, DZ - 3.5);
    add(box(0.9, 1.9, 0.1, std({ color: shade(doorC, 0.6), roughness: 0.8 }))).position.set(x + 1, 0.95, DZ + 0.02);
  };
  nb(DX - 11, ["#e6d3b0", "#b7c9a8", "#d7a98a"][Math.floor(r() * 3)]!, "tile"); nb(DX + 11, "#d8c59e", "thatch");
  add(box(5, 0.9, 0.3, wallMat)).position.set(DX - 7.5, 0.45, DZ + 2.4); add(box(5, 0.9, 0.3, wallMat)).position.set(DX + 7.5, 0.45, DZ + 2.4);
  // a charpai (woven cot), a cluster of matkas (clay pots), a hand pump, a laundry line
  // set dressing to the left of the door, clear of where conversations are staged (right of the door, in front)
  const cot = new THREE.Group(); cot.position.set(DX - 4.6, 0, DZ + 1.6); cot.rotation.y = -0.25;
  const frame = std({ color: "#6b4a2b", roughness: 0.8 });
  for (const [x, z] of [[-0.9, -0.45], [0.9, -0.45], [-0.9, 0.45], [0.9, 0.45]] as const) { const leg = box(0.08, 0.45, 0.08, frame); leg.position.set(x, 0.22, z); cot.add(leg); }
  const weave = tex(256, 128, (g) => { g.fillStyle = "#c9b58a"; g.fillRect(0, 0, 256, 128); g.strokeStyle = "#8a6f45"; g.lineWidth = 2; for (let i = 0; i < 256; i += 8) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i - 64, 128); g.stroke(); g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64, 128); g.stroke(); } });
  const bed = box(1.9, 0.06, 0.95, std({ map: weave, roughness: 1 })); bed.position.y = 0.46; cot.add(bed);
  add(cot);
  const clay = std({ color: "#a5583a", roughness: 0.7 });
  for (let i = 0; i < 3; i++) { const p = new THREE.Mesh(new THREE.SphereGeometry(0.22 - i * 0.03, 16, 12), clay); p.scale.y = 0.9; p.position.set(DX - 2.4 + i * 0.42, 0.2, DZ + 0.9 + (i % 2) * 0.25); add(p); }
  const pump = new THREE.Group(); pump.position.set(DX - 5.2, 0, DZ + 3.4);
  const iron = std({ color: "#2f4f6f", metalness: 0.6, roughness: 0.5 });
  const post = box(0.14, 1.1, 0.14, iron); post.position.y = 0.55; pump.add(post);
  const spout = box(0.3, 0.07, 0.07, iron); spout.position.set(0.18, 0.8, 0); pump.add(spout);
  const handle = box(0.6, 0.05, 0.05, iron); handle.position.set(-0.3, 1.1, 0); handle.rotation.z = 0.25; pump.add(handle);
  const basin = box(0.9, 0.12, 0.7, std({ color: "#8a8a82", roughness: 0.9 })); basin.position.set(0.25, 0.06, 0); pump.add(basin);
  add(pump);
  const line = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(DX - 9, 2.4, DZ + 0.5), new THREE.Vector3(DX - 6.5, 2.1, DZ + 0.7), new THREE.Vector3(DX - 4, 2.4, DZ + 0.5)]), 20, 0.01, 4), std({ color: "#222" }));
  add(line, false);
  for (let i = 0; i < 4; i++) { const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.7), std({ color: ["#c0392b", "#e1b12c", "#2980b9", "#f5f0e6"][i]!, roughness: 0.9, side: THREE.DoubleSide })); cloth.position.set(DX - 8.3 + i * 1.0, 1.85, DZ + 0.58); ctx.group.add(cloth); const ph = r() * 6; ctx.updates.push((t) => { cloth.rotation.x = Math.sin(t * 1.6 + ph) * 0.12 * (spec.weather?.wind ?? 0.4); }); }
  tree(ctx, DX + 6.5, DZ + 3.8, 1.25, "#3d6b2c"); tree(ctx, DX - 14, DZ + 4.5, 1.1); tree(ctx, DX + 15, 6, 1.3, "#4c7a35");
  // beyond: fields and a tree line across the lane, far hills
  const field = tex(512, 512, (g) => { g.fillStyle = day ? "#7d9a3e" : "#2c3a20"; g.fillRect(0, 0, 512, 512); for (let i = 0; i < 512; i += 10) { g.fillStyle = `rgba(40,60,20,${0.3})`; g.fillRect(0, i, 512, 3); } }); field.repeat.set(12, 4);
  add(new THREE.Mesh(new THREE.BoxGeometry(140, 0.05, 30), std({ map: field, roughness: 1 })), false).position.set(0, 0.02, 22);
  for (let i = 0; i < 10; i++) tree(ctx, -45 + i * 10 + r() * 4, 34 + r() * 6, 1.4 + r() * 0.6, "#355e2a");
  far(ctx, day ? "#8fa3a8" : "#141c26", -40, 14, 4, 12);
  return (p) => { if (p.z < DZ + 0.7) p.z = DZ + 0.7; if (p.y < 0.35) p.y = 0.35; };
}

/** A bazaar: shop fronts with Hindi signboards and shutters, stalls with awnings, crates of fruit and vegetables, sacks, bunting. */
export function marketKit(ctx: KitCtx): Clamp {
  const { DX, DZ, r, day, add } = ctx;
  const stone = tex(512, 512, (g) => { g.fillStyle = "#9c968c"; g.fillRect(0, 0, 512, 512); for (let i = 0; i < 64; i++) for (let j = 0; j < 64; j++) { g.fillStyle = `rgba(${r() < 0.5 ? "70,65,60" : "180,175,165"},${0.1 + r() * 0.15})`; g.fillRect(i * 8, j * 8, 7, 7); } }); stone.repeat.set(20, 20);
  (ctx.ground.material as THREE.MeshStandardMaterial).map = stone; (ctx.ground.material as THREE.MeshStandardMaterial).color.set(day ? "#ffffff" : "#9a948c");
  const colours = ["#e07a3f", "#3f8fbf", "#c94c6d", "#e8c547", "#5aa36b", "#8a5cc2"];
  const shops = ["किराना", "चाय", "कपड़े", "मिठाई", "बर्तन"];
  // a row of shop fronts along the back, the middle one with the working door
  for (let i = -2; i <= 2; i++) {
    const x = DX + i * 4.6, c = colours[(i + 2 + Math.floor(r() * 6)) % 6]!;
    const m = std({ map: plaster(c === "#e8c547" ? "#e9dcc0" : shade(c, 1.1), r), roughness: 0.9 });
    if (i !== 0) {
      add(box(4.4, 3.4, 0.3, m)).position.set(x, 1.7, DZ);
      const shutter = tex(256, 256, (g) => { g.fillStyle = "#8a9099"; g.fillRect(0, 0, 256, 256); g.fillStyle = "#6b717a"; for (let k = 0; k < 256; k += 10) g.fillRect(0, k, 256, 3); });
      add(box(3.0, 2.3, 0.08, std({ map: shutter, metalness: 0.6, roughness: 0.5 }))).position.set(x, 1.15, DZ + 0.18);
    } else {
      add(box(1.6, 3.4, 0.3, m)).position.set(x - 1.4, 1.7, DZ); add(box(1.6, 3.4, 0.3, m)).position.set(x + 1.4, 1.7, DZ); add(box(1.2, 1.25, 0.3, m)).position.set(x, 2.78, DZ);
      ctx.doorway({ dw: 1.2, dh: 2.15, leafColor: "#6b4a2b", frameColor: "#3a2a1a", glow: "#ffd28a", cold: "#ffe8c0", inside: "#7a5c3a" });
    }
    add(box(4.4, 3.4, 6, m)).position.set(x, 1.7, DZ - 3.2);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.7), std({ map: sign(shops[(i + 2) % shops.length]!, ["#f4e3b0", "#1d3557", "#7a1f2b", "#f1faee", "#264653"][(i + 2) % 5]!, ["#7a1f2b", "#f1faee", "#f4e3b0", "#1d3557", "#e9c46a"][(i + 2) % 5]!), roughness: 0.7 }));
    board.position.set(x, 3.0, DZ + 0.17); ctx.group.add(board);
    if (i === 0) ctx.mark("address", board.position.clone());
    // the stall in front: table, cloth awning on poles, crates of produce, sacks
    if (i !== 0) {
      const sx = x, sz = DZ + 2.0;
      add(box(2.6, 0.08, 1.2, std({ color: "#7a5a3a", roughness: 0.8 }))).position.set(sx, 0.85, sz);
      for (const [px, pz] of [[-1.2, -0.5], [1.2, -0.5], [-1.2, 0.5], [1.2, 0.5]] as const) add(box(0.07, 0.85, 0.07, std({ color: "#5a4128" }))).position.set(sx + px, 0.42, sz + pz);
      const awn = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.8, 6, 3), std({ color: colours[(i + 3 + 6) % 6]!, roughness: 0.9, side: THREE.DoubleSide }));
      awn.rotation.x = -Math.PI / 2 + 0.35; awn.position.set(sx, 2.35, sz + 0.1); add(awn);
      for (const px of [-1.4, 1.4]) add(box(0.05, 2.4, 0.05, std({ color: "#444" }))).position.set(sx + px, 1.2, sz + 0.9);
      const produce = ["#f39c12", "#c0392b", "#27ae60", "#e8d44d", "#8e44ad", "#e67e22"];
      for (let k = 0; k < 4; k++) {
        const crate = add(box(0.55, 0.25, 0.45, std({ color: "#b08a5a", roughness: 0.9 }))); crate.position.set(sx - 0.9 + k * 0.6, 1.02, sz - 0.1);
        const col = produce[(k + i + 6) % produce.length]!;
        for (let q = 0; q < 9; q++) { const f = new THREE.Mesh(new THREE.SphereGeometry(0.06 + r() * 0.025, 10, 8), std({ color: shade(col, 0.85 + r() * 0.3), roughness: 0.55 })); f.position.set(sx - 0.9 + k * 0.6 + (r() - 0.5) * 0.4, 1.18 + r() * 0.06, sz - 0.1 + (r() - 0.5) * 0.3); ctx.group.add(f); }
      }
      for (let k = 0; k < 2; k++) { const sack = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.55, 10), std({ color: "#c9b48a", roughness: 1 })); sack.position.set(sx + 1.0 + k * 0.5, 0.28, sz + 0.9); add(sack); }
      if (!day) practical(ctx, new THREE.Vector3(sx, 2.15, sz + 0.2), "#ffd08a", 10, 6, 0.05, 0.1);
    }
  }
  // bunting / string lights across the lane
  for (let k = 0; k < 3; k++) {
    const z = DZ + 3.2 + k * 2.4;
    const pts = [new THREE.Vector3(-14, 4.2, z), new THREE.Vector3(0, 3.5, z + 0.2), new THREE.Vector3(14, 4.2, z)];
    const curve = new THREE.CatmullRomCurve3(pts);
    add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.008, 4), std({ color: "#222" })), false);
    for (let i = 0; i < 26; i++) {
      const p = curve.getPoint(i / 25);
      if (day) { const flag = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.32, 3), std({ color: colours[i % colours.length]!, roughness: 0.9 })); flag.position.copy(p).add(new THREE.Vector3(0, -0.18, 0)); flag.rotation.x = Math.PI; ctx.group.add(flag); }
      else { const b = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: ["#ffd08a", "#ff9a7a", "#fff2c0"][i % 3]! })); b.position.copy(p); ctx.group.add(b); }
    }
    if (!day) practical(ctx, curve.getPoint(0.5), "#ffd9a0", 6, 8, 0.01);
  }
  // shoppers in the background: simple figures at a distance (not characters), swaying slightly
  for (let i = 0; i < 14; i++) {
    // by the stalls and shop fronts, never in the open space where the story is staged
    const g = new THREE.Group(); g.position.set(-16 + i * 2.4 + r(), 0, DZ + 2.9 + r() * 1.3);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.9, 4, 8), std({ color: colours[i % colours.length]!, roughness: 0.9 })); body.position.y = 0.85; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), std({ color: "#6b4a35", roughness: 0.8 })); head.position.y = 1.55; g.add(head);
    if (Math.abs(g.position.x - DX) < 4) continue;
    add(g); const ph = r() * 6; ctx.updates.push((t) => { g.rotation.y = Math.sin(t * 0.4 + ph) * 0.4; g.position.y = Math.abs(Math.sin(t * 2 + ph)) * 0.02; });
  }
  far(ctx, day ? "#b9ab98" : "#18151a", -30, 16, 6, 14);
  return (p) => { if (p.z < DZ + 0.7) p.z = DZ + 0.7; if (p.y < 0.35) p.y = 0.35; };
}

/** A home interior: tiled floor, walls, ceiling, a window (daylight shaft), sofa, table, shelf, picture, clock, ceiling fan, a tube light; a candle in a power cut. */
export function interiorKit(ctx: KitCtx, opts: { outage?: boolean } = {}): Clamp {
  const { DX, DZ, r, day, add, spec } = ctx;
  const W = 10, Hc = 3.2, front = 3.6, depth = front - DZ;
  const pal = spec.palette ?? {};
  const wallC = pal.wall ?? ["#e8dcc4", "#cfe0d6", "#e9d0c0", "#d8d8e8"][Math.floor(r() * 4)]!;
  (ctx.ground.material as THREE.MeshStandardMaterial).map = (() => { const t = tiles("#d9cbb4", "#c4b49a", 16); t.repeat.set(8, 8); return t; })();
  (ctx.ground.material as THREE.MeshStandardMaterial).color.set("#ffffff");
  const wallMat = std({ map: plaster(wallC, r), roughness: 0.9 }); (wallMat.map as THREE.Texture).repeat.set(3, 1);
  // back wall with the door to the inner room; side walls; ceiling (the front stays open for the camera)
  const dw = 1.0, dh = 2.1;
  add(box(W / 2 + DX - dw / 2, Hc, 0.2, wallMat)).position.set(DX - dw / 2 - (W / 2 + DX - dw / 2) / 2, Hc / 2, DZ);
  add(box(W / 2 - DX - dw / 2, Hc, 0.2, wallMat)).position.set(DX + dw / 2 + (W / 2 - DX - dw / 2) / 2, Hc / 2, DZ);
  add(box(dw, Hc - dh, 0.2, wallMat)).position.set(DX, dh + (Hc - dh) / 2, DZ);
  ctx.doorway({ dw, dh, leafColor: "#7a5233", frameColor: "#5a3b22", glow: "#ffdca8", cold: "#ffe8c8", inside: "#8a7a66" });
  const side = (x: number, window: boolean): void => {
    if (!window) { add(box(0.2, Hc, depth, wallMat)).position.set(x, Hc / 2, DZ + depth / 2); return; }
    const wz = DZ + depth * 0.45, ww = 1.6, wh = 1.3, wy = 1.6;
    add(box(0.2, Hc, wz - ww / 2 - DZ, wallMat)).position.set(x, Hc / 2, DZ + (wz - ww / 2 - DZ) / 2);
    add(box(0.2, Hc, front - (wz + ww / 2), wallMat)).position.set(x, Hc / 2, wz + ww / 2 + (front - wz - ww / 2) / 2);
    add(box(0.2, wy - wh / 2, ww, wallMat)).position.set(x, (wy - wh / 2) / 2, wz);
    add(box(0.2, Hc - wy - wh / 2, ww, wallMat)).position.set(x, Hc - (Hc - wy - wh / 2) / 2, wz);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(ww, wh), new THREE.MeshBasicMaterial({ color: day ? "#e9f3ff" : "#0d1626", transparent: true, opacity: day ? 0.55 : 0.9 }));
    pane.position.set(x + 0.05, wy, wz); pane.rotation.y = Math.PI / 2; ctx.group.add(pane);
    for (let k = -1; k <= 1; k++) add(box(0.06, wh, 0.04, std({ color: "#3a3a3a", metalness: 0.7 }))).position.set(x + 0.08, wy, wz + k * 0.5);
    // daylight through the window: a key light with a visible shaft on the floor
    if (day && !opts.outage) {
      const sun = new THREE.SpotLight("#fff1d6", 160, 18, 0.5, 0.6, 1.2); sun.position.set(x - 4, 3.2, wz + 0.6); sun.target.position.set(x + 2.5, 0, wz - 0.4); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
      ctx.group.add(sun, sun.target);
    }
    ctx.mark("window", new THREE.Vector3(x, wy, wz));
  };
  side(DX - W / 2, true); side(DX + W / 2, false);
  add(box(W, 0.15, depth, std({ color: shade(wallC, 1.05), roughness: 0.95 }))).position.set(DX, Hc + 0.075, DZ + depth / 2);
  add(box(W, 0.12, 0.08, std({ color: "#6b4a2b" }))).position.set(DX, 0.06, DZ + 0.12);
  // furniture: sofa, low table with two cups, shelf with books and pots, framed picture, wall clock, a calendar
  const fabric = std({ color: ["#7a3b3b", "#3b5a7a", "#5a6b3b"][Math.floor(r() * 3)]!, roughness: 0.95 });
  // the furniture stands around the action area (the middle of the room), not against the far wall
  // where conversations are staged (in front of the door, compile.ts): the candle and the furniture belong there
  const az = DZ + 2.0;
  const sofa = new THREE.Group(); sofa.position.set(DX + 3.6, 0, az - 0.4); sofa.rotation.y = -Math.PI / 2;
  const seat = box(2.0, 0.42, 0.85, fabric); seat.position.y = 0.21; sofa.add(seat);
  const back = box(2.0, 0.55, 0.22, fabric); back.position.set(0, 0.68, -0.33); sofa.add(back);
  for (const sx of [-1, 1]) { const arm = box(0.2, 0.62, 0.85, fabric); arm.position.set(sx * 1.0, 0.31, 0); sofa.add(arm); }
  add(sofa);
  const table = new THREE.Group(); table.position.set(DX + 2.3, 0, az + 0.3);
  const top = box(0.9, 0.05, 0.55, std({ color: "#6b4a2b", roughness: 0.5 })); top.position.y = 0.45; table.add(top);
  for (const [x, z] of [[-0.4, -0.22], [0.4, -0.22], [-0.4, 0.22], [0.4, 0.22]] as const) { const l = box(0.05, 0.45, 0.05, std({ color: "#4a3220" })); l.position.set(x, 0.22, z); table.add(l); }
  for (const x of [-0.15, 0.18]) { const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.035, 0.08, 12), std({ color: "#f2efe8", roughness: 0.3 })); cup.position.set(x, 0.51, 0); table.add(cup); }
  add(table);
  const shelf = new THREE.Group(); shelf.position.set(DX - 3.0, 0, DZ + 0.3);
  for (let k = 0; k < 4; k++) { const b = box(1.4, 0.04, 0.35, std({ color: "#6b4a2b" })); b.position.y = 0.4 + k * 0.45; shelf.add(b); for (let q = 0; q < 5; q++) { const bk = box(0.08, 0.28, 0.25, std({ color: ["#8e2b2b", "#2b4f8e", "#2b8e5a", "#c9a227", "#5a2b8e"][(q + k) % 5]! })); bk.position.set(-0.5 + q * 0.12, 0.56 + k * 0.45, 0); shelf.add(bk); } }
  add(shelf);
  const pic = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.65), std({ map: tex(256, 192, (g) => { const grd = g.createLinearGradient(0, 0, 0, 192); grd.addColorStop(0, "#f2a65a"); grd.addColorStop(1, "#4a7a3a"); g.fillStyle = grd; g.fillRect(0, 0, 256, 192); g.fillStyle = "#3a2a1a"; g.beginPath(); g.moveTo(40, 150); g.lineTo(128, 60); g.lineTo(210, 150); g.fill(); g.lineWidth = 14; g.strokeStyle = "#5a3b22"; g.strokeRect(0, 0, 256, 192); }), roughness: 0.6 }));
  pic.position.set(DX + 2.2, 2.0, DZ + 0.12); ctx.group.add(pic);
  ctx.mark("address", pic.position.clone()); ctx.mark("doorbell", new THREE.Vector3(DX + dw / 2 + 0.2, 1.3, DZ + 0.12));
  const clock = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 24), std({ color: "#f5f1e6", roughness: 0.4 })); clock.rotation.x = Math.PI / 2; clock.position.set(DX - 2.0, 2.45, DZ + 0.13); add(clock);
  const hand = box(0.015, 0.15, 0.01, std({ color: "#222" })); hand.position.set(DX - 2.0, 2.5, DZ + 0.16); ctx.group.add(hand); ctx.updates.push((t) => { hand.rotation.z = -t * 0.1; hand.position.set(DX - 2.0 + Math.sin(-t * 0.1) * -0.06, 2.45 + Math.cos(t * 0.1) * 0.06, DZ + 0.16); });
  // ceiling fan (turning unless the power is out) and a tube light on the back wall
  const fan = new THREE.Group(); fan.position.set(DX, Hc - 0.35, DZ + depth * 0.45);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.1, 16), std({ color: "#d9d4c8", metalness: 0.3 })); fan.add(hub);
  for (let k = 0; k < 3; k++) { const blade = box(0.75, 0.015, 0.14, std({ color: "#c9c2b0", roughness: 0.6 })); blade.position.x = 0.45; const arm = new THREE.Group(); arm.rotation.y = (k * Math.PI * 2) / 3; arm.add(blade); fan.add(arm); }
  const rod = box(0.03, 0.3, 0.03, std({ color: "#888" })); rod.position.y = 0.2; fan.add(rod);
  add(fan, false); ctx.updates.push((t) => { if (!opts.outage) fan.rotation.y = t * 7; });
  const tube = box(1.2, 0.05, 0.05, new THREE.MeshBasicMaterial({ color: opts.outage ? "#5a5a55" : "#f4fbff" })); tube.position.set(DX + 2.6, 2.75, DZ + 0.15); ctx.group.add(tube);
  if (!opts.outage) {
    const l = new THREE.PointLight(day ? "#fff6ea" : "#f2f7ff", day ? 12 : 38, 14, 1.5); l.position.set(DX + 1.5, 2.7, DZ + 1.6); l.castShadow = !day; ctx.group.add(l);
    const fill = new THREE.PointLight("#ffe9cc", day ? 6 : 14, 12, 1.6); fill.position.set(DX - 1, 2.6, DZ + 4); ctx.group.add(fill);
  } else {
    // a power cut: the room is dark but for a candle on the table (and whatever comes through the window)
    const cx = DX + 2.3, cz = az + 0.3;
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.06, 8), new THREE.MeshBasicMaterial({ color: "#ffcf6a" })); flame.position.set(cx, 0.6, cz); ctx.group.add(flame);
    const wax = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.1, 10), std({ color: "#f3efe2" })); wax.position.set(cx, 0.52, cz); ctx.group.add(wax);
    const l = practical(ctx, new THREE.Vector3(cx, 0.64, cz), "#ffb45a", 7, 8, 0.012, 0.3); l.castShadow = true; l.shadow.mapSize.set(512, 512);
    // a second candle / diya on the shelf side, so faces on both sides of the room catch a little warm light
    practical(ctx, new THREE.Vector3(DX - 1.6, 1.0, az - 0.4), "#ffaa50", 4, 6, 0.01, 0.4);
    // the warm glow the candles throw back from the walls (a candle-lit room is dim, not black)
    const bounce = new THREE.PointLight("#ff9a4a", 0.8, 9, 1.4); bounce.position.set(DX + 0.8, 1.6, az + 0.8); ctx.group.add(bounce);
    ctx.updates.push((t) => { flame.scale.y = 0.9 + Math.sin(t * 23) * 0.1 + Math.sin(t * 9) * 0.05; });
  }
  return (p) => { p.x = Math.min(DX + W / 2 - 0.4, Math.max(DX - W / 2 + 0.4, p.x)); p.z = Math.max(DZ + 0.8, Math.min(front + 2.5, p.z)); p.y = Math.min(Hc - 0.3, Math.max(0.4, p.y)); };
}

/** A country road: the road along the front, fields, electric poles and wires, trees, a roadside tea shack (the facade), far hills. */
/** The country road. With traffic, the road is laid BEHIND the action (between the people and the tea stall), so
 *  vehicles pass behind the actors and never through the camera; `lanes` then receives its two lanes. */
export function roadKit(ctx: KitCtx, o: { traffic?: boolean; lanes?: { z: number; dir: 1 | -1 }[]; dirt?: boolean } = {}): Clamp {
  const { DX, DZ, r, day, add, wet } = ctx;
  const roadZ = o.traffic ? -2.9 : 6.5;
  if (o.traffic && o.lanes) o.lanes.push({ z: roadZ + 1.5, dir: 1 }, { z: roadZ - 1.5, dir: -1 });
  const dirtTex = dirt(r, wet); dirtTex.repeat.set(10, 10);
  (ctx.ground.material as THREE.MeshStandardMaterial).map = dirtTex; (ctx.ground.material as THREE.MeshStandardMaterial).color.set("#ffffff");
  // a kachcha road: packed earth with wheel ruts (no tarmac, no centre line)
  const road = o.dirt ? tex(1024, 256, (g) => { g.fillStyle = wet > 0.4 ? "#5a4636" : "#a98a62"; g.fillRect(0, 0, 1024, 256); for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(${r() < 0.5 ? "80,60,40" : "210,185,150"},${0.08 + r() * 0.12})`; g.fillRect(r() * 1024, r() * 256, 2 + r() * 6, 2 + r() * 4); } for (const y of [70, 100, 156, 186]) { g.fillStyle = "rgba(90,68,45,0.35)"; g.fillRect(0, y, 1024, 10); } }) : tex(1024, 256, (g) => { g.fillStyle = wet > 0.4 ? "#3a3c40" : "#55575b"; g.fillRect(0, 0, 1024, 256); for (let i = 0; i < 3000; i++) { g.fillStyle = `rgba(${r() < 0.5 ? "30,30,30" : "120,120,120"},0.15)`; g.fillRect(r() * 1024, r() * 256, 3, 3); } g.fillStyle = "#e8e2c8"; for (let x = 0; x < 1024; x += 128) g.fillRect(x, 124, 64, 8); }); road.repeat.set(10, 1);
  add(new THREE.Mesh(new THREE.BoxGeometry(160, 0.04, 6), std({ map: road, roughness: wet > 0.4 ? 0.35 : 0.85, metalness: wet > 0.4 ? 0.2 : 0 })), false).position.set(0, 0.03, roadZ);
  const field = (z: number, d: number, c: string): void => { const t = tex(512, 512, (g) => { g.fillStyle = c; g.fillRect(0, 0, 512, 512); for (let i = 0; i < 512; i += 12) { g.fillStyle = "rgba(30,45,15,0.35)"; g.fillRect(0, i, 512, 4); } }); t.repeat.set(16, d / 3); add(new THREE.Mesh(new THREE.BoxGeometry(160, 0.06, d), std({ map: t, roughness: 1 })), false).position.set(0, 0.03, z); };
  if (o.traffic) { field(-17, 12, day ? "#9aa64a" : "#2a3020"); field(12, 14, day ? "#c2a94a" : "#30301e"); }
  else { field(-3.2, 9, day ? "#9aa64a" : "#2a3020"); field(16, 12, day ? "#c2a94a" : "#30301e"); }
  // the roadside tea shack (the facade with the door), a bench, a kettle on a stove
  const shackMat = std({ map: plaster("#c9b28a", r), roughness: 0.95 });
  add(box(1.4, 2.6, 0.2, shackMat)).position.set(DX - 1.2, 1.3, DZ); add(box(1.4, 2.6, 0.2, shackMat)).position.set(DX + 1.2, 1.3, DZ); add(box(1.0, 0.45, 0.2, shackMat)).position.set(DX, 2.38, DZ);
  add(box(3.4, 2.6, 3, shackMat)).position.set(DX, 1.3, DZ - 1.6);
  add(box(4.2, 0.1, 2.0, std({ color: "#5d5a56", metalness: 0.5, roughness: 0.6 }))).position.set(DX, 2.75, DZ + 0.3);
  ctx.doorway({ dw: 1.0, dh: 2.1, leafColor: "#3b5a6b", frameColor: "#3a2a1a", glow: "#ffcf8a", cold: "#ffe2b0", inside: "#5a4632" });
  const board = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.45), std({ map: sign("चाय", "#f4e3b0", "#7a1f2b"), roughness: 0.7 })); board.position.set(DX, 2.55, DZ + 0.12); ctx.group.add(board);
  ctx.mark("address", board.position.clone()); ctx.mark("doorbell", new THREE.Vector3(DX + 0.7, 1.3, DZ + 0.12));
  add(box(1.6, 0.08, 0.4, std({ color: "#6b4a2b" }))).position.set(DX + 2.4, 0.45, DZ + 1.0);
  if (!day) practical(ctx, new THREE.Vector3(DX, 2.45, DZ + 0.6), "#ffc87a", 16, 8, 0.05);
  // electric poles with sagging wires along the road; trees; far hills
  const poleM = std({ color: "#6b6b66", roughness: 0.8 });
  const poleZ = o.traffic ? roadZ - 3.5 : 9.8;
  for (let i = 0; i < 6; i++) { const x = -30 + i * 12; add(box(0.18, 7, 0.18, poleM)).position.set(x, 3.5, poleZ); add(box(1.4, 0.1, 0.1, poleM)).position.set(x, 6.7, poleZ); }
  for (let w = 0; w < 2; w++) for (let i = 0; i < 5; i++) { const x0 = -30 + i * 12, y = 6.7, z = poleZ + (w - 0.5) * 1.2; add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(x0, y, z), new THREE.Vector3(x0 + 6, y - 0.6, z), new THREE.Vector3(x0 + 12, y, z)]), 16, 0.012, 4), std({ color: "#222" })), false); }
  for (let i = 0; i < 9; i++) tree(ctx, -40 + i * 10 + r() * 4, (i % 2 ? -10 : 24) + r() * 3, 1.2 + r() * 0.6);
  far(ctx, day ? "#93a4b2" : "#121a24", -45, 10, 8, 18); far(ctx, day ? "#a6b4c0" : "#161e28", 60, 10, 6, 14);
  return (p) => { const zMin = o.traffic ? 0.6 : DZ + 0.7; if (p.z < zMin) p.z = zMin; if (p.y < 0.35) p.y = 0.35; };
}
