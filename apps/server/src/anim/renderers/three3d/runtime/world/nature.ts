import * as THREE from "three";
import { Water } from "three/examples/jsm/objects/Water.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Noise2D, mulberry, smoothstep } from "./noise";

/**
 * Reusable natural-world elements for the Three.js sets: terrain (flat land, hills, mountains, a carved river bed, a lake
 * basin, a beach), water (planar-reflection river / lake / sea with moving normals), a waterfall, instanced vegetation
 * that sways in the wind (broadleaf and conifer forests, palms, grass, crop fields), drifting clouds and bird flocks.
 *
 * Every animated element is a pure function of the shot time t (or of the camera, itself deterministic), so any frame can
 * be rendered on its own (chunks). Geometry and materials are built once and shared by instancing.
 */
export interface WorldCtx {
  group: THREE.Group;
  scene: THREE.Scene;
  seed: number;
  day: boolean;
  wet: number;
  /** Time of day colouring: the sun's direction and colour (from the lighting preset). */
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  /** Per-frame updates of the set: (t, dt, camera position). */
  updates: ((t: number, dt: number, cam: THREE.Vector3) => void)[];
  /** Wind strength 0..1 (from the weather). */
  wind: number;
}

// ---------- wind: a vertex-shader sway shared by every plant material (one uniform, set from t each frame) ----------
const windUniforms = { uTime: { value: 0 }, uWind: { value: 0.5 } };
export function windTick(ctx: WorldCtx): void {
  windUniforms.uWind.value = ctx.wind;
  ctx.updates.push((t) => { windUniforms.uTime.value = t; });
}
/** Makes a material sway: displacement grows with the vertex's height in the model (0 at the root, full at `height`). */
function sway<T extends THREE.Material>(m: T, height: number, amp: number, freq: number): T {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = windUniforms.uTime; sh.uniforms.uWind = windUniforms.uWind;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nuniform float uTime; uniform float uWind;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
      #else
        vec2 ip = vec2(0.0);
      #endif
      float k = clamp(position.y / ${height.toFixed(3)}, 0.0, 1.0); k = k * k;
      float ph = dot(ip, vec2(0.37, 0.71));
      float gust = 0.65 + 0.35 * sin(uTime * 0.37 + ip.x * 0.05);
      transformed.x += (sin(uTime * ${freq.toFixed(3)} + ph) * 0.7 + sin(uTime * ${(freq * 2.3).toFixed(3)} + ph * 1.7) * 0.3) * ${amp.toFixed(3)} * uWind * gust * k;
      transformed.z += sin(uTime * ${(freq * 0.8).toFixed(3)} + ph * 1.3) * ${(amp * 0.5).toFixed(3)} * uWind * gust * k;`);
  };
  m.customProgramCacheKey = () => `sway-${height}-${amp}-${freq}`;
  return m;
}

// ---------- textures ----------
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** A tileable water normal map (sum of waves with whole-number frequencies, so it repeats seamlessly). */
let waterNormalsTex: THREE.DataTexture | null = null;
export function waterNormals(): THREE.DataTexture {
  if (waterNormalsTex) return waterNormalsTex;
  const N = 256, data = new Uint8Array(N * N * 4), r = mulberry(91);
  const waves = Array.from({ length: 24 }, () => ({ fx: Math.round((r() - 0.5) * 16), fy: Math.round((r() - 0.5) * 16), a: 0.4 + r(), p: r() * 6.28 })).filter((w) => w.fx || w.fy);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let dx = 0, dy = 0;
    for (const w of waves) { const k = 2 * Math.PI * ((w.fx * x) / N + (w.fy * y) / N) + w.p, c = Math.cos(k) * w.a / Math.hypot(w.fx, w.fy); dx += c * w.fx; dy += c * w.fy; }
    const n = new THREE.Vector3(-dx * 0.12, -dy * 0.12, 1).normalize(), i = (y * N + x) * 4;
    data[i] = (n.x * 0.5 + 0.5) * 255; data[i + 1] = (n.y * 0.5 + 0.5) * 255; data[i + 2] = (n.z * 0.5 + 0.5) * 255; data[i + 3] = 255;
  }
  waterNormalsTex = new THREE.DataTexture(data, N, N); waterNormalsTex.wrapS = waterNormalsTex.wrapT = THREE.RepeatWrapping; waterNormalsTex.needsUpdate = true;
  return waterNormalsTex;
}
function detailTex(seed: number): THREE.CanvasTexture {
  const r = mulberry(seed);
  const t = canvasTex(512, 512, (g) => { g.fillStyle = "#e8e8e8"; g.fillRect(0, 0, 512, 512); for (let i = 0; i < 9000; i++) { const v = 150 + r() * 105; g.fillStyle = `rgba(${v},${v},${v},${0.25 + r() * 0.3})`; g.fillRect(r() * 512, r() * 512, 1 + r() * 3, 1 + r() * 3); } });
  t.repeat.set(60, 60);
  return t;
}

// ---------- terrain ----------
export interface TerrainOptions {
  relief: "flat" | "hills" | "mountains";
  /** River centre line z(x) and width; a lake ellipse; a sea beyond a shoreline (z of the water's edge). */
  river?: { z: (x: number) => number; width: number };
  lake?: { cx: number; cz: number; rx: number; rz: number };
  sea?: { shoreZ: number };
  /** Where the action happens: kept flat. */
  pad: { x: number; z: number; rx: number; rz: number };
  snow?: boolean;
  /** Ground colours: lush, dry, sand. */
  palette?: { grass?: string; dry?: string; rock?: string; sand?: string };
}
export interface Terrain { mesh: THREE.Mesh; height: (x: number, z: number) => number; waterLevel: number }

export function terrain(ctx: WorldCtx, o: TerrainOptions): Terrain {
  const n = new Noise2D(ctx.seed), n2 = new Noise2D(ctx.seed + 7);
  // heights that leave sky above the ridge in a 9:16 frame from eye level (the range is ~230 m away: ~15 degrees up)
  const H = o.relief === "mountains" ? 75 : o.relief === "hills" ? 26 : 6;
  const waterLevel = -0.45;
  const height = (x: number, z: number): number => {
    let h = 0.45 * n.fbm(x * 0.045, z * 0.045, 4);
    const pd = Math.hypot((x - o.pad.x) / o.pad.rx, (z - o.pad.z) / o.pad.rz);
    h *= smoothstep(0.8, 1.6, pd); // the stage is level
    if (o.river) { const d = Math.abs(z - o.river.z(x)), half = o.river.width / 2; h -= 1.6 * (1 - smoothstep(half - 1, half + 3.5, d)); }
    if (o.lake) { const d = Math.hypot((x - o.lake.cx) / o.lake.rx, (z - o.lake.cz) / o.lake.rz); h -= 2.2 * (1 - smoothstep(0.85, 1.12, d)); }
    if (o.sea) h -= 3.5 * smoothstep(o.sea.shoreZ + 4, o.sea.shoreZ - 14, z);
    // the far relief: behind the action and to the sides, rising with distance; ridged crests for mountains
    const R = Math.hypot(x, z);
    // the range stands well back (rising from ~90 m, full height at ~230 m): it reads as distant mountains under the sky,
    // not as a wall behind the actors
    const back = smoothstep(-80, -235, z), side = smoothstep(110, 230, Math.abs(x)) * 0.85, front = smoothstep(90, 220, z) * 0.35;
    const m = Math.max(back, side, front) * smoothstep(90, 230, R);
    if (m > 0 && !(o.sea && z < o.sea.shoreZ)) {
      const ridge = o.relief === "mountains" ? n2.ridged(x * 0.009, z * 0.009) : 0.5 + 0.5 * n2.fbm(x * 0.012, z * 0.012, 4);
      h += m * H * (0.35 + 0.9 * ridge) * (o.relief === "flat" ? 0.3 : 1);
    }
    return h;
  };
  const S = 560, SEG = 230, geo = new THREE.PlaneGeometry(S, S, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position!, colors = new Float32Array(pos.count * 3);
  const pal = { grass: new THREE.Color(o.palette?.grass ?? "#527d33"), dry: new THREE.Color(o.palette?.dry ?? "#9a9a55"), rock: new THREE.Color(o.palette?.rock ?? "#77726a"), sand: new THREE.Color(o.palette?.sand ?? "#cdb88c"), snow: new THREE.Color("#f3f5f8"), mud: new THREE.Color("#6b5a43") };
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), y = height(x, z);
    pos.setY(i, y);
    const slope = Math.min(1, (Math.abs(height(x + 1, z) - y) + Math.abs(height(x, z + 1) - y)) * 0.9);
    const v = n.at(x * 0.11, z * 0.11) * 0.5 + 0.5;
    c.copy(pal.grass).lerp(pal.dry, Math.min(1, v * 0.6 + Math.max(0, y) / (H * 1.4)));
    // forested lower slopes, bare rock only where it is both steep and high
    c.lerp(new THREE.Color("#3d5a32"), smoothstep(2, 12, y) * (1 - smoothstep(H * 0.45, H * 0.7, y)) * 0.7);
    c.lerp(pal.rock, smoothstep(0.55, 1.1, slope) * smoothstep(H * 0.3, H * 0.55, y));
    if (o.snow) c.lerp(pal.snow, smoothstep(H * 0.55, H * 0.72, y + n.at(x * 0.05, z * 0.05) * 8));
    if (o.river && Math.abs(z - o.river.z(x)) < o.river.width / 2 + 2.6) c.lerp(y < waterLevel + 0.1 ? pal.mud : pal.sand, 0.85);
    if (o.lake && Math.hypot((x - o.lake.cx) / o.lake.rx, (z - o.lake.cz) / o.lake.rz) < 1.08) c.lerp(pal.sand, 0.8);
    if (o.sea && z < o.sea.shoreZ + 9) c.lerp(pal.sand, smoothstep(o.sea.shoreZ + 9, o.sea.shoreZ + 4, z));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, map: detailTex(ctx.seed + 3), roughness: 0.96, metalness: 0 }));
  mesh.receiveShadow = true;
  ctx.group.add(mesh);
  return { mesh, height, waterLevel };
}

// ---------- water ----------
/** Planar-reflection water (three.js Water) on a horizontal surface given in world x/z, moving with t. */
function waterSurface(ctx: WorldCtx, shape: THREE.BufferGeometry, level: number, o: { color: string; flow: [number, number]; distortion: number; size: number }): Water {
  const w = new Water(shape, {
    textureWidth: 512, textureHeight: 512, waterNormals: waterNormals(), sunDirection: ctx.sunDir.clone(), sunColor: ctx.day ? ctx.sunColor.getHex() : 0x445566,
    waterColor: new THREE.Color(o.color).getHex(), distortionScale: o.distortion, fog: true,
  });
  w.rotation.x = -Math.PI / 2; w.position.y = level;
  const u = w.material.uniforms;
  u.size!.value = o.size;
  ctx.group.add(w);
  // Water's own time uniform scrolls the normals; flow is added by moving the sampled pattern along the river
  ctx.updates.push((t) => { u.time!.value = t * (0.5 + Math.hypot(...o.flow) * 0.25); });
  return w;
}
/** A river ribbon following z(x); local Y = -world Z (the surface is laid flat by Water's -90 degree X rotation). */
export function river(ctx: WorldCtx, t: Terrain, o: { z: (x: number) => number; width: number; color?: string }): Water {
  const geo = new THREE.PlaneGeometry(560, o.width + 3, 220, 1), p = geo.attributes.position!;
  // local y = -world z; the across-river offset is added (a shear), never negated: a mirrored layout would flip the
  // triangles to face down and the surface would be culled (it was: the river rendered as a dry bed)
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), across = p.getY(i); p.setY(i, across - o.z(x)); }
  return waterSurface(ctx, geo, t.waterLevel, { color: o.color ?? (ctx.day ? "#2f5d5a" : "#0b1a22"), flow: [1, 0], distortion: 3.5, size: 2.2 });
}
export function lake(ctx: WorldCtx, t: Terrain, o: { cx: number; cz: number; rx: number; rz: number; color?: string }): Water {
  const geo = new THREE.CircleGeometry(1, 96); geo.scale(o.rx * 1.12, o.rz * 1.12, 1); geo.translate(o.cx, -o.cz, 0);
  return waterSurface(ctx, geo, t.waterLevel + 0.15, { color: o.color ?? (ctx.day ? "#2a5a6a" : "#08141c"), flow: [0.2, 0.1], distortion: 1.6, size: 3.2 });
}
/** The sea to the horizon, with a breaking shoreline: a foam band that runs up the beach and back. */
export function sea(ctx: WorldCtx, t: Terrain, o: { shoreZ: number }): Water {
  const geo = new THREE.PlaneGeometry(700, 320); geo.translate(0, -(o.shoreZ - 160 + 2), 0);
  const w = waterSurface(ctx, geo, t.waterLevel + 0.25, { color: ctx.day ? "#1f5a73" : "#081622", flow: [0, 1], distortion: 5, size: 1.4 });
  const foamTex = canvasTex(512, 64, (g) => { const r = mulberry(5); g.clearRect(0, 0, 512, 64); for (let i = 0; i < 2600; i++) { const y = 8 + r() * 48, a = (1 - Math.abs(y - 32) / 26) * 0.9; g.fillStyle = `rgba(255,255,255,${a * r()})`; g.beginPath(); g.ellipse(r() * 512, y, 2 + r() * 9, 1 + r() * 3, 0, 0, 7); g.fill(); } });
  foamTex.repeat.set(30, 1);
  const foamMat = new THREE.MeshBasicMaterial({ map: foamTex, transparent: true, depthWrite: false, opacity: 0.85, color: ctx.day ? "#ffffff" : "#8899aa" });
  const bands = [0, 1, 2].map((k) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(700, 2.4), foamMat.clone()); m.rotation.x = -Math.PI / 2; ctx.group.add(m); return { m, k }; });
  ctx.updates.push((time) => {
    for (const { m, k } of bands) {
      // each wave runs up the sand, thins out, and slides back (period 7 s, staggered)
      const ph = ((time / 7 + k / 3) % 1 + 1) % 1, run = Math.sin(ph * Math.PI);
      const z = o.shoreZ - 1.5 + run * 4.5;
      m.position.set(0, t.height(0, z) + 0.06 + 0.02 * k, z);
      (m.material as THREE.MeshBasicMaterial).opacity = 0.75 * Math.sin(Math.min(1, ph * 1.4) * Math.PI);
      (m.material as THREE.MeshBasicMaterial).map!.offset.x = time * 0.01 + k * 0.3;
    }
  });
  return w;
}

/** A waterfall down a rock face into a pool: falling sheet (scrolling streaks), foam at the foot, mist. */
export function waterfall(ctx: WorldCtx, t: Terrain, o: { x: number; z: number; height: number; width: number }): void {
  const base = t.height(o.x, o.z + 4);
  const rock = new THREE.MeshStandardMaterial({ color: "#5d5953", roughness: 0.95, flatShading: true });
  const cliffGeo = new THREE.BoxGeometry(o.width * 4, o.height + 6, 6, 8, 12, 2), cp = cliffGeo.attributes.position!, nn = new Noise2D(ctx.seed + 11);
  for (let i = 0; i < cp.count; i++) cp.setZ(i, cp.getZ(i) + nn.at(cp.getX(i) * 0.3, cp.getY(i) * 0.3) * 1.2);
  cliffGeo.computeVertexNormals();
  const cliff = new THREE.Mesh(cliffGeo, rock); cliff.position.set(o.x, base + (o.height + 6) / 2 - 2, o.z - 3.2); cliff.castShadow = true; cliff.receiveShadow = true; ctx.group.add(cliff);
  const sheetGeo = new THREE.PlaneGeometry(o.width, o.height, 8, 24), sp = sheetGeo.attributes.position!;
  for (let i = 0; i < sp.count; i++) { const v = (sp.getY(i) / o.height) + 0.5; sp.setZ(i, (1 - v) * (1 - v) * 2.2); } // the sheet curves out at the lip
  const sheet = new THREE.Mesh(sheetGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
    uniforms: { uTime: { value: 0 }, uTint: { value: new THREE.Color(ctx.day ? "#e9f3f6" : "#7f93a3") }, ...THREE.UniformsLib.fog },
    vertexShader: "varying vec2 vUv;\n#include <fog_pars_vertex>\nvoid main(){ vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mvPosition;\n#include <fog_vertex>\n}",
    fragmentShader: `uniform float uTime; uniform vec3 uTint; varying vec2 vUv;
      #include <fog_pars_fragment>
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      void main(){
        float y = vUv.y + uTime * 1.35;
        float s = vn(vec2(vUv.x * 22.0, y * 3.0)) * 0.6 + vn(vec2(vUv.x * 55.0, y * 7.0)) * 0.4;
        float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
        float a = (0.45 + 0.55 * s) * edge * (0.75 + 0.25 * smoothstep(0.0, 0.2, vUv.y));
        gl_FragColor = vec4(uTint * (0.8 + 0.3 * s), a);
        #include <fog_fragment>
      }`,
  }));
  sheet.position.set(o.x, base + o.height / 2, o.z); ctx.group.add(sheet);
  const mistTex = canvasTex(128, 128, (g) => { const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62); gr.addColorStop(0, "rgba(255,255,255,0.55)"); gr.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); });
  const mists = Array.from({ length: 7 }, (_, i) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, transparent: true, depthWrite: false, opacity: 0.5 })); ctx.group.add(s); return { s, i }; });
  ctx.updates.push((time) => {
    (sheet.material as THREE.ShaderMaterial).uniforms.uTime!.value = time;
    for (const { s, i } of mists) {
      const ph = ((time * 0.25 + i / 7) % 1 + 1) % 1;
      s.position.set(o.x + (i - 3) * o.width * 0.18, base + 0.5 + ph * 5, o.z + 2 + Math.sin(i * 2.1) * 1.5);
      s.scale.setScalar(4 + ph * 7); (s.material as THREE.SpriteMaterial).opacity = 0.45 * Math.sin(ph * Math.PI);
    }
  });
  lake(ctx, t, { cx: o.x, cz: o.z + 5, rx: o.width * 1.4, rz: 5 });
}

// ---------- vegetation ----------
type Species = "broadleaf" | "conifer" | "palm";
let treeGeo: Partial<Record<Species, { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; height: number }>> = {};
function treeGeometry(kind: Species): { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; height: number } {
  if (treeGeo[kind]) return treeGeo[kind]!;
  const r = mulberry(kind.length * 17), nz = new Noise2D(kind.length);
  const tint = (g: THREE.BufferGeometry, c: string, vary = 0.12): THREE.BufferGeometry => {
    const col = new THREE.Color(c), arr = new Float32Array(g.attributes.position!.count * 3), p = g.attributes.position!;
    for (let i = 0; i < p.count; i++) { const k = 1 + (nz.at(p.getX(i) * 3, p.getY(i) * 3 + p.getZ(i) * 2) * vary) + (p.getY(i) * 0.02); arr.set([col.r * k, col.g * k, col.b * k], i * 3); }
    g.setAttribute("color", new THREE.BufferAttribute(arr, 3)); return g;
  };
  const lumpy = (g: THREE.BufferGeometry, amt: number): THREE.BufferGeometry => {
    const p = g.attributes.position!;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i), d = 1 + nz.at(x * 2.3 + z, y * 2.3) * amt; p.setXYZ(i, x * d, y * (1 + (d - 1) * 0.5), z * d); }
    g.computeVertexNormals(); return g;
  };
  let out: { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; height: number };
  if (kind === "conifer") {
    const trunk = tint(new THREE.CylinderGeometry(0.12, 0.22, 2.2, 7).translate(0, 1.1, 0), "#4e3a2a");
    const tiers = [0, 1, 2, 3].map((i) => lumpy(new THREE.ConeGeometry(2.1 - i * 0.42, 2.6 - i * 0.3, 9, 2).translate(0, 2.4 + i * 1.45, 0), 0.08));
    out = { trunk, crown: tint(mergeGeometries(tiers.map((g) => (g.index ? g.toNonIndexed() : g)))!, "#2f5a33", 0.18), height: 8 };
  } else if (kind === "palm") {
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.35, 3, 0), new THREE.Vector3(1.1, 6.2, 0), new THREE.Vector3(1.9, 8.2, 0)]);
    const trunk = tint(new THREE.TubeGeometry(curve, 16, 0.2, 8), "#8a7155", 0.2);
    const top = curve.getPoint(1), fronds: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2 + r() * 0.3, len = 3.2 + r() * 0.8, shape: number[] = [], N = 10;
      for (let i = 0; i <= N; i++) { const u = i / N, w = Math.sin(u * Math.PI) * 0.55, droop = -u * u * 2.0; shape.push(u * len, droop, -w, u * len, droop, w); }
      const g = new THREE.BufferGeometry(), idx: number[] = [];
      for (let i = 0; i < N; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      g.setAttribute("position", new THREE.Float32BufferAttribute(shape, 3)); g.setIndex(idx); g.computeVertexNormals();
      g.rotateY(a); g.translate(top.x, top.y, top.z); fronds.push(g.index ? g.toNonIndexed() : g);
    }
    out = { trunk, crown: tint(mergeGeometries(fronds)!, "#3f6f2f", 0.2), height: 10 };
  } else {
    const trunk = tint(new THREE.CylinderGeometry(0.16, 0.3, 3.0, 8).translate(0, 1.5, 0), "#5b4532");
    const blobs = Array.from({ length: 7 }, () => ((g) => (g.index ? g.toNonIndexed() : g))(lumpy(new THREE.IcosahedronGeometry(1.1 + r() * 0.8, 2).translate((r() - 0.5) * 2.2, 3.4 + r() * 1.9, (r() - 0.5) * 2.2), 0.22)));
    out = { trunk, crown: tint(mergeGeometries(blobs)!, "#4f7f35", 0.22), height: 6.5 };
  }
  treeGeo[kind] = out;
  return out;
}
/** Instanced trees scattered over an area (rejection-sampled against `free`), swaying in the wind. */
export function forest(ctx: WorldCtx, t: Terrain | null, o: { kind: Species; count: number; area: { x0: number; x1: number; z0: number; z1: number }; free: (x: number, z: number) => boolean; scale?: [number, number] }): number {
  const r = mulberry(ctx.seed + o.kind.length * 101), g = treeGeometry(o.kind);
  const trunkMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const crownMat = sway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: o.kind === "palm" ? THREE.DoubleSide : THREE.FrontSide }), g.height, o.kind === "palm" ? 0.35 : 0.22, o.kind === "palm" ? 1.1 : 0.8);
  const trunks = new THREE.InstancedMesh(g.trunk, trunkMat, o.count), crowns = new THREE.InstancedMesh(g.crown, crownMat, o.count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  let k = 0;
  for (let tries = 0; k < o.count && tries < o.count * 30; tries++) {
    const x = o.area.x0 + r() * (o.area.x1 - o.area.x0), z = o.area.z0 + r() * (o.area.z1 - o.area.z0);
    if (!o.free(x, z)) continue;
    const y = t ? t.height(x, z) : 0;
    if (t && y < t.waterLevel + 0.3) continue;
    const sc = (o.scale?.[0] ?? 0.8) + r() * ((o.scale?.[1] ?? 1.4) - (o.scale?.[0] ?? 0.8));
    m.compose(p.set(x, y - 0.1, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28), s.setScalar(sc));
    trunks.setMatrixAt(k, m); crowns.setMatrixAt(k, m);
    // a near-neutral tint per tree (the species colour is in the vertex colours): variety without neon greens
    crowns.setColorAt(k, col.setRGB(0.82 + r() * 0.22, 0.86 + r() * 0.18, 0.78 + r() * 0.2));
    k++;
  }
  trunks.count = crowns.count = k;
  for (const im of [trunks, crowns]) { im.castShadow = true; im.receiveShadow = true; im.instanceMatrix.needsUpdate = true; ctx.group.add(im); }
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  return k;
}
/** Instanced grass blades (and optionally a crop: wheat / mustard / paddy rows) that sway. */
export function grass(ctx: WorldCtx, t: Terrain | null, o: { count: number; area: { x0: number; x1: number; z0: number; z1: number }; free: (x: number, z: number) => boolean; crop?: "wheat" | "mustard" | "paddy"; height?: [number, number] }): number {
  const r = mulberry(ctx.seed + 333);
  // fine blades (2-3.5 cm), a slight curve: a lawn at a metre, a texture at ten
  const blade = new THREE.BufferGeometry(), W = o.crop ? 0.035 : 0.016;
  blade.setAttribute("position", new THREE.Float32BufferAttribute([-W, 0, 0, W, 0, 0, -W * 0.6, 0.5, 0.02, W * 0.6, 0.5, 0.02, 0, 1, 0.08], 3));
  blade.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
  const base = new THREE.Color(o.crop === "mustard" ? "#7a8a2a" : o.crop === "wheat" ? "#9b8a3e" : "#35591f"), tip = new THREE.Color(o.crop === "mustard" ? "#e8c62a" : o.crop === "wheat" ? "#d9c27a" : o.crop === "paddy" ? "#8fbf4a" : "#6f9a40");
  blade.setAttribute("color", new THREE.Float32BufferAttribute([...base.toArray(), ...base.toArray(), ...base.clone().lerp(tip, 0.5).toArray(), ...base.clone().lerp(tip, 0.5).toArray(), ...tip.toArray()], 3));
  blade.computeVertexNormals();
  const mat = sway(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 }), 1, 0.12, 1.6);
  const im = new THREE.InstancedMesh(blade, mat, o.count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
  const [h0, h1] = o.height ?? (o.crop ? [0.7, 1.0] : [0.12, 0.3]);
  let k = 0;
  for (let tries = 0; k < o.count && tries < o.count * 6; tries++) {
    let x = o.area.x0 + r() * (o.area.x1 - o.area.x0), z = o.area.z0 + r() * (o.area.z1 - o.area.z0);
    if (o.crop) z = Math.round(z / 0.6) * 0.6 + (r() - 0.5) * 0.12; // planted in rows
    if (!o.free(x, z)) continue;
    const y = t ? t.height(x, z) : 0;
    if (t && y < t.waterLevel + 0.2) continue;
    const h = h0 + r() * (h1 - h0);
    m.compose(p.set(x, y, z), q.setFromEuler(e.set((r() - 0.5) * 0.5, r() * 6.28, (r() - 0.5) * 0.5)), s.set(1 + r() * 0.8, h, 1));
    im.setMatrixAt(k++, m);
  }
  im.count = k; im.receiveShadow = true; im.instanceMatrix.needsUpdate = true; ctx.group.add(im);
  return k;
}

// ---------- sky life ----------
/** Soft cloud billboards drifting across the sky (tinted by the light; wrap far outside the view). */
export function clouds(ctx: WorldCtx, o: { count: number; speed: number; cover: number; tint?: string }): void {
  const r = mulberry(ctx.seed + 55);
  const tex = [0, 1, 2].map((v) => canvasTex(256, 128, (g) => {
    const rr = mulberry(v * 31 + 7);
    for (let i = 0; i < 16; i++) { const x = 40 + rr() * 176, y = 50 + rr() * 40 - Math.abs(x - 128) * 0.12, rad = 18 + rr() * 34; const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, "rgba(255,255,255,0.85)"); gr.addColorStop(0.6, "rgba(255,255,255,0.45)"); gr.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = gr; g.fillRect(0, 0, 256, 128); }
  }));
  const color = new THREE.Color(o.tint ?? (ctx.day ? "#ffffff" : "#3a4558"));
  const list = Array.from({ length: o.count }, (_, i) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex[i % 3]!, color, transparent: true, depthWrite: false, fog: false, opacity: 0.55 + 0.4 * o.cover }));
    const w = 50 + r() * 70; s.scale.set(w, w * 0.45, 1); s.renderOrder = -1;
    ctx.group.add(s);
    return { s, x0: (r() - 0.5) * 600, y: 55 + r() * 60, z: -140 - r() * 120, sp: o.speed * (0.7 + r() * 0.6) };
  });
  ctx.updates.push((t, _dt, cam) => { for (const c of list) { const x = ((c.x0 + c.sp * t + 300) % 600 + 600) % 600 - 300; c.s.position.set(cam.x + x, c.y, c.z); } });
}

/** Bird flocks gliding and flapping along closed loops (or a long fly-by), pure functions of t. */
export function birds(ctx: WorldCtx, o: { flocks: number; perFlock: number; area: { cx: number; cz: number; rx: number; rz: number }; height: [number, number] }): void {
  const r = mulberry(ctx.seed + 77);
  const mat = new THREE.MeshStandardMaterial({ color: ctx.day ? "#2b2a29" : "#111111", roughness: 0.8, side: THREE.DoubleSide });
  const body = new THREE.SphereGeometry(0.11, 8, 6); body.scale(1, 0.75, 2.4);
  const wingGeo = new THREE.BufferGeometry(); wingGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0.12, 0, 0, -0.14, 0.62, 0.02, -0.1, 0, 0, 0.12, 0.62, 0.02, -0.1, 0.38, 0.01, 0.06], 3)); wingGeo.computeVertexNormals();
  type Bird = { g: THREE.Group; wl: THREE.Object3D; wr: THREE.Object3D; off: THREE.Vector3; ph: number; f: number };
  const flocks = Array.from({ length: o.flocks }, (_, fi) => {
    const rx = o.area.rx * (0.7 + r() * 0.5), rz = o.area.rz * (0.7 + r() * 0.5), h = o.height[0] + r() * (o.height[1] - o.height[0]);
    const speed = 7 + r() * 4, len = Math.PI * (3 * (rx + rz) - Math.sqrt((3 * rx + rz) * (rx + 3 * rz))), dir = r() < 0.5 ? 1 : -1;
    const birdsIn: Bird[] = Array.from({ length: o.perFlock }, (_, bi) => {
      const g = new THREE.Group(), b = new THREE.Mesh(body, mat); g.add(b);
      const wl = new THREE.Group(), wr = new THREE.Group(), ml = new THREE.Mesh(wingGeo, mat), mr = new THREE.Mesh(wingGeo, mat);
      mr.scale.x = -1; wl.add(ml); wr.add(mr); g.add(wl, wr); g.scale.setScalar(1.3 + r() * 0.5);
      ctx.group.add(g);
      const row = Math.ceil(bi / 2), side = bi % 2 ? 1 : -1;
      return { g, wl, wr, off: new THREE.Vector3(side * row * 1.6 + (r() - 0.5) * 0.8, (r() - 0.5) * 1.2, -row * 1.9 + (r() - 0.5) * 0.8), ph: r() * 6.28, f: 3.2 + r() * 1.2 };
    });
    return { rx, rz, h, w: (speed / len) * Math.PI * 2 * dir, a0: r() * 6.28, birdsIn, fi };
  });
  const up = new THREE.Vector3(0, 1, 0), tan = new THREE.Vector3(), side = new THREE.Vector3(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3();
  ctx.updates.push((t) => {
    for (const fl of flocks) {
      const a = fl.a0 + fl.w * t;
      const cx = o.area.cx + Math.cos(a) * fl.rx, cz = o.area.cz + Math.sin(a) * fl.rz;
      tan.set(-Math.sin(a) * fl.rx * Math.sign(fl.w), 0, Math.cos(a) * fl.rz * Math.sign(fl.w)).normalize();
      side.crossVectors(up, tan).normalize();
      m.makeBasis(side, up, tan); q.setFromRotationMatrix(m);
      for (const b of fl.birdsIn) {
        pos.set(cx, fl.h + Math.sin(t * 0.7 + b.ph) * 0.6, cz).addScaledVector(side, b.off.x).addScaledVector(tan, b.off.z);
        pos.y += b.off.y;
        b.g.position.copy(pos); b.g.quaternion.copy(q);
        // flap in bursts, glide between them (a smooth blend, never a cut)
        const glide = smoothstep(0.2, 0.7, Math.sin(t * 0.45 + b.ph * 0.7));
        const flap = Math.sin(t * b.f * 2 * Math.PI + b.ph) * 0.75 * (1 - glide) + 0.12 * glide;
        b.wl.rotation.z = flap; b.wr.rotation.z = -flap;
      }
    }
  });
}
