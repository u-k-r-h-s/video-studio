import * as THREE from "three";
import type { EnvironmentSpec3D, SetObject3D } from "../spec";
import { glowSprite, lightShaft } from "./effects";

/**
 * Sets. Not full 3D worlds: a small, well-lit kit around where the action happens (ground, a facade with a working door,
 * a lamp, a few props, foreground pieces for depth) in front of an AI-painted plate for everything far away (hybrid 2.5D).
 * Runs in the browser (canvas textures). Named objects ("door") are targets for the characters and the camera.
 */
export interface SetInstance {
  group: THREE.Group;
  /** World point of a named object (for walk/look/aim targets). */
  named(id: string): THREE.Vector3 | null;
  update(t: number, dt: number, cameraPos: THREE.Vector3): void;
  /** Keeps a camera position out of the set's solid parts (in front of the facade, above the ground). */
  clampCamera(p: THREE.Vector3): void;
  /** Sound cues the set implies (door creak). */
  cues: { kind: "door"; at: number; volume?: number }[];
}

const rand = (seed: number): (() => number) => { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Corrugated, rust-streaked metal (colour + roughness). */
function corrugated(r: () => number): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const ribs = 22;
  const map = canvasTex(512, 512, (g) => {
    for (let x = 0; x < 512; x++) { const k = Math.sin((x / 512) * Math.PI * 2 * ribs); const v = 70 + 22 * k; g.fillStyle = `rgb(${v * 0.82},${v * 0.88},${v})`; g.fillRect(x, 0, 1, 512); }
    for (let i = 0; i < 90; i++) { const x = r() * 512, w = 2 + r() * 10, len = 40 + r() * 260; const gr = g.createLinearGradient(0, 0, 0, len); gr.addColorStop(0, `rgba(110,62,30,${0.35 * r()})`); gr.addColorStop(1, "rgba(110,62,30,0)"); g.fillStyle = gr; g.fillRect(x, r() * 200, w, len); }
    for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.12})`; g.fillRect(r() * 512, r() * 512, 1 + r() * 3, 1 + r() * 3); }
    g.fillStyle = "rgba(0,0,0,0.35)"; g.fillRect(0, 470, 512, 42); // grime at the bottom
  });
  const rough = canvasTex(512, 512, (g) => { g.fillStyle = "#b8b8b8"; g.fillRect(0, 0, 512, 512); for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(255,255,255,${r() * 0.3})`; g.fillRect(r() * 512, r() * 512, 4 + r() * 20, 40 + r() * 200); } }, false);
  const bump = canvasTex(512, 8, (g) => { for (let x = 0; x < 512; x++) { const v = 128 + 120 * Math.sin((x / 512) * Math.PI * 2 * ribs); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, 0, 1, 8); } }, false);
  return { map, rough, bump };
}

/** Wet asphalt with puddles: dark, noisy colour; puddles are smooth (low roughness) so they catch the lights. */
function asphalt(r: () => number): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const N = 1024;
  const puddles: [number, number, number, number][] = Array.from({ length: 7 }, () => [r() * N, r() * N, 30 + r() * 90, 14 + r() * 40]);
  const map = canvasTex(N, N, (g) => {
    const d = g.createImageData(N, N);
    for (let i = 0; i < N * N; i++) { const n = 26 + r() * 20 + (r() < 0.02 ? 25 : 0); d.data[i * 4] = n; d.data[i * 4 + 1] = n * 1.01; d.data[i * 4 + 2] = n * 1.07; d.data[i * 4 + 3] = 255; }
    g.putImageData(d, 0, 0);
    for (let i = 0; i < 30; i++) { g.strokeStyle = `rgba(10,10,12,${0.5 * r()})`; g.lineWidth = 1 + r() * 3; g.beginPath(); let x = r() * N, y = r() * N; g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 120; y += (r() - 0.5) * 120; g.lineTo(x, y); } g.stroke(); } // cracks
    for (const [x, y, rx, ry] of puddles) { const gr = g.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry)); gr.addColorStop(0, "rgba(10,12,16,0.35)"); gr.addColorStop(1, "rgba(10,12,16,0)"); g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, rx, ry, r() * 3, 0, Math.PI * 2); g.fill(); }
  });
  const rough = canvasTex(N, N, (g) => {
    g.fillStyle = "#d8d8d8"; g.fillRect(0, 0, N, N);
    for (const [x, y, rx, ry] of puddles) { const gr = g.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry)); gr.addColorStop(0, "#9a9a9a"); gr.addColorStop(0.7, "#bababa"); gr.addColorStop(1, "rgba(200,200,200,0)"); g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, rx * 1.1, ry * 1.1, 0, 0, Math.PI * 2); g.fill(); }
  }, false);
  for (const t of [map, rough]) t.repeat.set(16, 16);
  return { map, rough };
}

export async function buildSet(spec: EnvironmentSpec3D, scene: THREE.Scene, images: Record<string, string>, seed: number): Promise<SetInstance> {
  const r = rand(seed);
  const group = new THREE.Group();
  scene.add(group);
  const named = new Map<string, THREE.Object3D>();
  const updates: ((t: number, dt: number, cam: THREE.Vector3) => void)[] = [];
  const cues: SetInstance["cues"] = [];
  const loader = new THREE.TextureLoader();
  const img = async (key?: string): Promise<THREE.Texture | null> => {
    if (!key || !images[key]) return null;
    const t = await loader.loadAsync(images[key]!);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  // ground
  const { map, rough } = asphalt(r);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.MeshStandardMaterial({ map, roughnessMap: rough, roughness: 1, metalness: 0, color: "#a4a8b0", envMapIntensity: 0.12 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; group.add(ground);

  // the far world: an AI-painted plate on a wide curved screen, unaffected by the scene lights (it is already lit)
  const plate = await img(spec.backdrop);
  if (plate) {
    const screen = new THREE.Mesh(new THREE.CylinderGeometry(70, 70, 70, 64, 1, true, Math.PI * 0.62, Math.PI * 0.76), new THREE.MeshBasicMaterial({ map: plate, side: THREE.BackSide, fog: false, color: "#8c95a8" }));
    screen.position.set(0, 18, -8); group.add(screen);
  }

  const door = spec.objects.find((o) => o.kind === "door");
  if (spec.kind === "warehouse-exterior") {
    const DZ = door?.z ?? -8, DX = door?.x ?? 0;
    const dw = Number(door?.params?.width ?? 2.6), dh = Number(door?.params?.height ?? 3.3);
    const wallTex = await img(spec.wallTexture);
    const metal = corrugated(r);
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex ?? metal.map, roughnessMap: metal.rough, bumpMap: metal.bump, bumpScale: 2.2, roughness: 0.85, metalness: 0.35, color: wallTex ? "#9aa3b2" : "#8e98a8" });
    wallMat.map!.repeat.set(wallTex ? 1 : 3, 1);
    const H = 8.5, W = 30, D = 18;
    const piece = (w: number, h: number, x: number, y: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.35), wallMat.clone());
      (m.material as THREE.MeshStandardMaterial).map = (wallMat.map as THREE.Texture).clone(); (m.material as THREE.MeshStandardMaterial).map!.repeat.set(Math.max(1, w / 4), h / 8.5); (m.material as THREE.MeshStandardMaterial).map!.needsUpdate = true;
      m.position.set(x, y, DZ); m.castShadow = true; m.receiveShadow = true; group.add(m); return m;
    };
    const leftW = W / 2 + DX - dw / 2, rightW = W / 2 - DX - dw / 2;
    piece(leftW, H, DX - dw / 2 - leftW / 2, H / 2);
    piece(rightW, H, DX + dw / 2 + rightW / 2, H / 2);
    piece(dw, H - dh, DX, dh + (H - dh) / 2);
    const dark = new THREE.MeshStandardMaterial({ color: "#14171d", roughness: 0.9 });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, 0.5, D), dark); roof.position.set(0, H + 0.25, DZ - D / 2); roof.castShadow = true; group.add(roof);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(W + 0.8, 0.25, 0.5), new THREE.MeshStandardMaterial({ color: "#2a2f37", metalness: 0.6, roughness: 0.5 })); trim.position.set(0, H + 0.1, DZ + 0.1); group.add(trim);
    // side walls so the building has volume when the camera angles
    for (const sx of [-1, 1]) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.35, H, D), wallMat); s.position.set(sx * W / 2, H / 2, DZ - D / 2); s.castShadow = s.receiveShadow = true; group.add(s); }
    // high windows: dark glass, a few with a faint cold glow
    for (let i = 0; i < 7; i++) {
      const lit = r() < 0.35;
      const w = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9), new THREE.MeshStandardMaterial({ color: lit ? "#3b5a80" : "#0c1016", emissive: lit ? "#2b4b78" : "#000000", emissiveIntensity: lit ? 0.6 : 0, roughness: 0.15, metalness: 0.8 }));
      w.position.set(-12 + i * 4 + (Math.abs(-12 + i * 4 - DX) < 2.5 ? 2.6 : 0), 6.4, DZ + 0.19); group.add(w);
    }
    // door frame, canopy, gutter pipe
    const frameMat = new THREE.MeshStandardMaterial({ color: "#2b3038", metalness: 0.7, roughness: 0.45 });
    for (const [x, w, h, y] of [[DX - dw / 2 - 0.08, 0.16, dh + 0.1, dh / 2], [DX + dw / 2 + 0.08, 0.16, dh + 0.1, dh / 2], [DX, dw + 0.32, 0.16, dh + 0.06]] as const) { const f = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.5), frameMat); f.position.set(x, y, DZ + 0.06); f.castShadow = true; group.add(f); }
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(dw + 1.6, 0.12, 1.3), frameMat); canopy.position.set(DX, dh + 0.85, DZ + 0.65); canopy.rotation.x = 0.08; canopy.castShadow = true; group.add(canopy);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, H, 12), frameMat); pipe.position.set(DX - dw / 2 - 2.6, H / 2, DZ + 0.3); pipe.castShadow = true; group.add(pipe);

    // the interior behind the door: dark room with light deep inside that spills out when the door opens
    const roomMat = new THREE.MeshStandardMaterial({ color: "#191c22", roughness: 0.95, side: THREE.BackSide });
    const room = new THREE.Mesh(new THREE.BoxGeometry(W - 1, H - 0.2, D - 0.6), roomMat); room.position.set(0, H / 2 - 0.05, DZ - D / 2 - 0.1); room.receiveShadow = true; group.add(room);
    const spillColor = String(door?.params?.glow ?? "#ffb46a");
    const innerLight = new THREE.PointLight(spillColor, 0, 7, 1.6); innerLight.position.set(DX + 0.6, 2.2, DZ - 6); group.add(innerLight); // short range: lights the room, not the street through the walls
    const coldColor = String(door?.params?.cold ?? "#6f9dff");
    const innerCold = new THREE.PointLight(coldColor, 0, 7, 1.8); innerCold.position.set(DX - 2.5, 3.5, DZ - 9); group.add(innerCold);
    const spill = new THREE.SpotLight(spillColor, 0, 18, 0.55, 0.6, 1.3); spill.position.set(DX, 2.1, DZ - 1.2); spill.target.position.set(DX, 0, DZ + 6); spill.castShadow = true; spill.shadow.mapSize.set(1024, 1024); group.add(spill, spill.target);
    const spillShaft = lightShaft(spillColor, 8, 2.4, 0); spillShaft.position.copy(spill.position); spillShaft.lookAt(spill.target.position); spillShaft.rotateX(Math.PI / 2); group.add(spillShaft);
    // dust/shapes inside for depth: a few crates and a hanging lamp silhouette
    for (let i = 0; i < 5; i++) { const s = 0.7 + r() * 0.6; const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), new THREE.MeshStandardMaterial({ color: "#3a2f26", roughness: 0.9 })); c.position.set(DX - 3 + r() * 6, s / 2, DZ - 4 - r() * 8); c.castShadow = c.receiveShadow = true; group.add(c); }

    // the door leaf: hinged on one side, swings inward
    const hingeLeft = String(door?.params?.hinge ?? "left") === "left";
    const leafPivot = new THREE.Group(); leafPivot.position.set(DX + (hingeLeft ? -dw / 2 : dw / 2), 0, DZ - 0.05); group.add(leafPivot);
    const leafMat = new THREE.MeshStandardMaterial({ map: metal.map.clone(), bumpMap: metal.bump, bumpScale: 1.4, roughness: 0.7, metalness: 0.45, color: "#7d8796" });
    leafMat.map!.repeat.set(0.6, 1); leafMat.map!.needsUpdate = true;
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(dw - 0.04, dh - 0.04, 0.07), leafMat);
    leaf.position.set(hingeLeft ? dw / 2 : -dw / 2, dh / 2, 0); leaf.castShadow = true; leaf.receiveShadow = true; leafPivot.add(leaf);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(dw * 0.55, 0.06, 0.08), new THREE.MeshStandardMaterial({ color: "#b9bec6", metalness: 1, roughness: 0.3 })); bar.position.set(hingeLeft ? dw * 0.55 : -dw * 0.55, 1.05, 0.08); leafPivot.add(bar);
    const handle = new THREE.Object3D(); handle.position.set(DX + (hingeLeft ? dw * 0.3 : -dw * 0.3), 1.1, DZ + 0.15); group.add(handle);
    named.set("door", handle);
    const doorway = new THREE.Object3D(); doorway.position.set(DX, 1.5, DZ - 2); group.add(doorway); named.set("doorway", doorway); named.set("inside", doorway);
    const doorFront = new THREE.Object3D(); doorFront.position.set(DX + (hingeLeft ? 0.35 : -0.35), 0, DZ + 0.75); group.add(doorFront); named.set("door-front", doorFront);
    let open = 0;
    const opens = (door?.events ?? []).filter((e) => e.action === "open" || e.action === "close");
    for (const e of opens) if (e.action === "open") cues.push({ kind: "door", at: e.at, volume: 0.7 });
    updates.push((t) => {
      let o = 0;
      for (const e of opens) { const u = Math.min(1, Math.max(0, (t - e.at) / (e.duration ?? 1.6))); const k = 1 - (1 - u) ** 3; o = e.action === "open" ? (t >= e.at ? k : o) : t >= e.at ? 1 - k : o; }
      open = o;
      // a heavy door: it starts slow, swings, settles with a small bounce
      const ang = open * 1.65 + Math.sin(open * Math.PI) * 0.04;
      leafPivot.rotation.y = hingeLeft ? ang : -ang;
      const spillOn = Math.min(1, open * 1.6);
      innerLight.intensity = 140 * spillOn; innerCold.intensity = 45 * spillOn;
      spill.intensity = 420 * spillOn * (0.96 + 0.04 * Math.sin(t * 13) * Math.sin(t * 3.1));
      spillShaft.setIntensity(0.22 * spillOn);
    });
  }

  // practical lamps, set props
  for (const o of spec.objects) {
    if (o.kind === "door") continue;
    const obj = makeObject(o, r);
    group.add(obj.object);
    named.set(o.id, obj.object);
    if (obj.update) updates.push(obj.update);
  }

  // rain: streaks in a box around the camera (near drops pass in front of the character: foreground depth)
  const rain = spec.weather?.rain ?? 0;
  if (rain > 0) {
    const N = Math.round(5000 * rain), pos = new Float32Array(N * 6), base = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) base.set([(r() - 0.5) * 26, r() * 12, (r() - 0.5) * 26, 0.7 + r() * 0.6], i * 4);
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: "#a9bddb", transparent: true, opacity: 0.38, depthWrite: false }));
    lines.frustumCulled = false; group.add(lines);
    updates.push((t, _dt, cam) => {
      for (let i = 0; i < N; i++) {
        const bx = base[i * 4]!, by = base[i * 4 + 1]!, bz = base[i * 4 + 2]!, sp = base[i * 4 + 3]!;
        const y = ((by - t * 11 * sp) % 12 + 12) % 12;
        const x = cam.x + bx - t * 1.2 * sp, z = cam.z + bz - 6;
        pos.set([x, y, z, x + 0.05, y + 0.42, z], i * 6);
      }
      geo.attributes.position!.needsUpdate = true;
    });
  }

  const frontZ = (door?.z ?? -8) + 0.6;
  return {
    group, cues,
    clampCamera: (p) => { if (spec.kind === "warehouse-exterior" && p.z < frontZ) p.z = frontZ; if (p.y < 0.35) p.y = 0.35; },
    named: (id) => { const o = named.get(id); return o ? o.getWorldPosition(new THREE.Vector3()) : null; },
    update: (t, dt, cam) => { for (const u of updates) u(t, dt, cam); },
  };
}

function makeObject(o: SetObject3D, r: () => number): { object: THREE.Object3D; update?: (t: number) => void } {
  const g = new THREE.Group();
  g.position.set(o.x, o.y ?? 0, o.z); g.rotation.y = o.rotation ?? 0; g.scale.setScalar(o.scale ?? 1);
  const m = (c: string, ro = 0.85, me = 0.1): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: c, roughness: ro, metalness: me });
  const add = (mesh: THREE.Mesh, x = 0, y = 0, z = 0): THREE.Mesh => { mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh; };
  switch (o.kind) {
    case "lamp": {
      const color = String(o.params?.color ?? "#ffc98a"), power = Number(o.params?.intensity ?? 260);
      add(new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.24, 24, 1, true), new THREE.MeshStandardMaterial({ color: "#1d2127", metalness: 0.7, roughness: 0.4, side: THREE.DoubleSide })), 0, 0.14, 0);
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.6, 8), m("#1d2127", 0.5, 0.7)), 0, 0.5, -0.25).rotation.x = 0.9;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshBasicMaterial({ color: "#fff1d6" })); g.add(bulb);
      const halo = glowSprite(color, 1.2); g.add(halo);
      const light = new THREE.SpotLight(color, power, 11, 0.62, 0.6, 1.8); light.castShadow = true; light.shadow.mapSize.set(1024, 1024); light.shadow.bias = -0.0004;
      light.target.position.set(0, -4, 0.9); g.add(light, light.target);
      const shaft = lightShaft(color, 4.6, 1.9, 0.2); shaft.rotation.x = Math.PI; shaft.rotateX(-0.25); g.add(shaft);
      const flick = (o.events ?? []).some((e) => e.action === "flicker");
      return { object: g, update: (t) => { const f = flick ? (Math.sin(t * 23) * Math.sin(t * 7.7) > 0.75 ? 0.35 : 1) : 0.95 + 0.05 * Math.sin(t * 41) * Math.sin(t * 7.3); light.intensity = power * f; shaft.setIntensity(0.2 * f); (halo.material as THREE.SpriteMaterial).opacity = 0.9 * f; } };
    }
    case "crate": { const s = 0.9; add(new THREE.Mesh(new THREE.BoxGeometry(s, s, s), m("#5b4630", 0.9)), 0, s / 2, 0); for (const y of [0.15, 0.75]) add(new THREE.Mesh(new THREE.BoxGeometry(s + 0.02, 0.08, s + 0.02), m("#3d2f20", 0.9)), 0, y * s, 0); break; }
    case "barrel": { add(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.92, 24), m(String(o.params?.color ?? "#2f4a5a"), 0.45, 0.6)), 0, 0.46, 0); for (const y of [0.2, 0.72]) add(new THREE.Mesh(new THREE.TorusGeometry(0.305, 0.015, 6, 24), m("#1b1f24", 0.5, 0.8)), 0, y, 0).rotation.x = Math.PI / 2; break; }
    case "pallet": { for (let i = 0; i < 5; i++) add(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.03, 0.14), m("#6b5638", 0.95)), 0, 0.13, -0.5 + i * 0.25); for (const x of [-0.5, 0, 0.5]) add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.2), m("#5a4630", 0.95)), x, 0.05, 0); break; }
    case "dumpster": { add(new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.2, 1.1), m("#2e4b3a", 0.55, 0.5)), 0, 0.65, 0); add(new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.08, 1.15), m("#1f2a24", 0.5, 0.5)), 0, 1.3, -0.05).rotation.x = -0.12; break; }
    case "pipe": { add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3, 10), m("#2a2f36", 0.5, 0.7)), 0, 1.5, 0); break; }
    case "sign": { const s = add(new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), new THREE.MeshStandardMaterial({ color: "#c7d3e0", emissive: String(o.params?.color ?? "#ff5a3c"), emissiveIntensity: 0.9 })), 0, 0, 0); s.castShadow = false; break; }
    case "puddle": break;
  }
  void r;
  return { object: g };
}
