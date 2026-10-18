import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { box, dirt, farRural, plaster, practical, shade, sign, std, tex, type Clamp, type KitCtx } from "../kits";
import type { InteractionSpec3D } from "../../spec";
import { BUCKET_LITRES, handleAngle, litres, pumpFlow, pumpHandle, tapFlow } from "./interactions";
import { mulberry } from "./noise";

/**
 * An Indian village lane, composed (not scattered):
 *  - the lane: packed earth with a lighter worn path, a stone-lined drain along the house side, grass verges;
 *  - the main house (the facade with the working door, as every kit has): plastered walls on a plinth, barred and
 *    shuttered windows, a parapet with coping, a tiled lean-to veranda on wooden posts, potted plants;
 *  - its courtyard (aangan) to the left behind a boundary wall with a gate: charpai, clay stove, matkas, a tulsi
 *    planter, buckets, a clothes line;
 *  - neighbours: a house with a double-pitched clay-tile roof and a bench, a thatched hut; a neem tree, banana plants,
 *    shrubs; fields and a tree line beyond (no city);
 *  - water: an India Mark II hand pump on a concrete platform with a drain lip, and a standpipe tap, each with a steel
 *    bucket; both work (handle, flow, splash, the bucket fills) as pure functions of t (world/interactions.ts).
 * The stage (where conversations are blocked, x -3.5..1.5, z 1.5..4) and the camera side (z > 4) are kept clear.
 * Named points: door, door-front, doorway, address, doorbell, pump-handle, pump-stand, pump-spout, tap, tap-stand.
 */
const clayTiles = (rr: () => number, base: string): THREE.CanvasTexture => tex(256, 256, (g) => {
  g.fillStyle = shade(base, 0.7); g.fillRect(0, 0, 256, 256);
  for (let row = 0; row < 8; row++) for (let i = 0; i < 9; i++) {
    const x = i * 32 - (row % 2) * 16, y = row * 32, c = new THREE.Color(base).multiplyScalar(0.85 + rr() * 0.3);
    const gr = g.createLinearGradient(x, 0, x + 30, 0); gr.addColorStop(0, `#${c.clone().multiplyScalar(0.7).getHexString()}`); gr.addColorStop(0.5, `#${c.getHexString()}`); gr.addColorStop(1, `#${c.clone().multiplyScalar(0.6).getHexString()}`);
    g.fillStyle = gr; g.beginPath(); g.roundRect(x + 1, y, 30, 30, [2, 2, 12, 12]); g.fill();
    g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(x + 1, y + 27, 30, 3);
  }
});
const straw = (rr: () => number): THREE.CanvasTexture => tex(256, 256, (g) => {
  g.fillStyle = "#a88a55"; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1600; i++) { const x = rr() * 256, y = rr() * 256, l = 10 + rr() * 30; g.strokeStyle = `rgba(${rr() < 0.5 ? "70,52,25" : "220,196,140"},${0.25 + rr() * 0.35})`; g.lineWidth = 1 + rr() * 1.5; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rr() - 0.5) * 4, y + l); g.stroke(); }
});
/** Lime-washed plaster over mud brick: soft patches of wash, worn spots that show the brick, rain streaks from the top,
 *  ground grime at the foot; a matching relief map (bricks and patches stand out under raking light). */
function limewash(base: string, rr: () => number, ground = 0.18): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  // two or three irregular worn patches per tile (a regular field of ellipses read as polka dots)
  const N = 512, c = new THREE.Color(base), spots: [number, number, number, number][] = Array.from({ length: 2 + Math.floor(rr() * 2) }, () => [60 + rr() * (N - 120), 40 + rr() * N * 0.6, 22 + rr() * 34, 14 + rr() * 22]);
  const draw = (relief: boolean) => (g: CanvasRenderingContext2D): void => {
    g.fillStyle = relief ? "#808080" : `#${c.getHexString()}`; g.fillRect(0, 0, N, N);
    // the wash: broad soft variations (a hand-applied coat is never even)
    for (let i = 0; i < 160; i++) { const x = rr() * N, y = rr() * N, rad = 30 + rr() * 110, k = rr() < 0.5 ? 0.9 : 1.08; const gr = g.createRadialGradient(x, y, 0, x, y, rad); const cc = c.clone().multiplyScalar(k); gr.addColorStop(0, relief ? `rgba(${k > 1 ? 150 : 110},${k > 1 ? 150 : 110},${k > 1 ? 150 : 110},0.25)` : `rgba(${cc.r * 255 | 0},${cc.g * 255 | 0},${cc.b * 255 | 0},0.35)`); gr.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = gr; g.fillRect(x - rad, y - rad, 2 * rad, 2 * rad); }
    // worn patches: the wash flaked off, mud bricks and mortar show through
    for (const [x, y, w, h] of spots) {
      // an irregular outline (a flaked edge), not an ellipse
      const pts = Array.from({ length: 11 }, (_, i) => { const a = (i / 11) * 6.283, k = 0.6 + rr() * 0.55; return [x + Math.cos(a) * w * k, y + Math.sin(a) * h * k] as const; });
      const outline = (): void => { g.beginPath(); g.moveTo(pts[0]![0], pts[0]![1]); for (const [px, py] of pts.slice(1)) g.lineTo(px, py); g.closePath(); };
      g.save(); outline(); g.clip();
      g.fillStyle = relief ? "#5a5a5a" : "#a8805c"; g.fillRect(x - w, y - h, 2 * w, 2 * h);
      for (let by = y - h; by < y + h; by += 14) for (let bx = x - w - ((by / 14) % 2) * 16; bx < x + w; bx += 32) { g.fillStyle = relief ? "#909090" : `rgba(${150 + rr() * 30},${95 + rr() * 20},${60 + rr() * 15},1)`; g.fillRect(bx + 1, by + 1, 30, 12); }
      g.restore();
      g.strokeStyle = relief ? "#a0a0a0" : "rgba(255,250,235,0.45)"; g.lineWidth = 1.5; outline(); g.stroke();
    }
    // rain streaks from the top, grime at the foot, a few hairline cracks
    if (!relief) {
      // a few faint rain streaks (many of them, repeated over a wall, read as wood planks)
      for (let i = 0; i < 6; i++) { const x = rr() * N, l = 60 + rr() * 140; const gr = g.createLinearGradient(0, 0, 0, l); gr.addColorStop(0, "rgba(60,48,36,0.12)"); gr.addColorStop(1, "rgba(60,48,36,0)"); g.fillStyle = gr; g.fillRect(x, 0, 2 + rr() * 5, l); }
      const gd = g.createLinearGradient(0, N * (1 - ground), 0, N); gd.addColorStop(0, "rgba(90,62,40,0)"); gd.addColorStop(1, "rgba(90,62,40,0.55)"); g.fillStyle = gd; g.fillRect(0, N * (1 - ground), N, N * ground);
      g.strokeStyle = "rgba(60,40,25,0.35)"; g.lineWidth = 1;
      for (let i = 0; i < 10; i++) { g.beginPath(); let x = rr() * N, y = rr() * N; g.moveTo(x, y); for (let k = 0; k < 5; k++) { x += (rr() - 0.5) * 30; y += rr() * 25; g.lineTo(x, y); } g.stroke(); }
    }
  };
  return { map: tex(N, N, draw(false)), bump: tex(N, N, draw(true), false) };
}
/** A box whose UVs are in metres / `tile` (a texture repeats at the same physical size on a gatepost and on a 9 m
 *  wall; BoxGeometry's per-face 0..1 UVs squeezed plaster into stripes on narrow faces). */
function wbox(w: number, h: number, d: number, m: THREE.Material, tile = 2.5): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv!;
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]; // +x -x +y -y +z -z
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * dims[f]![0] / tile, uv.getY(i) * dims[f]![1] / tile); }
  return new THREE.Mesh(g, m);
}
const steel = (): THREE.MeshStandardMaterial => std({ color: "#b9bec4", metalness: 0.85, roughness: 0.32 });
const painted = (c: string): THREE.MeshStandardMaterial => std({ color: c, metalness: 0.35, roughness: 0.55 });

/** A steel bucket (open, with a rolled rim and a bail handle) and its water disc; returns a setter for the level 0..1. */
function bucket(parent: THREE.Object3D, x: number, z: number, rot = 0): { setLevel(f: number): void; group: THREE.Group; waterY(f: number): number; ripple(t: number, flow: number, at: THREE.Vector3 | null): void } {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; parent.add(g);
  const prof = [new THREE.Vector2(0.0, 0.0), new THREE.Vector2(0.12, 0.0), new THREE.Vector2(0.125, 0.01), new THREE.Vector2(0.16, 0.3), new THREE.Vector2(0.172, 0.31), new THREE.Vector2(0.166, 0.318)];
  const shell = new THREE.Mesh(new THREE.LatheGeometry(prof, 28), new THREE.MeshStandardMaterial({ color: "#c2c7cc", metalness: 0.85, roughness: 0.3, side: THREE.DoubleSide }));
  shell.castShadow = true; shell.receiveShadow = true; g.add(shell);
  for (let k = 0; k < 3; k++) { const rib = new THREE.Mesh(new THREE.TorusGeometry(0.13 + k * 0.012, 0.004, 4, 28), steel()); rib.rotation.x = Math.PI / 2; rib.position.y = 0.08 + k * 0.08; g.add(rib); }
  const bail = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.006, 4, 24, Math.PI), steel()); bail.rotation.y = 0.4; bail.position.y = 0.31; g.add(bail);
  // the water reads against the bright steel: dark and clear in the middle (depth), a light rim where it meets the wall,
  // and rings spreading from where the stream lands (uniforms set from t: no state)
  const wmat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uT: { value: 0 }, uFlow: { value: 0 }, uHit: { value: new THREE.Vector2(0, 0) }, uDeep: { value: new THREE.Color("#23434a") }, uRim: { value: new THREE.Color("#a9c8cc") } },
    vertexShader: "varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform float uT; uniform float uFlow; uniform vec2 uHit; uniform vec3 uDeep; uniform vec3 uRim; varying vec2 vP;
      void main(){
        float r = length(vP);
        float rim = smoothstep(0.78, 1.0, r);
        float d = length(vP - uHit);
        float rings = uFlow * 0.5 * (0.5 + 0.5 * sin(d * 34.0 - uT * 16.0)) * smoothstep(0.75, 0.0, d);
        float foam = uFlow * smoothstep(0.16, 0.0, d);
        vec3 col = mix(uDeep, uRim, rim * 0.7 + rings * 0.6 + foam * 0.9);
        gl_FragColor = vec4(col, 0.92);
      }`,
  });
  const water = new THREE.Mesh(new THREE.CircleGeometry(1, 36), wmat);
  water.rotation.x = -Math.PI / 2; g.add(water);
  const waterY = (f: number): number => 0.012 + 0.29 * f;
  const setLevel = (f: number): void => { water.visible = f > 0.01; const y = waterY(f); water.position.y = y; const rad = 0.122 + (0.158 - 0.122) * (y / 0.3); water.scale.set(rad, rad, 1); };
  setLevel(0);
  const ripple = (t: number, flow: number, at: THREE.Vector3 | null): void => {
    wmat.uniforms.uT!.value = t; wmat.uniforms.uFlow!.value = Math.min(1, flow / 0.08);
    // the impact point in the water disc's own coordinates (the disc is scaled to the bucket radius at this level)
    if (at) { const lp = water.worldToLocal(at.clone()); wmat.uniforms.uHit!.value.set(lp.x, lp.y); }
  };
  return { setLevel, group: g, waterY, ripple };
}

/** A falling stream (a tapered tube with scrolling streaks) from `top` to `bottom`, thickness by flow; and its splash. */
function stream(parent: THREE.Object3D, day: boolean): { set(top: THREE.Vector3, bottom: THREE.Vector3, flow: number, t: number): void } {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uT: { value: 0 }, uA: { value: 1 }, uC: { value: new THREE.Color(day ? "#dfeef2" : "#9fb4c0") } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform float uT; uniform float uA; uniform vec3 uC; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      void main(){ float s = vn(vec2(vUv.x * 9.0, vUv.y * 6.0 + uT * 9.0)); float edge = 0.55 + 0.45 * sin(vUv.x * 3.14159);
        gl_FragColor = vec4(uC * (0.85 + 0.35 * s), uA * (0.55 + 0.4 * s) * edge); }`,
  });
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.8, 1, 10, 1, true), mat); tube.renderOrder = 3; parent.add(tube);
  const drops = Array.from({ length: 14 }, () => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.008, 6, 4), new THREE.MeshStandardMaterial({ color: "#e9f3f6", roughness: 0.1, transparent: true, opacity: 0.8 })); parent.add(m); return m; });
  const hash = (a: number, b: number): number => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  return {
    set(top, bottom, flow, t) {
      const on = flow > 0.01; tube.visible = on;
      const len = Math.max(0.01, top.y - bottom.y), r = 0.006 + 0.022 * Math.sqrt(Math.min(1, flow / 0.5));
      tube.position.set(top.x, (top.y + bottom.y) / 2, top.z); tube.scale.set(r, len, r);
      mat.uniforms.uT!.value = t; mat.uniforms.uA!.value = Math.min(1, flow / 0.08);
      // splash: droplets thrown from the impact point, each on a short arc (a pure function of t and its index)
      drops.forEach((d, k) => {
        const period = 0.32, ph = ((t + k * 0.0229) % period) / period, ang = hash(k, Math.floor((t + k * 0.0229) / period)) * 6.283;
        const sp = 0.25 + 0.35 * hash(k + 7, 3), up = 0.6 + 0.5 * hash(k + 3, 9);
        d.visible = on && flow > 0.05;
        d.position.set(bottom.x + Math.cos(ang) * sp * ph * 0.35, bottom.y + up * ph * 0.35 - 2.2 * (ph * 0.35) ** 2 * 4, bottom.z + Math.sin(ang) * sp * ph * 0.35);
        if (d.position.y < bottom.y - 0.005) d.visible = false;
      });
    },
  };
}

export function villageLane(ctx: KitCtx, interactions?: InteractionSpec3D): { clamp: Clamp; pre: ((t: number) => void)[] } {
  const { DX, DZ, r, day, wet, add, spec } = ctx;
  const rr = mulberry(1907);
  const pre: ((t: number) => void)[] = [];
  const pal = spec.palette ?? {};
  const wall = pal.wall ?? "#d9b88a", doorC = pal.door ?? "#2f5d8a", trim = pal.trim ?? "#f1e7d2";
  // ---- ground: packed earth, a lighter worn path along the lane, a stone drain on the house side, grass verges
  const dirtTex = dirt(r, wet); dirtTex.repeat.set(12, 12);
  const gm = ctx.ground.material as THREE.MeshStandardMaterial; gm.map = dirtTex; gm.color.set(day ? "#f0e6d6" : "#a9a096"); gm.roughnessMap = null; gm.needsUpdate = true;
  const path = tex(512, 128, (g) => { const gr = g.createLinearGradient(0, 0, 0, 128); gr.addColorStop(0, "rgba(232,214,182,0)"); gr.addColorStop(0.3, "rgba(232,214,182,0.55)"); gr.addColorStop(0.7, "rgba(232,214,182,0.55)"); gr.addColorStop(1, "rgba(232,214,182,0)"); g.fillStyle = gr; g.fillRect(0, 0, 512, 128); for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(120,96,70,${rr() * 0.12})`; g.fillRect(rr() * 512, 20 + rr() * 88, 2 + rr() * 5, 2); } });
  path.repeat.set(6, 1);
  const pathMesh = new THREE.Mesh(new THREE.PlaneGeometry(90, 4.5), std({ map: path, transparent: true, roughness: 1, depthWrite: false })); pathMesh.rotation.x = -Math.PI / 2; pathMesh.position.set(0, 0.006, 3.2); add(pathMesh, false);
  const stoneM = std({ color: "#8d867a", roughness: 0.95 });
  const drainZ = DZ + 4.6;
  add(box(60, 0.08, 0.12, stoneM), false).position.set(0, 0.04, drainZ - 0.22); add(box(60, 0.08, 0.12, stoneM), false).position.set(0, 0.04, drainZ + 0.22);
  add(box(60, 0.01, 0.32, std({ color: wet > 0.3 ? "#3d4a4c" : "#5e5648", roughness: 0.5 })), false).position.set(0, 0.005, drainZ);
  // pebbles along the lane edges (instanced, flattened), and darker damp ground where water is used
  {
    const peb = new THREE.IcosahedronGeometry(1, 0); peb.scale(1, 0.45, 0.8);
    const im = new THREE.InstancedMesh(peb, std({ color: "#a89272", roughness: 0.95, flatShading: true }), 500), m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
    let k = 0;
    for (let i = 0; i < 6000 && k < 500; i++) {
      const x = -24 + rr() * 48, z = DZ + 0.9 + rr() * 15;
      const edge = Math.abs(z - 3.2) > 2.0; // off the worn path
      if (!edge || (x > -3.6 && x < 1.6 && z > 1.4 && z < 4.2)) continue; // keep the stage clean
      const rad = 0.012 + rr() ** 4 * 0.05;
      m.compose(p.set(x, rad * 0.25, z), q.setFromEuler(e.set(0, rr() * 6.28, 0)), sc.setScalar(rad)); im.setMatrixAt(k, m); im.setColorAt(k, col.setScalar(0.85 + rr() * 0.25)); k++;
    }
    im.count = k; im.receiveShadow = true; add(im, false);
    const damp = tex(256, 256, (g) => { const gr = g.createRadialGradient(128, 128, 10, 128, 128, 126); gr.addColorStop(0, "rgba(70,52,36,0.55)"); gr.addColorStop(0.7, "rgba(70,52,36,0.25)"); gr.addColorStop(1, "rgba(70,52,36,0)"); g.fillStyle = gr; g.fillRect(0, 0, 256, 256); });
    for (const [x, z, w, d] of [[4.6 + 1.2, DZ + 5.6, 3.2, 2.4], [DX - 7.0, DZ + 4.9, 2.0, 1.4]] as const) { const dm = new THREE.Mesh(new THREE.PlaneGeometry(w, d), std({ map: damp, transparent: true, depthWrite: false, roughness: 0.6 })); dm.rotation.x = -Math.PI / 2; dm.position.set(x, 0.007, z); add(dm, false); }
    const leaf = new THREE.PlaneGeometry(0.06, 0.03);
    const lv = new THREE.InstancedMesh(leaf, std({ color: "#8a7a3a", roughness: 1, side: THREE.DoubleSide }), 300);
    let j = 0;
    for (let i = 0; i < 300; i++) { const a = rr() * 6.28, rd = Math.sqrt(rr()) * 3.2, x = DX + 6.6 + Math.cos(a) * rd, z = DZ - 1.2 + Math.sin(a) * rd; if (z < DZ + 0.6) continue; m.compose(p.set(x, 0.01, z), q.setFromEuler(e.set(-Math.PI / 2, 0, rr() * 6.28)), sc.setScalar(1)); lv.setMatrixAt(j, m); lv.setColorAt(j, col.setRGB(0.8 + rr() * 0.3, 0.7 + rr() * 0.3, 0.5 + rr() * 0.3)); j++; }
    lv.count = j; add(lv, false);
  }
  // grass verges (instanced tufts) along walls and the far edge of the lane, never on the stage or the path
  {
    const blade = new THREE.ConeGeometry(0.03, 0.28, 3); blade.translate(0, 0.14, 0);
    const im = new THREE.InstancedMesh(blade, std({ color: day ? "#6f8f3e" : "#2c3a22", roughness: 1 }), 2400), m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
    let k = 0;
    for (let i = 0; i < 9000 && k < 2400; i++) {
      const x = -26 + rr() * 52, z = DZ + 0.6 + rr() * 16;
      // along the walls, and on the far verge only at the sides (cameras stand in the middle of the lane, z 6..14)
      const nearWall = z < drainZ - 0.3 && z > DZ + 1.1 && !(x > -5 && x < 5), farEdge = z > 9.5 && Math.abs(x) > 9, house = z < DZ + 0.6;
      const courtyard = x > DX - 14.6 && x < DX - 5.1 && z < DZ + 4.2; // a swept, plastered floor: no grass
      if (!(nearWall || farEdge) || house || courtyard) continue;
      if (Math.abs(x - 4.6) < 1.4 && Math.abs(z - (DZ + 5.4)) < 1.4) continue; // the pump platform
      m.compose(p.set(x, 0, z), q.setFromEuler(e.set((rr() - 0.5) * 0.5, rr() * 6.28, (rr() - 0.5) * 0.5)), s.set(1, 0.6 + rr() * 0.9, 1));
      im.setMatrixAt(k++, m);
    }
    im.count = k; im.receiveShadow = true; add(im, false);
  }

  // ---- the main house: walls on a plinth, windows, parapet, a tiled veranda on posts
  const lw0 = limewash(wall, rr);
  const wallMat = std({ map: lw0.map, bumpMap: lw0.bump, bumpScale: 1.6, roughness: 0.95 }); for (const t of [lw0.map, lw0.bump]) t.repeat.set(1, 1);
  const hw = 9, hh = 3.5, hd = 7, dw = 1.15, dh = 2.15;
  const lw = hw / 2 + DX - dw / 2, rw = hw / 2 - DX - dw / 2;
  add(wbox(lw, hh, 0.3, wallMat)).position.set(DX - dw / 2 - lw / 2, hh / 2, DZ);
  add(wbox(rw, hh, 0.3, wallMat)).position.set(DX + dw / 2 + rw / 2, hh / 2, DZ);
  add(wbox(dw, hh - dh, 0.3, wallMat)).position.set(DX, dh + (hh - dh) / 2, DZ);
  add(wbox(hw, hh, hd, wallMat)).position.set(DX, hh / 2, DZ - hd / 2 - 0.16);
  // a painted dado band and the plinth
  add(box(hw + 0.02, 0.55, 0.31, std({ color: shade(wall, 0.72), roughness: 0.95 }))).position.set(DX, 0.27, DZ + 0.005);
  add(box(hw + 0.4, 0.22, 0.6, std({ color: "#8a8173", roughness: 1 }))).position.set(DX, 0.11, DZ + 0.42);
  add(box(1.6, 0.11, 0.4, std({ color: "#7d7466", roughness: 1 }))).position.set(DX, 0.055, DZ + 0.88);
  // parapet with a coping and pierced jali panels
  const parapet = std({ color: shade(wall, 0.9), roughness: 0.95 });
  add(box(hw + 0.2, 0.55, 0.22, parapet)).position.set(DX, hh + 0.27, DZ + 0.03);
  add(box(hw + 0.36, 0.08, 0.32, std({ color: trim, roughness: 0.8 }))).position.set(DX, hh + 0.58, DZ + 0.03);
  for (const x of [-3, -1.5, 1.5, 3]) add(box(0.7, 0.22, 0.24, std({ color: "#3a2f26", roughness: 1 }))).position.set(DX + x, hh + 0.3, DZ + 0.04);
  // windows: a moulded frame, iron bars, two wooden shutters half open, a sill
  const wood = std({ color: shade(doorC, 0.95), roughness: 0.75 }), frameM = std({ color: trim, roughness: 0.7 }), iron = std({ color: "#2c2c2c", metalness: 0.7, roughness: 0.45 });
  for (const x of [DX - 2.9, DX + 2.9]) {
    add(box(1.2, 1.25, 0.08, frameM)).position.set(x, 1.75, DZ + 0.17);
    add(box(1.0, 1.05, 0.06, std({ color: "#17130f", roughness: 0.9 }))).position.set(x, 1.75, DZ + 0.2);
    for (let k = -2; k <= 2; k++) add(box(0.025, 1.05, 0.025, iron)).position.set(x + k * 0.19, 1.75, DZ + 0.24);
    add(box(1.4, 0.08, 0.22, frameM)).position.set(x, 1.12, DZ + 0.24);
    for (const sx of [-1, 1]) { const sh = add(box(0.5, 1.05, 0.05, wood)); sh.position.set(x + sx * 0.8, 1.75, DZ + 0.36); sh.rotation.y = sx * 0.9; }
    // a potted plant on the sill
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.07, 0.16, 12), std({ color: "#a5583a", roughness: 0.8 })); pot.position.set(x + 0.35, 1.24, DZ + 0.28); add(pot);
    const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14, 1), std({ color: "#4c7a35", roughness: 0.9, flatShading: true })); leaves.position.set(x + 0.35, 1.4, DZ + 0.28); add(leaves);
  }
  // corner pilasters (a thicker plastered corner, slightly proud) and a cornice band under the parapet
  const pil = std({ map: lw0.map, bumpMap: lw0.bump, bumpScale: 1.6, color: shade("#ffffff", 0.96), roughness: 0.95 });
  for (const sx of [-1, 1]) add(wbox(0.45, hh + 0.05, 0.42, pil)).position.set(DX + sx * (hw / 2 - 0.1), (hh + 0.05) / 2, DZ + 0.02);
  add(box(hw + 0.3, 0.12, 0.4, std({ color: shade(trim, 0.92), roughness: 0.85 }))).position.set(DX, hh - 0.04, DZ + 0.05);
  // a door surround: thick jambs, a raised threshold, two steps up from the lane
  for (const sx of [-1, 1]) add(box(0.16, dh + 0.1, 0.36, frameM)).position.set(DX + sx * (dw / 2 + 0.08), (dh + 0.1) / 2, DZ + 0.06);
  add(box(dw + 0.36, 0.06, 0.4, std({ color: "#6d665c", roughness: 0.9 }))).position.set(DX, 0.25, DZ + 0.2);
  add(box(1.9, 0.12, 0.36, std({ color: "#7a7266", roughness: 1 }))).position.set(DX, 0.06, DZ + 1.05);
  // window sunshades (chhajja) on two brackets
  for (const x of [DX - 2.9, DX + 2.9]) {
    add(box(1.55, 0.06, 0.48, std({ color: shade(trim, 0.9), roughness: 0.85 }))).position.set(x, 2.48, DZ + 0.39);
    for (const sx of [-0.6, 0.6]) { const br = add(box(0.06, 0.24, 0.3, std({ color: shade(trim, 0.85), roughness: 0.85 }))); br.position.set(x + sx, 2.33, DZ + 0.3); br.rotation.x = 0.5; }
  }
  // the veranda: a lean-to of clay tiles on four wooden posts with brackets, over the door and the plinth
  const tileMat = std({ map: clayTiles(rr, "#a4553a"), roughness: 0.8 }); (tileMat.map as THREE.Texture).repeat.set(6, 1.2);
  const vd = 1.9, vy0 = 2.75, vy1 = 2.35;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(hw - 1.2, 0.07, vd + 0.3), tileMat); roof.position.set(DX, (vy0 + vy1) / 2, DZ + vd / 2 + 0.05); roof.rotation.x = Math.atan2(vy0 - vy1, vd); add(roof);
  add(box(hw - 1.1, 0.12, 0.12, wood)).position.set(DX, vy1 - 0.06, DZ + vd);
  for (const x of [-3.6, -1.4, 1.4, 3.6]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, vy1 - 0.06, 10), wood); post.position.set(DX + x, (vy1 - 0.06) / 2, DZ + vd); add(post);
    add(box(0.3, 0.06, 0.12, wood)).position.set(DX + x, vy1 - 0.2, DZ + vd - 0.1);
    add(box(0.22, 0.12, 0.22, std({ color: "#6f6658", roughness: 1 }))).position.set(DX + x, 0.06, DZ + vd);
  }
  {
    const cot2 = new THREE.Group(); cot2.position.set(DX - 2.6, 0, DZ + 1.2); cot2.rotation.y = Math.PI / 2 + 0.05;
    const fr = std({ color: "#5d3f24", roughness: 0.8 });
    for (const [x, z] of [[-0.85, -0.4], [0.85, -0.4], [-0.85, 0.4], [0.85, 0.4]] as const) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.035, 0.42, 8), fr); leg.position.set(x, 0.21, z); cot2.add(leg); }
    const weave2 = tex(256, 128, (g) => { g.fillStyle = "#c7ab7a"; g.fillRect(0, 0, 256, 128); g.strokeStyle = "#7d6038"; g.lineWidth = 2; for (let i = -128; i < 384; i += 9) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i - 64, 128); g.stroke(); g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64, 128); g.stroke(); } });
    for (const z of [-0.43, 0.43]) { const rl = box(1.8, 0.06, 0.06, fr); rl.position.set(0, 0.42, z); cot2.add(rl); }
    const bed2 = box(1.68, 0.035, 0.8, std({ map: weave2, roughness: 1 })); bed2.position.y = 0.43; cot2.add(bed2);
    const blanket = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.7, 2, 1, 2), std({ map: tex(64, 64, (g) => { g.fillStyle = "#8a2b2b"; g.fillRect(0, 0, 64, 64); g.fillStyle = "#d8a23a"; for (let i = 0; i < 64; i += 16) g.fillRect(0, i, 64, 4); }), roughness: 1 })); blanket.position.set(0.55, 0.49, 0); cot2.add(blanket);
    add(cot2);
    const stand = new THREE.Group(); stand.position.set(DX + 1.35, 0.25, DZ + 0.45);
    for (const a of [0, 2.09, 4.19]) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.5, 6), iron); l.position.set(Math.cos(a) * 0.14, 0.25, Math.sin(a) * 0.14); l.rotation.set(Math.sin(a) * 0.2, 0, -Math.cos(a) * 0.2); stand.add(l); }
    const prof = [0, 0.13, 0.21, 0.24, 0.22, 0.14, 0.08, 0.1].map((w, i) => new THREE.Vector2(w, i * 0.055));
    const pot2 = new THREE.Mesh(new THREE.LatheGeometry(prof, 20), std({ color: "#9c4f33", roughness: 0.7 })); pot2.position.y = 0.48; stand.add(pot2);
    add(stand);
    const broom = new THREE.Group(); broom.position.set(DX + 4.0, 0.25, DZ + 0.3); broom.rotation.z = -0.18;
    const bh = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.7, 10, 1, true), std({ color: "#b39463", roughness: 1, side: THREE.DoubleSide })); bh.position.y = 0.45; broom.add(bh);
    const tie = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 8), std({ color: "#7a2a1a", roughness: 0.8 })); tie.position.y = 0.82; broom.add(tie);
    add(broom);
    const lantern = new THREE.Group(); lantern.position.set(DX - 1.0, 2.0, DZ + 1.6);
    lantern.add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.22, 10), std({ color: "#cfd6dc", roughness: 0.1, transparent: true, opacity: 0.6 })));
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.08, 10), std({ color: "#5a4a2a", metalness: 0.6, roughness: 0.5 })); cap.position.y = 0.15; lantern.add(cap);
    const base2 = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 10), cap.material); base2.position.y = -0.13; lantern.add(base2);
    const hook = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.3, 4), iron); hook.position.y = 0.33; lantern.add(hook);
    add(lantern);
    if (!day) practical(ctx, lantern.position.clone(), "#ffb860", 10, 6, 0.04, 0.15);
  }
  // nameplate, bell, the working door
  const nameplate = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.28), std({ map: sign("घर 7", "#f2e6c8", "#7a2a1a"), roughness: 0.7 })); nameplate.position.set(DX + dw / 2 + 0.75, 2.05, DZ + 0.16); ctx.group.add(nameplate);
  ctx.mark("address", nameplate.position.clone());
  const bell = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.03), std({ color: "#d8d2c0", roughness: 0.6 })); bell.position.set(DX + dw / 2 + 0.2, 1.35, DZ + 0.16); ctx.group.add(bell);
  ctx.mark("doorbell", bell.position.clone());
  ctx.doorway({ dw, dh, leafColor: doorC, frameColor: trim, glow: "#ffcf8a", cold: "#ffe2b0", inside: "#6a5642" });
  add(box(dw + 0.5, 0.14, 0.1, frameM)).position.set(DX, dh + 0.18, DZ + 0.2); // lintel
  if (!day) practical(ctx, new THREE.Vector3(DX, dh + 0.42, DZ + 0.4), "#ffc87a", 22, 9, 0.06);

  // ---- the courtyard to the left: boundary wall with coping and a gate, the things of a working aangan
  const lw1 = limewash(shade(wall, 0.95), rr, 0.4); const cwM = std({ map: lw1.map, bumpMap: lw1.bump, bumpScale: 1.4, roughness: 0.95 }); for (const t of [lw1.map, lw1.bump]) t.repeat.set(1, 1);
  // a low boundary wall (1.0 m): the courtyard's life reads from the lane over it
  const cz = DZ + 4.0, cx0 = DX - 14.5, cx1 = DX - 5.2, gate0 = DX - 9.2, gate1 = DX - 8.0, ch = 1.0;
  const wallSeg = (x0: number, x1: number, z: number): void => { add(wbox(x1 - x0, ch, 0.28, cwM)).position.set((x0 + x1) / 2, ch / 2, z); add(box(x1 - x0 + 0.1, 0.08, 0.36, std({ color: trim, roughness: 0.85 }))).position.set((x0 + x1) / 2, ch + 0.04, z); };
  wallSeg(cx0, gate0, cz); wallSeg(gate1, cx1, cz);
  add(wbox(0.28, ch, cz - DZ, cwM)).position.set(cx0, ch / 2, (cz + DZ) / 2);
  // the courtyard's back is the side wall of a store room (a plastered, flat-roofed outbuilding): not open dirt
  const store = std({ map: lw1.map, bumpMap: lw1.bump, bumpScale: 1.4, roughness: 0.95 });
  add(wbox(cx1 - cx0 + 0.3, 2.6, 2.6, store)).position.set((cx0 + cx1) / 2, 1.3, DZ - 1.3);
  add(box(cx1 - cx0 + 0.5, 0.1, 2.8, std({ color: shade(trim, 0.9), roughness: 0.85 }))).position.set((cx0 + cx1) / 2, 2.65, DZ - 1.3);
  add(box(0.9, 1.85, 0.08, std({ color: "#5a3a24", roughness: 0.8 }))).position.set((cx0 + cx1) / 2 + 1.5, 0.93, DZ + 0.01);
  for (const x of [(cx0 + cx1) / 2 - 2.2, (cx0 + cx1) / 2 + 3.4]) add(box(0.6, 0.5, 0.06, std({ color: "#17130f", roughness: 0.9 }))).position.set(x, 1.8, DZ + 0.01);
  for (const x of [gate0 - 0.15, gate1 + 0.15]) { add(wbox(0.36, ch + 0.5, 0.4, cwM)).position.set(x, (ch + 0.5) / 2, cz); const cap = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), std({ color: trim, roughness: 0.8 })); cap.position.set(x, ch + 0.5, cz); add(cap); }
  const floor = tex(256, 256, (g) => { g.fillStyle = "#b4936c"; g.fillRect(0, 0, 256, 256); for (let i = 0; i < 40; i++) { g.strokeStyle = `rgba(120,90,60,${0.08 + rr() * 0.1})`; g.lineWidth = 6 + rr() * 10; g.beginPath(); g.arc(rr() * 256, rr() * 256, 20 + rr() * 60, rr() * 6, rr() * 6 + 1.5); g.stroke(); } });
  floor.repeat.set(3, 1.5);
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(cx1 - cx0, cz - DZ - 0.2), std({ map: floor, roughness: 0.85 })); fl.rotation.x = -Math.PI / 2; fl.position.set((cx0 + cx1) / 2, 0.008, (cz + DZ) / 2); add(fl, false);
  // inside: a charpai, a clay chulha, matkas, a tulsi planter, buckets, a clothes line
  const cot = new THREE.Group(); cot.position.set(DX - 8.7, 0, DZ + 1.7); cot.rotation.y = 0.12;
  const frame = std({ color: "#6b4a2b", roughness: 0.8 });
  for (const [x, z] of [[-0.95, -0.45], [0.95, -0.45], [-0.95, 0.45], [0.95, 0.45]] as const) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.035, 0.45, 8), frame); leg.position.set(x, 0.22, z); cot.add(leg); }
  for (const z of [-0.47, 0.47]) { const rail = box(2.0, 0.07, 0.07, frame); rail.position.set(0, 0.45, z); cot.add(rail); }
  for (const x of [-0.97, 0.97]) { const rail = box(0.07, 0.07, 1.0, frame); rail.position.set(x, 0.45, 0); cot.add(rail); }
  const weave = tex(256, 128, (g) => { g.fillStyle = "#cbb48a"; g.fillRect(0, 0, 256, 128); g.strokeStyle = "#8a6f45"; g.lineWidth = 2; for (let i = -128; i < 384; i += 9) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i - 64, 128); g.stroke(); g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64, 128); g.stroke(); } });
  const bed = box(1.86, 0.04, 0.88, std({ map: weave, roughness: 1 })); bed.position.y = 0.46; cot.add(bed);
  add(cot);
  const clay = std({ color: "#a5583a", roughness: 0.7 });
  const matka = (x: number, z: number, s2 = 1): void => { const prof = [0, 0.12, 0.2, 0.23, 0.21, 0.13, 0.09, 0.1].map((w, i) => new THREE.Vector2(w * s2, i * 0.055 * s2)); const m = new THREE.Mesh(new THREE.LatheGeometry(prof, 20), clay); m.position.set(x, 0, z); add(m); };
  matka(DX - 6.3, DZ + 0.55); matka(DX - 5.9, DZ + 0.75, 0.85); matka(DX - 6.7, DZ + 0.7, 0.8);
  const chulha = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.12, 8, 16, Math.PI * 1.6), std({ color: "#9a6a48", roughness: 1 })); chulha.rotation.x = -Math.PI / 2; chulha.position.set(DX - 13.4, 0.12, DZ + 1.2); add(chulha);
  const tulsi = new THREE.Group(); tulsi.position.set(DX - 11.6, 0, DZ + 2.6);
  const tb = box(0.6, 0.75, 0.6, std({ map: plaster("#e8dcc4", r), roughness: 0.9 })); tb.position.y = 0.375; tulsi.add(tb);
  const tc = box(0.7, 0.08, 0.7, std({ color: "#b5543a", roughness: 0.8 })); tc.position.y = 0.79; tulsi.add(tc);
  for (let k = 0; k < 9; k++) { const l = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1 + rr() * 0.05, 0), std({ color: "#3f6b2e", roughness: 0.9, flatShading: true })); l.position.set((rr() - 0.5) * 0.3, 0.95 + rr() * 0.35, (rr() - 0.5) * 0.3); tulsi.add(l); }
  add(tulsi);
  const lineM = std({ color: "#ddd", roughness: 0.6 });
  add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(DX - 14.3, 2.0, DZ + 2.6), new THREE.Vector3(DX - 11.5, 1.8, DZ + 2.6), new THREE.Vector3(DX - 9.4, 2.0, DZ + 2.6)]), 20, 0.008, 4), lineM), false);
  ["#c0392b", "#e1b12c", "#2980b9", "#f5f0e6", "#8e44ad"].forEach((c, i) => { const cl = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.65), std({ color: c, roughness: 0.9, side: THREE.DoubleSide })); cl.position.set(DX - 13.7 + i * 0.95, 1.5 - 0.15 * Math.sin((i / 4) * Math.PI), DZ + 2.6); add(cl, false); const w = ctx.spec.weather?.wind ?? 0.4, ph = i * 1.3; ctx.updates.push((t) => { cl.rotation.x = Math.sin(t * 1.4 + ph) * 0.12 * w; }); });
  bucket(ctx.group, DX - 7.0, DZ + 1.6, 0.4).setLevel(0.55);

  // ---- neighbours: a house with a double-pitched tile roof (and a bench), a thatched hut
  const nbWall = std({ map: plaster("#e3d2b0", r), roughness: 0.95 });
  {
    const x = DX + 9.6, w = 6.4, d = 6, h2 = 3.0, z0 = DZ - 0.5;
    add(wbox(w, h2, d, nbWall)).position.set(x, h2 / 2, z0 - d / 2);
    add(box(w + 0.02, 0.45, d + 0.02, std({ color: "#9a8f80", roughness: 1 }))).position.set(x, 0.22, z0 - d / 2);
    const rise = 1.5, half = d / 2 + 0.5, slope = Math.hypot(rise, half), ang = Math.atan2(rise, half);
    const tm = std({ map: clayTiles(rr, "#9e4a32"), roughness: 0.82 }); (tm.map as THREE.Texture).repeat.set(5, 3);
    for (const sd of [-1, 1]) { const pl = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 0.08, slope), tm); pl.position.set(x, h2 + rise / 2, z0 - d / 2 + sd * half / 2); pl.rotation.x = sd * ang; add(pl); }
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, w + 0.75, 8).rotateZ(Math.PI / 2), std({ color: "#7d3a28", roughness: 0.8 }))).position.set(x, h2 + rise + 0.02, z0 - d / 2);
    const gable = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, rise)]);
    for (const sx of [-1, 1]) { const gm2 = new THREE.Mesh(new THREE.ShapeGeometry(gable), nbWall); gm2.rotation.y = Math.PI / 2; gm2.position.set(x + sx * (w / 2 + 0.001), h2, z0 - d / 2); add(gm2); }
    add(box(1.0, 2.0, 0.08, std({ color: "#5a3a2a", roughness: 0.8 }))).position.set(x - 1.2, 1.0, z0 + 0.01);
    add(box(1.0, 1.0, 0.06, std({ color: "#17130f", roughness: 0.9 }))).position.set(x + 1.6, 1.7, z0 + 0.01);
    for (let k = -2; k <= 2; k++) add(box(0.025, 1.0, 0.025, iron)).position.set(x + 1.6 + k * 0.19, 1.7, z0 + 0.05);
    const bench = new THREE.Group(); bench.position.set(x - 0.2, 0, z0 + 0.7);
    const seat = box(1.7, 0.07, 0.4, wood); seat.position.y = 0.45; bench.add(seat);
    for (const bx of [-0.75, 0.75]) for (const bz of [-0.15, 0.15]) { const l = box(0.06, 0.45, 0.06, wood); l.position.set(bx, 0.22, bz); bench.add(l); }
    add(bench);
  }
  {
    const x = DX + 17.5, z0 = DZ - 1.5, rad = 2.6;
    add(new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, 2.3, 18), std({ map: plaster("#c9a77a", r), roughness: 1 }))).position.set(x, 1.15, z0 - rad);
    const th = std({ map: straw(rr), roughness: 1 }); (th.map as THREE.Texture).repeat.set(4, 2);
    const cone = new THREE.ConeGeometry(rad + 0.8, 2.4, 22, 4, true), cp = cone.attributes.position!;
    for (let i = 0; i < cp.count; i++) { const y = cp.getY(i); const k = 1 + 0.05 * Math.sin(i * 1.7) * (y < 0 ? 1 : 0.3); cp.setX(i, cp.getX(i) * k); cp.setZ(i, cp.getZ(i) * k); }
    cone.computeVertexNormals();
    const roofM = new THREE.Mesh(cone, th); roofM.position.set(x, 2.3 + 1.0, z0 - rad); add(roofM);
    add(box(0.9, 1.8, 0.1, std({ color: "#4a3a2a", roughness: 0.9 }))).position.set(x - 0.6, 0.9, z0 + 0.02);
  }
  // ---- trees: a neem by the pump, banana plants by the courtyard, shrubs
  const neem = (x: number, z: number, s2: number): void => {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.scale.setScalar(s2);
    const bark = std({ color: "#5b4632", roughness: 0.95 });
    const trunkCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.15, 1.5, 0.05), new THREE.Vector3(-0.1, 3.0, 0)]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(trunkCurve, 12, 0.25, 10), bark));
    for (const [a, l] of [[0.6, 1.6], [2.4, 1.4], [4.2, 1.7]] as const) g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-0.1, 2.8, 0), new THREE.Vector3(Math.cos(a) * l * 0.6, 3.6, Math.sin(a) * l * 0.6), new THREE.Vector3(Math.cos(a) * l, 4.3, Math.sin(a) * l)]), 8, 0.09, 6), bark));
    const crown = new THREE.Group(); crown.position.y = 4.4; g.add(crown);
    const leaf = std({ color: "#4a7a34", roughness: 0.9, flatShading: true });
    const blobs: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 14; i++) { const b = new THREE.IcosahedronGeometry(0.9 + rr() * 0.8, 1); const a = rr() * 6.28, rad = 0.4 + rr() * 2.0; b.scale(1, 0.75, 1); b.translate(Math.cos(a) * rad, (rr() - 0.3) * 1.3, Math.sin(a) * rad); blobs.push(b.index ? b.toNonIndexed() : b); }
    const cm = new THREE.Mesh(mergeGeometries(blobs)!, leaf); cm.castShadow = true; crown.add(cm);
    add(g);
    const w = ctx.spec.weather?.wind ?? 0.4, ph = rr() * 6;
    ctx.updates.push((t) => { crown.rotation.z = Math.sin(t * 0.7 + ph) * 0.02 * w; crown.rotation.x = Math.sin(t * 0.55 + ph) * 0.015 * w; });
  };
  neem(DX + 6.6, DZ - 1.2, 1.15); neem(DX - 19, DZ + 1, 1.3); neem(DX + 23, DZ + 3, 1.2);
  for (const [x, z] of [[DX - 4.8, DZ + 0.9], [DX - 15.6, DZ + 4.8]] as const) {
    const g = new THREE.Group(); g.position.set(x, 0, z);
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 1.8, 8), std({ color: "#7d8a4a", roughness: 0.9 }))).position.y = 0.9;
    for (let k = 0; k < 6; k++) { const lf = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 1.6), std({ color: "#5d8f3a", roughness: 0.8, side: THREE.DoubleSide })); lf.geometry.translate(0, 0.8, 0); lf.position.y = 1.6; lf.rotation.set(0.7 + rr() * 0.4, (k / 6) * 6.28, 0, "YXZ"); g.add(lf); }
    add(g);
  }
  for (let i = 0; i < 10; i++) { const s3 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35 + rr() * 0.3, 1), std({ color: shade("#4f7a35", 0.8 + rr() * 0.4), roughness: 0.9, flatShading: true })); s3.scale.y = 0.7; s3.position.set(DX + 5.4 + rr() * 2.6 * (i % 2 ? 1 : -1) + (i > 5 ? 9 : 0), 0.22, DZ + 0.6 + rr() * 0.8); add(s3); }
  // ---- fields beyond the houses, the countryside horizon
  const field = tex(512, 512, (g) => { g.fillStyle = day ? "#87a046" : "#2c3a20"; g.fillRect(0, 0, 512, 512); for (let i = 0; i < 512; i += 10) { g.fillStyle = "rgba(40,60,20,0.3)"; g.fillRect(0, i, 512, 3); } });
  field.repeat.set(20, 4);
  add(new THREE.Mesh(new THREE.BoxGeometry(160, 0.05, 26), std({ map: field, roughness: 1 })), false).position.set(0, 0.02, DZ - 22);
  farRural(ctx, -42);

  // ---- water: the hand pump on its platform, and a standpipe tap; each with a bucket that fills
  const px = DX + 4.6, pz = DZ + 5.4;
  {
    // weathered concrete (darker than the lane: it is wet and shaded around a pump), with a speckled texture
    const conc = tex(256, 256, (g) => { g.fillStyle = "#8a847a"; g.fillRect(0, 0, 256, 256); for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(${rr() < 0.5 ? "40,38,34" : "200,195,185"},${rr() * 0.18})`; g.fillRect(rr() * 256, rr() * 256, 1 + rr() * 3, 1 + rr() * 3); } });
    const plat = std({ map: conc, color: "#857f75", roughness: 0.9 });
    add(box(1.7, 0.16, 1.7, plat)).position.set(px, 0.08, pz);
    for (const [w2, d2, ox, oz] of [[1.7, 0.1, 0, -0.8], [1.7, 0.1, 0, 0.8], [0.1, 1.7, -0.8, 0], [0.1, 1.7, 0.8, 0]] as const) add(box(w2, 0.1, d2, plat)).position.set(px + ox, 0.2, pz + oz);
    add(box(0.25, 0.06, 0.6, plat)).position.set(px + 1.0, 0.1, pz + 0.3); // the drain lip
    add(box(1.5, 0.005, 1.5, std({ map: conc, color: "#6f6c66", roughness: 0.78, metalness: 0 })), false).position.set(px, 0.164, pz); // the wet floor
  }
  const pump = new THREE.Group(); pump.position.set(px - 0.35, 0.16, pz - 0.2); add(pump);
  const blue = painted("#3e6a8f"), dark = painted("#2a3a48");
  const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.06, 18), dark); flange.position.y = 0.03; pump.add(flange);
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.5, 16), blue); stand.position.y = 0.3; pump.add(stand);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.42, 20), blue); body.position.y = 0.76; pump.add(body);
  for (const y of [0.55, 0.97]) { const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.04, 20), dark); ring.position.y = y; pump.add(ring); }
  const headM = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.26), blue); headM.position.set(-0.04, 1.08, 0); pump.add(headM);
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.32, 12), blue); spout.rotation.z = Math.PI / 2 - 0.25; spout.position.set(0.24, 0.84, 0); pump.add(spout);
  const spoutTip = new THREE.Object3D(); spoutTip.position.set(0.39, 0.8, 0); pump.add(spoutTip);
  // the handle: a long bar pivoting at the back of the head; its end is the grip
  const pivot = new THREE.Group(); pivot.position.set(-0.2, 1.12, 0); pump.add(pivot);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.05, 0.05), dark); bar.position.set(-0.58, 0, 0); pivot.add(bar);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.2, 10), std({ color: "#1b1b1b", roughness: 0.6 })); grip.rotation.x = Math.PI / 2; grip.position.set(-1.12, 0, 0); pivot.add(grip);
  const gripMark = new THREE.Object3D(); gripMark.position.set(-1.12, 0.02, 0); pivot.add(gripMark);
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 8), steel()); pin.rotation.x = Math.PI / 2; pivot.add(pin);
  pump.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  pivot.rotation.z = -handleAngle(0);
  const pumpBucket = bucket(ctx.group, px + 0.04, pz - 0.2);
  pumpBucket.group.position.y = 0.16;
  const pumpStream = stream(ctx.group, day);
  // where a person stands to pump: behind the handle's grip, facing the pump
  // the grip is ~1.67 m behind the pump axis; a person stands ~0.55 m behind it, so the hand is always in front of the
  // body (standing under the grip put the IK target inside the torso and the arm flipped)
  ctx.mark("pump-stand", new THREE.Vector3(px - 0.35 - 0.2 - 1.12 - 0.45, 0, pz - 0.2 + 0.18)); // ~0.45 m behind the grip
  ctx.mark("pump-spout", new THREE.Vector3(px + 0.04, 0.96, pz - 0.2));
  // the grip moves with the handle: a named point that follows it (characters' hands are put on it by IK)
  const gripWorld = new THREE.Object3D(); ctx.group.add(gripWorld);
  ctx.markObject?.("pump-handle", gripWorld);
  const pumpSpec = interactions?.handpump;
  // the tap: a standpipe by the courtyard gate with a bucket
  const tx = DX - 7.2, tz = cz + 0.75;
  const pipeM = painted("#6f7a6a");
  const standpipe = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.9, 12), pipeM); standpipe.position.set(tx, 0.45, tz); add(standpipe);
  add(box(0.7, 0.1, 0.7, std({ color: "#a39d92", roughness: 0.9 }))).position.set(tx + 0.2, 0.05, tz);
  const brass = std({ color: "#c9a24a", metalness: 0.9, roughness: 0.3 });
  // elbow from the pipe top, a short horizontal arm, the tap body with its down-turned nozzle
  const elbow = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.035, 8, 12, Math.PI / 2), pipeM); elbow.position.set(tx + 0.06, 0.9, tz); elbow.rotation.z = Math.PI / 2; add(elbow);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.08, 12).rotateZ(Math.PI / 2), pipeM); arm.position.set(tx + 0.1, 0.96, tz); add(arm);
  const bodyT = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.11, 14).rotateZ(Math.PI / 2), brass); bodyT.position.set(tx + 0.19, 0.96, tz); add(bodyT);
  const bonnet = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.03, 0.05, 12), brass); bonnet.position.set(tx + 0.19, 1.0, tz); add(bonnet);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.08, 12), brass); nozzle.position.set(tx + 0.25, 0.93, tz); nozzle.rotation.z = -0.35; add(nozzle);
  // the handle sits ON the spindle (a crosshead that turns about the vertical axis: a quarter turn opens the tap)
  const tapHandle = new THREE.Group(); tapHandle.position.set(tx + 0.19, 1.035, tz); ctx.group.add(tapHandle);
  const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 8), brass); tapHandle.add(spindle);
  const th2 = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.016, 0.022), std({ color: "#b8231d", roughness: 0.5 })); th2.position.y = 0.017; tapHandle.add(th2);
  const tapTip = new THREE.Object3D(); tapTip.position.set(tx + 0.265, 0.89, tz); ctx.group.add(tapTip);
  const tapBucket = bucket(ctx.group, tx + 0.265, tz, 0.3); tapBucket.group.position.y = 0.1;
  const tapStream = stream(ctx.group, day);
  ctx.mark("tap", new THREE.Vector3(tx + 0.03, 0.97, tz)); ctx.mark("tap-stand", new THREE.Vector3(tx - 0.55, 0, tz + 0.35));
  const tapSpec = interactions?.tap;

  // all of it evaluated from t, before the characters (whose hands follow the grip)
  const top = new THREE.Vector3(), bottom = new THREE.Vector3();
  pre.push((t) => {
    const h = pumpSpec ? pumpHandle(pumpSpec, t) : 0;
    pivot.rotation.z = -handleAngle(h);
    pump.updateMatrixWorld(true);
    gripMark.getWorldPosition(gripWorld.position);
    const flowP = pumpSpec ? pumpFlow(pumpSpec, t) : 0;
    const lvlP = pumpSpec && pumpSpec.bucket !== false ? Math.min(BUCKET_LITRES, (pumpSpec.bucketStart ?? 0) + litres((x) => pumpFlow(pumpSpec, x), pumpSpec.from, t)) / BUCKET_LITRES : 0;
    pumpBucket.setLevel(lvlP);
    spoutTip.getWorldPosition(top); bottom.set(top.x, 0.16 + pumpBucket.waterY(lvlP), top.z);
    pumpStream.set(top, bottom, flowP, t); pumpBucket.ripple(t, flowP, bottom);
    const flowT = tapSpec ? tapFlow(tapSpec, t) : 0;
    // the crosshead turns a quarter turn as the flow comes on (and back as it stops): a pure function of the flow
    tapHandle.rotation.y = (Math.PI / 2) * Math.min(1, flowT / 0.12);
    const lvlT = tapSpec && tapSpec.bucket !== false ? Math.min(BUCKET_LITRES, (tapSpec.bucketStart ?? 0) + litres((x) => tapFlow(tapSpec, x), tapSpec.open, t)) / BUCKET_LITRES : 0;
    tapBucket.setLevel(lvlT);
    tapTip.getWorldPosition(top); bottom.set(top.x, 0.1 + tapBucket.waterY(lvlT), top.z);
    tapStream.set(top, bottom, flowT, t); tapBucket.ripple(t, flowT, bottom);
  });
  pre[0]!(0);
  return { pre, clamp: (p) => { if (p.z < DZ + 0.7) p.z = DZ + 0.7; if (p.y < 0.35) p.y = 0.35; } };
}
