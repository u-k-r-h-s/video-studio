import * as THREE from "three";
import type { EnvironmentSpec3D, SetObject3D } from "../spec";
import { glowSprite, lightShaft } from "./effects";
import type { LightingRig } from "./lighting";

/**
 * Sets. Not full 3D worlds: a small, well-lit kit around where the action happens, built in depth layers
 *   foreground (rain/dust near the lens, a post or hedge) -> character -> midground (the door, props) -> environment
 *   (facades, trees, cars) -> background (rows of distant buildings / an AI plate) -> sky.
 * Kits: "warehouse-exterior" (industrial) and "neighborhood" (houses, lawns, trees, street). Both expose the same named
 * targets (door, door-front, doorway, doorbell, address) so the compiler and the characters do not care which it is.
 * Materials follow the weather: a wet set is darker and smoother (it catches the lights), a dry one is matte.
 */
export interface SetInstance {
  group: THREE.Group;
  named(id: string): THREE.Vector3 | null;
  update(t: number, dt: number, cameraPos: THREE.Vector3): void;
  clampCamera(p: THREE.Vector3): void;
  cues: { kind: "door"; at: number; volume?: number }[];
}

const rand = (seed: number): (() => number) => { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const std = (o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial(o);

/** Corrugated, rust-streaked metal (colour + roughness + ribs). */
function corrugated(r: () => number): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const ribs = 22;
  const map = canvasTex(512, 512, (g) => {
    for (let x = 0; x < 512; x++) { const k = Math.sin((x / 512) * Math.PI * 2 * ribs); const v = 70 + 22 * k; g.fillStyle = `rgb(${v * 0.82},${v * 0.88},${v})`; g.fillRect(x, 0, 1, 512); }
    for (let i = 0; i < 90; i++) { const x = r() * 512, w = 2 + r() * 10, len = 40 + r() * 260; const gr = g.createLinearGradient(0, 0, 0, len); gr.addColorStop(0, `rgba(110,62,30,${0.35 * r()})`); gr.addColorStop(1, "rgba(110,62,30,0)"); g.fillStyle = gr; g.fillRect(x, r() * 200, w, len); }
    for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.12})`; g.fillRect(r() * 512, r() * 512, 1 + r() * 3, 1 + r() * 3); }
    g.fillStyle = "rgba(0,0,0,0.35)"; g.fillRect(0, 470, 512, 42);
  });
  const rough = canvasTex(512, 512, (g) => { g.fillStyle = "#b8b8b8"; g.fillRect(0, 0, 512, 512); for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(255,255,255,${r() * 0.3})`; g.fillRect(r() * 512, r() * 512, 4 + r() * 20, 40 + r() * 200); } }, false);
  const bump = canvasTex(512, 8, (g) => { for (let x = 0; x < 512; x++) { const v = 128 + 120 * Math.sin((x / 512) * Math.PI * 2 * ribs); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, 0, 1, 8); } }, false);
  return { map, rough, bump };
}

/** Asphalt: noise, cracks and (when wet) puddles that are smoother than the rest. */
function asphalt(r: () => number, wet: number): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const N = 1024;
  const puddles: [number, number, number, number][] = Array.from({ length: 7 }, () => [r() * N, r() * N, 30 + r() * 90, 14 + r() * 40]);
  const map = canvasTex(N, N, (g) => {
    const d = g.createImageData(N, N);
    for (let i = 0; i < N * N; i++) { const n = 52 + r() * 26 + (r() < 0.02 ? 30 : 0); d.data[i * 4] = n; d.data[i * 4 + 1] = n * 1.01; d.data[i * 4 + 2] = n * 1.05; d.data[i * 4 + 3] = 255; }
    g.putImageData(d, 0, 0);
    for (let i = 0; i < 30; i++) { g.strokeStyle = `rgba(20,20,22,${0.5 * r()})`; g.lineWidth = 1 + r() * 3; g.beginPath(); let x = r() * N, y = r() * N; g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 120; y += (r() - 0.5) * 120; g.lineTo(x, y); } g.stroke(); }
    if (wet > 0) for (const [x, y, rx, ry] of puddles) { const gr = g.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry)); gr.addColorStop(0, `rgba(10,12,16,${0.35 * wet})`); gr.addColorStop(1, "rgba(10,12,16,0)"); g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, rx, ry, r() * 3, 0, Math.PI * 2); g.fill(); }
  });
  const base = Math.round(220 - 70 * wet);
  const rough = canvasTex(N, N, (g) => {
    g.fillStyle = `rgb(${base},${base},${base})`; g.fillRect(0, 0, N, N);
    if (wet > 0) for (const [x, y, rx, ry] of puddles) { const gr = g.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry)); const v = Math.round(base * 0.45); gr.addColorStop(0, `rgb(${v},${v},${v})`); gr.addColorStop(1, `rgba(${base},${base},${base},0)`); g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, rx * 1.1, ry * 1.1, 0, 0, Math.PI * 2); g.fill(); }
  }, false);
  for (const t of [map, rough]) t.repeat.set(16, 16);
  return { map, rough };
}

/** Lawn grass: mottled greens. */
function grass(r: () => number): THREE.CanvasTexture {
  const t = canvasTex(256, 256, (g) => {
    g.fillStyle = "#4f7a34"; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5000; i++) { const v = r(); g.fillStyle = v < 0.5 ? `rgba(70,${110 + r() * 50},40,0.6)` : `rgba(${40 + r() * 30},${80 + r() * 30},30,0.5)`; g.fillRect(r() * 256, r() * 256, 1 + r() * 2, 2 + r() * 4); }
  });
  t.repeat.set(10, 10);
  return t;
}

/** Horizontal siding boards (house walls). */
function siding(color: string, r: () => number): THREE.CanvasTexture {
  const c = new THREE.Color(color);
  return canvasTex(256, 256, (g) => {
    g.fillStyle = `#${c.getHexString()}`; g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 16) { g.fillStyle = "rgba(0,0,0,0.16)"; g.fillRect(0, y + 13, 256, 3); g.fillStyle = "rgba(255,255,255,0.08)"; g.fillRect(0, y, 256, 2); }
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.05})`; g.fillRect(r() * 256, r() * 256, 4 + r() * 20, 1); }
  });
}

/** Concrete (sidewalk, path): light, matte, with expansion joints. */
function concrete(r: () => number): THREE.CanvasTexture {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = "#b9b6ae"; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 3000; i++) { const v = r() < 0.5 ? 0 : 255; g.fillStyle = `rgba(${v},${v},${v},${r() * 0.05})`; g.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 2); }
    g.fillStyle = "rgba(60,58,54,0.5)"; g.fillRect(0, 0, 256, 2); g.fillRect(0, 0, 2, 256);
  });
}

export async function buildSet(spec: EnvironmentSpec3D, scene: THREE.Scene, images: Record<string, string>, seed: number, rig?: LightingRig): Promise<SetInstance> {
  const r = rand(seed);
  const group = new THREE.Group();
  scene.add(group);
  const named = new Map<string, THREE.Object3D>();
  const updates: ((t: number, dt: number, cam: THREE.Vector3) => void)[] = [];
  const cues: SetInstance["cues"] = [];
  const wet = Math.max(rig?.wetness ?? 0, Math.min(1, (spec.weather?.rain ?? 0) * 1.1));
  const day = rig?.daylight ?? true;
  const loader = new THREE.TextureLoader();
  const img = async (key?: string): Promise<THREE.Texture | null> => {
    if (!key || !images[key]) return null;
    const t = await loader.loadAsync(images[key]!);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const add = <T extends THREE.Object3D>(o: T, cast = true): T => { o.traverse((x) => { const m = x as THREE.Mesh; if (m.isMesh) { m.castShadow = cast; m.receiveShadow = true; } }); group.add(o); return o; };
  const mark = (id: string, p: THREE.Vector3): void => { const o = new THREE.Object3D(); o.position.copy(p); group.add(o); named.set(id, o); };

  const door = spec.objects.find((o) => o.kind === "door");
  const DZ = door?.z ?? -8, DX = door?.x ?? 0;

  // ground (asphalt); the neighbourhood lays lawns, sidewalk and a path on top
  const { map, rough } = asphalt(r, wet);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), std({ map, roughnessMap: rough, roughness: 1, metalness: 0, color: wet > 0.5 ? (day ? "#7d828c" : "#5d626c") : "#a8acb2", envMapIntensity: day ? 0.2 + 0.3 * wet : 0.12 + 0.18 * wet }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; group.add(ground);

  // the far world at night: an AI-painted plate on a wide curved screen (by day the physical sky + distant rows do this)
  const plate = await img(spec.backdrop);
  if (plate && !day) {
    const screen = new THREE.Mesh(new THREE.CylinderGeometry(80, 80, 60, 64, 1, true, Math.PI * 0.62, Math.PI * 0.76), new THREE.MeshBasicMaterial({ map: plate, side: THREE.BackSide, fog: false, color: "#8c95a8" }));
    screen.position.set(0, 14, -8); group.add(screen);
  }

  // the doorway shared by both kits: frame, hinged leaf, lit room behind, spill light
  const doorway = (o: { dw: number; dh: number; leafColor: string; leafTex?: THREE.Texture; frameColor: string; glow: string; cold: string; inside: string }): void => {
    const { dw, dh } = o;
    const frameMat = std({ color: o.frameColor, metalness: 0.4, roughness: 0.5 });
    for (const [x, w, h, y] of [[DX - dw / 2 - 0.08, 0.16, dh + 0.1, dh / 2], [DX + dw / 2 + 0.08, 0.16, dh + 0.1, dh / 2], [DX, dw + 0.32, 0.16, dh + 0.06]] as const) { const f = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.4), frameMat); f.position.set(x, y, DZ + 0.06); add(f); }
    const room = new THREE.Mesh(new THREE.BoxGeometry(Math.max(4, dw * 2.5), dh + 1.2, 6), std({ color: o.inside, roughness: 0.95, side: THREE.BackSide }));
    room.position.set(DX, (dh + 1.2) / 2, DZ - 3.1); room.receiveShadow = true; group.add(room);
    const innerLight = new THREE.PointLight(o.glow, 0, 6, 1.6); innerLight.position.set(DX + 0.6, 2.0, DZ - 3); group.add(innerLight);
    const innerCold = new THREE.PointLight(o.cold, 0, 6, 1.8); innerCold.position.set(DX - 1.2, 2.6, DZ - 5); group.add(innerCold);
    const spill = new THREE.SpotLight(o.glow, 0, 16, 0.62, 0.6, 1.4); spill.position.set(DX, 2.15, DZ - 1.0); spill.target.position.set(DX, 0, DZ + 5); spill.castShadow = true; spill.shadow.mapSize.set(1024, 1024); spill.shadow.bias = -0.0005; group.add(spill, spill.target);
    const shaft = lightShaft(o.glow, 6.5, 2.2, 0); shaft.position.copy(spill.position); shaft.lookAt(spill.target.position); shaft.rotateX(Math.PI / 2); group.add(shaft);
    const hingeLeft = String(door?.params?.hinge ?? "left") === "left";
    const pivot = new THREE.Group(); pivot.position.set(DX + (hingeLeft ? -dw / 2 : dw / 2), 0, DZ - 0.05); group.add(pivot);
    const leafMat = std({ color: o.leafColor, map: o.leafTex ?? null, roughness: 0.6, metalness: o.leafTex ? 0.4 : 0.05 });
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(dw - 0.04, dh - 0.04, 0.07), leafMat); leaf.position.set(hingeLeft ? dw / 2 : -dw / 2, dh / 2, 0); leaf.castShadow = true; leaf.receiveShadow = true; pivot.add(leaf);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), std({ color: "#c9a24a", metalness: 1, roughness: 0.25 })); knob.position.set(hingeLeft ? dw - 0.15 : -dw + 0.15, 1.05, 0.06); pivot.add(knob);
    mark("door", new THREE.Vector3(DX + (hingeLeft ? dw * 0.3 : -dw * 0.3), 1.1, DZ + 0.15));
    mark("doorway", new THREE.Vector3(DX, 1.45, DZ - 2)); named.set("inside", named.get("doorway")!);
    mark("door-front", new THREE.Vector3(DX + (hingeLeft ? 0.35 : -0.35), 0, DZ + 0.8));
    // where a walk to the door turns in: the path start at the sidewalk (houses) / a few metres in front of the bay
    mark("approach", spec.kind === "neighborhood" ? new THREE.Vector3(DX, 0, 2.3) : new THREE.Vector3(DX + 1.2, 0, DZ + 3.6));
    const opens = (door?.events ?? []).filter((e) => e.action === "open" || e.action === "close");
    for (const e of opens) if (e.action === "open" && e.at >= 0) cues.push({ kind: "door", at: e.at, volume: 0.7 });
    updates.push((t) => {
      let open = 0;
      for (const e of opens) { const u = Math.min(1, Math.max(0, (t - e.at) / (e.duration ?? 1.6))); const k = 1 - (1 - u) ** 3; open = e.action === "open" ? (t >= e.at ? k : open) : t >= e.at ? 1 - k : open; }
      const ang = open * 1.55 + Math.sin(open * Math.PI) * 0.04;
      pivot.rotation.y = hingeLeft ? ang : -ang;
      const on = Math.min(1, open * 1.6);
      innerLight.intensity = (day ? 90 : 45) * on; innerCold.intensity = (day ? 30 : 12) * on;
      spill.intensity = (day ? 120 : 260) * on * (0.97 + 0.03 * Math.sin(t * 13) * Math.sin(t * 3.1));
      shaft.setIntensity((day ? 0.05 : 0.2) * on);
    });
  };

  const frontZ = DZ + 0.6;
  if (spec.kind === "warehouse-exterior") {
    const dw = Number(door?.params?.width ?? 2.6), dh = Number(door?.params?.height ?? 3.3);
    const wallTex = await img(spec.wallTexture);
    const metal = corrugated(r);
    const wallMat = std({ map: wallTex ?? metal.map, roughnessMap: metal.rough, bumpMap: metal.bump, bumpScale: 2.2, roughness: 0.8 - 0.25 * wet, metalness: 0.4, color: wallTex ? "#9aa3b2" : day ? "#a7b0bd" : "#8e98a8" });
    const H = 8.5, W = 30, D = 18;
    const piece = (w: number, h: number, x: number, y: number): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.35), wallMat.clone());
      const mm = m.material as THREE.MeshStandardMaterial; mm.map = (wallMat.map as THREE.Texture).clone(); mm.map.repeat.set(Math.max(1, w / 4), h / 8.5); mm.map.needsUpdate = true;
      m.position.set(x, y, DZ); add(m);
    };
    const leftW = W / 2 + DX - dw / 2, rightW = W / 2 - DX - dw / 2;
    piece(leftW, H, DX - dw / 2 - leftW / 2, H / 2); piece(rightW, H, DX + dw / 2 + rightW / 2, H / 2); piece(dw, H - dh, DX, dh + (H - dh) / 2);
    add(new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, 0.5, D), std({ color: "#1b1f26", roughness: 0.9 }))).position.set(0, H + 0.25, DZ - D / 2);
    for (const sx of [-1, 1]) add(new THREE.Mesh(new THREE.BoxGeometry(0.35, H, D), wallMat)).position.set(sx * W / 2, H / 2, DZ - D / 2);
    for (let i = 0; i < 7; i++) {
      const lit = !day && r() < 0.35, x = -12 + i * 4 + (Math.abs(-12 + i * 4 - DX) < 2.5 ? 2.6 : 0);
      const w = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9), std({ color: lit ? "#3b5a80" : "#1a2230", emissive: lit ? "#2b4b78" : "#000000", emissiveIntensity: lit ? 0.6 : 0, roughness: 0.08, metalness: 0.6 }));
      w.position.set(x, 6.4, DZ + 0.19); group.add(w);
    }
    const trim = std({ color: "#2b3038", metalness: 0.7, roughness: 0.45 });
    // canopy, gutter pipes, a sagging cable, a faded bay sign: details that read "industrial" at phone size
    add(new THREE.Mesh(new THREE.BoxGeometry(dw + 1.6, 0.12, 1.3), trim)).position.set(DX, dh + 0.85, DZ + 0.65);
    for (const x of [DX - dw / 2 - 2.6, DX + 7.5]) add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, H, 12), trim)).position.set(x, H / 2, DZ + 0.3);
    add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(DX - 6, 6.2, DZ + 0.25), new THREE.Vector3(DX - 2, 5.2, DZ + 0.3), new THREE.Vector3(DX + 3, 5.6, DZ + 0.3), new THREE.Vector3(DX + 9, 6.6, DZ + 0.25)]), 40, 0.02, 6), std({ color: "#111111", roughness: 0.6 })));
    const signTex = canvasTex(512, 128, (g) => { g.fillStyle = "#c9c2b0"; g.fillRect(0, 0, 512, 128); g.fillStyle = "#8a2a1e"; g.font = "bold 78px Helvetica"; g.fillText("BAY 13", 70, 96); for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(80,60,40,${r() * 0.2})`; g.fillRect(r() * 512, r() * 128, 3 + r() * 10, 2); } });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.5), std({ map: signTex, roughness: 0.8 })); sign.position.set(DX + dw / 2 + 1.6, dh + 0.3, DZ + 0.19); group.add(sign);
    mark("address", sign.position.clone());
    doorway({ dw, dh, leafColor: "#7d8796", leafTex: metal.map, frameColor: "#2b3038", glow: String(door?.params?.glow ?? "#ffb46a"), cold: String(door?.params?.cold ?? "#6f9dff"), inside: "#191c22" });
    for (let i = 0; i < 16; i++) { const h = 6 + r() * 10, w = 6 + r() * 8; add(new THREE.Mesh(new THREE.BoxGeometry(w, h, 6), std({ color: day ? "#8a96a6" : "#0d1422", roughness: 1 })), false).position.set(-48 + i * 6.5, h / 2, DZ - 32 - r() * 10); }
  } else if (spec.kind === "neighborhood") {
    const pal = spec.palette ?? {};
    const wall = pal.wall ?? "#e8d6b8", trimC = pal.trim ?? "#f4f1ea", roof = pal.roof ?? "#6b4a3a", doorC = pal.door ?? "#2f6f8f";
    const lawn = std({ map: grass(r), roughness: 0.95 });
    const slab = (w: number, d: number, x: number, z: number, y = 0.02): void => { const t = concrete(r); t.repeat.set(w / 1.5, d / 1.5); const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), std({ map: t, roughness: 0.9 })); m.position.set(x, y, z); add(m, false); };
    // street along x (z > 4), curb, sidewalk (z 1.4..3.8), front lawn up to the house, the path to the door
    slab(140, 2.4, 0, 2.6);
    add(new THREE.Mesh(new THREE.BoxGeometry(140, 0.14, 0.25), std({ color: "#a7a39a", roughness: 0.9 })), false).position.set(0, 0.07, 3.9);
    const lawnDepth = 1.4 - DZ;
    add(new THREE.Mesh(new THREE.BoxGeometry(70, 0.05, lawnDepth), lawn), false).position.set(0, 0.025, DZ + lawnDepth / 2);
    slab(1.5, 1.4 - (DZ + 0.3), DX, (1.4 + DZ + 0.3) / 2, 0.06);
    // the house: body, gable roof, windows with flower boxes, porch canopy, house number, doorbell
    const hw = 8.5, hh = 3.6, hd = 8;
    const wallMat = std({ map: siding(wall, r), roughness: 0.85 }); (wallMat.map as THREE.Texture).repeat.set(3, 1.5);
    const dw = 1.1, dh = 2.15;
    const frontPiece = (w: number, h: number, x: number, y: number): void => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.25), wallMat); m.position.set(x, y, DZ); add(m); };
    const lw2 = hw / 2 + DX - dw / 2, rw2 = hw / 2 - DX - dw / 2;
    frontPiece(lw2, hh, DX - dw / 2 - lw2 / 2, hh / 2); frontPiece(rw2, hh, DX + dw / 2 + rw2 / 2, hh / 2); frontPiece(dw, hh - dh, DX, dh + (hh - dh) / 2);
    add(new THREE.Mesh(new THREE.BoxGeometry(hw, hh, hd), wallMat)).position.set(DX, hh / 2, DZ - hd / 2 - 0.13);
    const roofGeo = new THREE.CylinderGeometry(0.01, hw * 0.62, 2.4, 4, 1); roofGeo.rotateY(Math.PI / 4); roofGeo.scale(1, 1, (hd + 0.8) / (hw * 0.88));
    add(new THREE.Mesh(roofGeo, std({ color: roof, roughness: 0.8 }))).position.set(DX, hh + 1.2, DZ - hd / 2);
    const trimM = std({ color: trimC, roughness: 0.6 });
    const glass = std({ color: "#3a5a78", roughness: 0.05, metalness: 0.9, envMapIntensity: 1.4 });
    for (const x of [DX - 2.6, DX + 2.6]) {
      add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.4, 0.1), trimM)).position.set(x, 1.75, DZ + 0.13);
      const g = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.2), glass); g.position.set(x, 1.75, DZ + 0.19); group.add(g);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.2, 0.04), trimM); bar.position.set(x, 1.75, DZ + 0.2); group.add(bar);
      add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.25, 0.3), std({ color: "#6b4a2a", roughness: 0.9 }))).position.set(x, 0.95, DZ + 0.3);
      for (let k = 0; k < 4; k++) { const fl = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), std({ color: ["#e8505b", "#f2c94c", "#ffffff", "#ef7aa8"][k]!, roughness: 0.8 })); fl.position.set(x - 0.5 + k * 0.33, 1.12, DZ + 0.32); group.add(fl); }
    }
    add(new THREE.Mesh(new THREE.BoxGeometry(dw + 1.2, 0.1, 1.1), trimM)).position.set(DX, dh + 0.5, DZ + 0.55);
    for (const sx of [-1, 1]) add(new THREE.Mesh(new THREE.BoxGeometry(0.1, dh + 0.5, 0.1), trimM)).position.set(DX + sx * (dw / 2 + 0.5), (dh + 0.5) / 2, DZ + 1.0);
    const numTex = canvasTex(256, 128, (g) => { g.fillStyle = "#2a2a2a"; g.fillRect(0, 0, 256, 128); g.fillStyle = "#f2e8d0"; g.font = "bold 92px Helvetica"; g.fillText("42", 70, 98); });
    const num = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.21), std({ map: numTex, roughness: 0.5, metalness: 0.3 })); num.position.set(DX + dw / 2 + 0.35, 1.75, DZ + 0.14); group.add(num);
    mark("address", num.position.clone());
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 12), std({ color: "#d8c27a", metalness: 1, roughness: 0.3 })); bell.rotation.x = Math.PI / 2; bell.position.set(DX + dw / 2 + 0.18, 1.25, DZ + 0.14); group.add(bell);
    mark("doorbell", bell.position.clone());
    doorway({ dw, dh, leafColor: doorC, frameColor: trimC, glow: "#ffd9a6", cold: "#f0e2c8", inside: "#cbb89a" });
    // neighbours, set back and differently coloured; houses across the street; trees and hedges
    const houseAt = (x: number, z: number, color: string, w = 7.5, s = 1): void => {
      const mm = std({ map: siding(color, r), roughness: 0.85 }); (mm.map as THREE.Texture).repeat.set(3, 1.5);
      add(new THREE.Mesh(new THREE.BoxGeometry(w, 3.4 * s, 7), mm)).position.set(x, 1.7 * s, z - 3.5);
      const rg = new THREE.CylinderGeometry(0.01, w * 0.62, 2.2 * s, 4, 1); rg.rotateY(Math.PI / 4); rg.scale(1, 1, 7.6 / (w * 0.88));
      add(new THREE.Mesh(rg, std({ color: ["#5a3f33", "#3f4a5a", "#6a3a2a"][Math.floor(r() * 3)]!, roughness: 0.8 }))).position.set(x, 3.4 * s + 1.1 * s, z - 3.5);
      for (const wx of [-1.8, 1.8]) { const gw = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), glass); gw.position.set(x + wx, 1.8 * s, z + 0.01); group.add(gw); }
    };
    houseAt(DX - 11.5, DZ - 1.5, "#b9d2c8"); houseAt(DX + 11.5, DZ - 0.5, "#e6c3a9"); houseAt(DX - 23, DZ - 1, "#d9d3e6"); houseAt(DX + 23, DZ - 2, "#f0e0a8");
    for (let i = 0; i < 9; i++) houseAt(-36 + i * 9 + r() * 2, 26 + r() * 4, ["#c7c0b0", "#b6c4cf", "#d6c6b6"][i % 3]!, 7, 0.9);
    for (const o of [{ x: DX - 5.6, z: DZ + 2.2, s: 1.15 }, { x: DX + 6.2, z: DZ + 3.2, s: 1 }, { x: DX - 16, z: DZ + 3, s: 1.3 }, { x: DX + 17, z: DZ + 2.5, s: 1.2 }, { x: DX - 9, z: 7.5, s: 1.2 }, { x: DX + 9, z: 8.2, s: 1.1 }]) spec.objects.push({ id: `tree-${o.x}`, kind: "tree", x: o.x, z: o.z, scale: o.s });
    for (const x of [-3.3, 3.3]) spec.objects.push({ id: `hedge${x}`, kind: "hedge", x: DX + x, z: DZ + 1.0 });
  }

  for (const o of spec.objects) {
    if (o.kind === "door") continue;
    const obj = makeObject(o, r, wet, spec.weather?.wind ?? (day ? 0.6 : 0.3));
    add(obj.object);
    named.set(o.id, obj.object);
    if (obj.update) updates.push(obj.update);
  }

  // rain in three depth layers: big soft streaks near the lens, the main layer around the action, fine rain far away
  const rain = spec.weather?.rain ?? 0;
  if (rain > 0) {
    const layer = (n: number, span: [number, number, number], len: number, opacity: number, speed: number, ahead: number): void => {
      const N = Math.round(n * rain), pos = new Float32Array(N * 6), base = new Float32Array(N * 4);
      for (let i = 0; i < N; i++) base.set([(r() - 0.5) * span[0], r() * span[1], (r() - 0.5) * span[2], 0.75 + r() * 0.5], i * 4);
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: day ? "#c9d6e6" : "#a9bddb", transparent: true, opacity, depthWrite: false }));
      lines.frustumCulled = false; group.add(lines);
      updates.push((t, _dt, cam) => {
        for (let i = 0; i < N; i++) {
          const bx = base[i * 4]!, by = base[i * 4 + 1]!, bz = base[i * 4 + 2]!, sp = base[i * 4 + 3]!;
          const y = ((by - t * speed * sp) % span[1] + span[1]) % span[1];
          const x = cam.x + bx - t * 1.1 * sp, z = cam.z + bz - ahead;
          pos.set([x, y + cam.y - 1.5, z, x + 0.04 * len, y + cam.y - 1.5 + len, z], i * 6);
        }
        geo.attributes.position!.needsUpdate = true;
      });
    };
    layer(220, [3.2, 4, 2.4], 0.8, 0.2, 9, 1.6);
    layer(2600, [14, 9, 12], 0.42, 0.34, 11, 6);
    layer(3400, [60, 16, 40], 0.3, 0.18, 12, 24);
  }
  // daylight air: a few motes drifting in the sun (a subtle depth cue, never a fog band)
  if (day && !rain) {
    const N = 160, pos = new Float32Array(N * 3), base = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) base.set([(r() - 0.5) * 10, 0.3 + r() * 3.5, (r() - 0.5) * 10, r() * 6.28], i * 4);
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: "#fff6dc", size: 0.02, transparent: true, opacity: 0.55, depthWrite: false }));
    pts.frustumCulled = false; group.add(pts);
    updates.push((t, _dt, cam) => {
      for (let i = 0; i < N; i++) { const ph = base[i * 4 + 3]!; pos.set([cam.x + base[i * 4]! + Math.sin(t * 0.3 + ph) * 0.3, base[i * 4 + 1]! + Math.sin(t * 0.21 + ph * 2) * 0.15, cam.z - 4 + base[i * 4 + 2]! + Math.cos(t * 0.25 + ph) * 0.3], i * 3); }
      geo.attributes.position!.needsUpdate = true;
    });
  }

  return {
    group, cues,
    clampCamera: (p) => { if ((spec.kind === "warehouse-exterior" || spec.kind === "neighborhood") && p.z < frontZ) p.z = frontZ; if (p.y < 0.35) p.y = 0.35; },
    named: (id) => { const o = named.get(id); return o ? o.getWorldPosition(new THREE.Vector3()) : null; },
    update: (t, dt, cam) => { for (const u of updates) u(t, dt, cam); },
  };
}

function makeObject(o: SetObject3D, r: () => number, wet: number, wind: number): { object: THREE.Object3D; update?: (t: number) => void } {
  const g = new THREE.Group();
  g.position.set(o.x, o.y ?? 0, o.z); g.rotation.y = o.rotation ?? 0; g.scale.setScalar(o.scale ?? 1);
  const m = (c: string, ro = 0.85, me = 0.1): THREE.MeshStandardMaterial => std({ color: c, roughness: Math.max(0.15, ro - 0.35 * wet), metalness: me });
  const add = (mesh: THREE.Mesh, x = 0, y = 0, z = 0): THREE.Mesh => { mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh; };
  switch (o.kind) {
    case "lamp": {
      const color = String(o.params?.color ?? "#ffc98a"), power = Number(o.params?.intensity ?? 240);
      add(new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.24, 24, 1, true), std({ color: "#1d2127", metalness: 0.7, roughness: 0.4, side: THREE.DoubleSide })), 0, 0.14, 0);
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.6, 8), m("#1d2127", 0.5, 0.7)), 0, 0.5, -0.25).rotation.x = 0.9;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshBasicMaterial({ color: "#fff1d6" })); g.add(bulb);
      const halo = glowSprite(color, 1.1); g.add(halo);
      const light = new THREE.SpotLight(color, power, 11, 0.62, 0.6, 1.8); light.castShadow = true; light.shadow.mapSize.set(1024, 1024); light.shadow.bias = -0.0004;
      light.target.position.set(0, -4, 0.9); g.add(light, light.target);
      const shaft = lightShaft(color, 4.6, 1.9, 0.2); shaft.rotation.x = Math.PI; shaft.rotateX(-0.25); g.add(shaft);
      const flick = (o.events ?? []).some((e) => e.action === "flicker");
      const off = Boolean(o.params?.off);
      return { object: g, update: (t) => { const f = off ? 0 : flick ? (Math.sin(t * 23) * Math.sin(t * 7.7) > 0.75 ? 0.35 : 1) : 0.95 + 0.05 * Math.sin(t * 41) * Math.sin(t * 7.3); light.intensity = power * f; shaft.setIntensity(0.2 * f); bulb.visible = f > 0.05; (halo.material as THREE.SpriteMaterial).opacity = 0.9 * f; } };
    }
    case "streetlamp": { add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 4.6, 10), m("#2a2e33", 0.5, 0.7)), 0, 2.3, 0); add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.25), m("#2a2e33", 0.5, 0.7)), 0.2, 4.6, 0); break; }
    case "crate": { const s = 0.9; add(new THREE.Mesh(new THREE.BoxGeometry(s, s, s), m("#6a5034", 0.9)), 0, s / 2, 0); for (const y of [0.15, 0.75]) add(new THREE.Mesh(new THREE.BoxGeometry(s + 0.02, 0.08, s + 0.02), m("#46341f", 0.9)), 0, y * s, 0); break; }
    case "barrel": { add(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.92, 24), m(String(o.params?.color ?? "#2f4a5a"), 0.45, 0.6)), 0, 0.46, 0); for (const y of [0.2, 0.72]) add(new THREE.Mesh(new THREE.TorusGeometry(0.305, 0.015, 6, 24), m("#1b1f24", 0.5, 0.8)), 0, y, 0).rotation.x = Math.PI / 2; break; }
    case "pallet": { for (let i = 0; i < 5; i++) add(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.03, 0.14), m("#7a6340", 0.95)), 0, 0.13, -0.5 + i * 0.25); for (const x of [-0.5, 0, 0.5]) add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.2), m("#5a4630", 0.95)), x, 0.05, 0); break; }
    case "dumpster": { add(new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.2, 1.1), m("#2e5a3a", 0.55, 0.5)), 0, 0.65, 0); add(new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.08, 1.15), m("#1f2a24", 0.5, 0.5)), 0, 1.3, -0.05).rotation.x = -0.12; break; }
    case "pipe": { add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3, 10), m("#2a2f36", 0.5, 0.7)), 0, 1.5, 0); break; }
    case "sign": { add(new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), std({ color: "#c7d3e0", emissive: String(o.params?.color ?? "#ff5a3c"), emissiveIntensity: 0.9 }))).castShadow = false; break; }
    case "mailbox": { const c = String(o.params?.color ?? "#2d4f86"); add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.0, 8), m("#3a3a3a", 0.6, 0.5)), 0, 0.5, 0); add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.24, 0.48), m(c, 0.45, 0.6)), 0, 1.1, 0); break; }
    case "hedge": { const hg = m("#3f6b2e", 0.95); for (let i = 0; i < 4; i++) add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.55 + r() * 0.2, 1), hg), -0.9 + i * 0.6, 0.45, (r() - 0.5) * 0.2); break; }
    case "bench": { add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.45), m("#8a5a34", 0.8)), 0, 0.45, 0); add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.4, 0.05), m("#8a5a34", 0.8)), 0, 0.7, -0.2); for (const x of [-0.7, 0.7]) add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.45, 0.4), m("#2a2a2a", 0.5, 0.7)), x, 0.22, 0); break; }
    case "car": {
      const paint = std({ color: String(o.params?.color ?? "#b8312f"), roughness: 0.25, metalness: 0.6, envMapIntensity: 1.2 });
      add(new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.65, 1.8), paint), 0, 0.62, 0);
      add(new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.55, 1.6), paint), -0.2, 1.2, 0);
      add(new THREE.Mesh(new THREE.BoxGeometry(2.32, 0.42, 1.62), std({ color: "#1a2430", roughness: 0.05, metalness: 0.9 })), -0.2, 1.22, 0);
      for (const [x, z] of [[1.35, 0.85], [1.35, -0.85], [-1.35, 0.85], [-1.35, -0.85]] as const) add(new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 18), m("#151515", 0.8)), x, 0.34, z).rotation.x = Math.PI / 2;
      break;
    }
    case "tree": {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.22, 2.6, 10), m("#5b4532", 0.95)), 0, 1.3, 0);
      const crown = new THREE.Group(); crown.position.y = 2.6; g.add(crown);
      const greens = ["#4f7d33", "#5f8f3c", "#3f6b2a", "#6a9a44"];
      for (let i = 0; i < 6; i++) { const s = 0.9 + r() * 0.7; const b = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 1), std({ color: greens[i % 4]!, roughness: 0.9 })); b.position.set((r() - 0.5) * 1.6, 0.6 + r() * 1.4, (r() - 0.5) * 1.6); b.castShadow = true; b.receiveShadow = true; crown.add(b); }
      const ph = r() * 6.28;
      return { object: g, update: (t) => { crown.rotation.z = Math.sin(t * 0.9 + ph) * 0.025 * wind; crown.rotation.x = Math.sin(t * 0.7 + ph * 1.3) * 0.018 * wind; crown.children.forEach((c, i) => { c.rotation.y = Math.sin(t * 1.3 + i) * 0.04 * wind; }); } };
    }
    case "cable": case "puddle": break;
  }
  return { object: g };
}
