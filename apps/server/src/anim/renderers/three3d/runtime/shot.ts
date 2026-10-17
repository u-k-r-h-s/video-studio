import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Cue3D, Shot3DSpec, Target } from "../spec";
import { CinematicCamera } from "./camera";
import { Character3D, type World } from "./character";
import { buildSet } from "./environment";
import { applyLighting } from "./lighting";

/**
 * One shot in the browser: renderer, lighting preset, set, characters, camera. renderFrame(i) advances everything by one
 * frame (in order) and draws it; the host reads the canvas. Cues = sounds implied by the action (footsteps, door, impacts).
 */
export interface ShotAssets { characters: Record<string, string>; images: Record<string, string> }
export interface ShotRuntime {
  canvas: HTMLCanvasElement; frames: number;
  /** Simulates frame i and draws it. Frames go in order: i = previous + 1. */
  renderFrame(i: number): void;
  /** Simulates frame i without drawing (fast-forward to the start of a chunk: the same per-frame sequence, so frame k of a
   *  chunk is identical to frame k of a full render). */
  advance(i: number): void;
  cues(): Cue3D[]; info(): Record<string, unknown>; dispose(): void;
}

const glbCache = new Map<string, Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>>();
function loadGlb(key: string, base64: string): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  let p = glbCache.get(key);
  if (!p) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    p = new GLTFLoader().parseAsync(bytes.buffer, "").then((g) => ({ scene: g.scene, animations: g.animations }));
    glbCache.set(key, p);
  }
  // every use gets its own skinned copy (two characters can share one model)
  return p.then((g) => ({ scene: cloneSkinned(g.scene), animations: g.animations }));
}

let shared: THREE.WebGLRenderer | null = null;

/** The toon style: every lit material becomes a 3-step light ramp (flat painterly bands), keeping its colour, textures,
 * skinning, blend shapes and cut-out alpha. Glows, rain, the sky and other unlit materials are left as they are. */
let ramp: THREE.DataTexture | null = null;
function toonShade(scene: THREE.Scene): void {
  if (!ramp) { ramp = new THREE.DataTexture(new Uint8Array([28, 28, 28, 255, 120, 120, 120, 255, 240, 240, 240, 255]), 3, 1, THREE.RGBAFormat); ramp.minFilter = ramp.magFilter = THREE.NearestFilter; ramp.needsUpdate = true; }
  const done = new Map<THREE.Material, THREE.Material>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const conv = (x: THREE.Material): THREE.Material => {
      const s = x as THREE.MeshStandardMaterial;
      if (!(s.isMeshStandardMaterial)) return x;
      let t = done.get(x);
      if (!t) {
        t = new THREE.MeshToonMaterial({ name: s.name, color: s.color, map: s.map, normalMap: s.normalMap, alphaMap: s.alphaMap, alphaTest: s.alphaTest, transparent: s.transparent, opacity: s.opacity, side: s.side, emissive: s.emissive, emissiveIntensity: s.emissiveIntensity, emissiveMap: s.emissiveMap, gradientMap: ramp });
        done.set(x, t);
      }
      return t;
    };
    m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
  });
}
function glRenderer(r: THREE.WebGLRenderer): string {
  const gl = r.getContext(), ext = gl.getExtension("WEBGL_debug_renderer_info");
  return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}
export async function createShot(spec: Shot3DSpec, assets: ShotAssets): Promise<ShotRuntime> {
  const t0 = performance.now();
  const renderer = shared ?? new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  shared = renderer;
  renderer.setPixelRatio(1);
  renderer.setSize(spec.width, spec.height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // draw order must not depend on material ids (they depend on what the page created before: cached character materials
  // are older on later shots), or anti-aliased edges differ between a full render and a chunk rendered in another page.
  // Group / render order / depth / object id: all created in the same order within every shot.
  renderer.setOpaqueSort((a, b) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || a.z - b.z || a.id - b.id);
  if (!renderer.domElement.parentElement) document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const rig = applyLighting(scene, spec.lighting, { area: 16, ...(spec.sunAzimuth !== undefined ? { sunAzimuth: spec.sunAzimuth } : {}) });
  renderer.toneMappingExposure = rig.exposure * (spec.style?.exposure ?? 1);
  // image-based ambient + reflections from the preset's sky (physical sky by day, gradient at night); at night a painted
  // plate (city lights) is a better reflection source for wet ground
  const pm = new THREE.PMREMGenerator(renderer);
  let envTex = pm.fromScene(rig.envScene, 0.02).texture;
  const plateUrl = spec.environment.backdrop ? assets.images[spec.environment.backdrop] : undefined;
  if (plateUrl && !rig.daylight) {
    const t = await new THREE.TextureLoader().loadAsync(plateUrl);
    t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
    envTex.dispose(); envTex = pm.fromEquirectangular(t).texture; t.dispose();
  }
  scene.environment = envTex;
  scene.environmentIntensity = rig.envIntensity;

  const set = await buildSet(spec.environment, scene, assets.images, spec.seed, rig, spec.duration);
  if (spec.environment.weather?.fog !== undefined && scene.fog instanceof THREE.FogExp2) scene.fog.density = spec.environment.weather.fog;

  const chars = new Map<string, Character3D>();
  const loadMs: Record<string, number> = {};
  let cam: CinematicCamera | null = null;
  const world: World = {
    resolve: (t: Target): THREE.Vector3 | null => {
      if (typeof t !== "string") return new THREE.Vector3(t.x, t.y ?? 0, t.z);
      if (t === "camera") return cam ? cam.camera.position.clone() : null;
      const c = chars.get(t);
      if (c) return c.headPosition();
      return set.named(t);
    },
  };
  for (const cs of spec.characters) {
    const b64 = assets.characters[cs.asset];
    if (!b64) throw new Error(`no model for character asset "${cs.asset}"`);
    const l0 = performance.now();
    const gltf = await loadGlb(cs.asset, b64);
    loadMs[cs.asset] ??= Math.round(performance.now() - l0); // parse + skinned clone (cached after the first shot)
    const c = new Character3D(cs, gltf, world);
    scene.add(c.root);
    for (const p of c.props) scene.add(p.object);
    chars.set(cs.id, c);
  }
  // background walkers on the set's pavement (the same Character3D as the cast: same locomotion, deterministic)
  const extras: Character3D[] = [];
  const peds = spec.environment.world?.pedestrians;
  if (peds && set.walkway && peds.assets.length) {
    const wk = set.walkway;
    for (let i = 0; i < peds.count; i++) {
      const asset = peds.assets[i % peds.assets.length]!;
      if (!assets.characters[asset]) continue;
      const dir = i % 2 ? 1 : -1, x = wk.x0 + (((i * 37 + spec.seed * 11) % 100) / 100) * (wk.x1 - wk.x0), z = wk.z + (dir > 0 ? 0.7 : -0.7);
      const c = new Character3D({ id: `ped${i}`, asset, start: { x, z, heading: dir > 0 ? Math.PI / 2 : -Math.PI / 2 }, events: [{ at: 0, action: "walk", target: { x: dir > 0 ? wk.x1 + 40 : wk.x0 - 40, z } }] }, await loadGlb(asset, assets.characters[asset]!), world);
      scene.add(c.root); extras.push(c);
    }
  }
  if (spec.style?.shading === "toon") toonShade(scene);
  cam = new CinematicCamera(spec.camera, spec.width / spec.height, spec.duration, (id) => {
    const c = chars.get(id);
    if (c) return { position: c.root.position.clone(), heading: c.currentHeading, height: c.height, head: c.headPosition() };
    const p = set.named(id);
    return p ? { position: p.clone().setY(0), heading: 0, height: 1.8 } : null;
  }, (p) => set.clampCamera(p));
  const faceLight = new THREE.SpotLight(rig.daylight ? "#fff4e6" : "#ffe2c4", rig.daylight ? 1.5 : spec.lighting === "power-outage" ? 3.2 : 5, 3.6, 0.32, 0.9, 2);
  faceLight.castShadow = false; scene.add(faceLight, faceLight.target);
  const reactions = spec.characters.flatMap((c) => c.events.filter((e) => e.action === "react" || e.action === "surprise").map((e) => e.at));
  const frames = Math.round(spec.duration * spec.fps), dt = 1 / spec.fps;
  let last = -1;
  // compile every material now, with the scene as it is at the start: a chunk (first drawn frame mid-shot) and a full render
  // (first drawn frame 0) then use the same shader programs
  renderer.compile(scene, cam!.camera);
  const setupMs = performance.now() - t0;
  let renderMs = 0;
  const TRACE_ROLES = ["hips", "spine", "chest", "neck", "head", "upperArmR", "upperArmL", "handR", "handL", "footL", "footR"] as const;
  const trace: Record<string, { t: number; root: number[]; heading: number; speed: number; loco: number[]; q: Record<string, number[]>; feet: number[][] }[]> = {};

  // one frame of simulation: the clock is the timeline (t = i / fps, a fixed step), every stateful system advances once
  const simulate = (i: number): THREE.PerspectiveCamera => {
    if (i !== last + 1) throw new Error(`frames must be simulated in order (got ${i} after ${last})`);
    last = i;
    const t = i * dt, step = i === 0 ? 0 : dt;
    for (const c of chars.values()) c.update(t, step);
    for (const c of extras) c.update(t, step);
    const camera = cam!.step(t, i === 0 ? 1 : dt);
    // the sun's shadow box follows the action (crisper shadows from a small map); the rim light sits behind the main
    // character as seen from the camera, so the silhouette always separates from the background
    const lead = [...chars.values()][0];
    if (lead) {
      const c0 = lead.root.position;
      rig.key.target.position.copy(c0); rig.key.position.copy(c0).addScaledVector(rig.sunDir, 40); rig.key.target.updateMatrixWorld();
      const away = c0.clone().sub(camera.position).setY(0).normalize();
      rig.rim.position.copy(c0).addScaledVector(away, 6).add(new THREE.Vector3(0, 4.5, 0)); rig.rim.target.position.copy(c0).setY(1.2); rig.rim.target.updateMatrixWorld();
    }
    for (const r of reactions) cam!.kick(t, r, 1);
    // a soft, shadowless face light from the camera side on the shot's subject: faces read at night and in dark rooms
    // (stronger at night, a touch by day), as animation lighting does
    const subject = chars.get(spec.camera.target) ?? lead;
    if (subject) {
      const head = subject.headPosition();
      faceLight.position.copy(camera.position).lerp(head, 0.35).add(new THREE.Vector3(0, 0.35, 0));
      faceLight.target.position.copy(head); faceLight.target.updateMatrixWorld();
    }
    set.update(t, step, camera.position);
    return camera;
  };

  return {
    canvas: renderer.domElement,
    frames,
    renderFrame(i: number): void {
      const s = performance.now();
      const camera = simulate(i);
      renderer.render(scene, camera);
      if (spec.trace) (trace["~camera"] ??= []).push({ t: i * dt, root: camera.position.toArray(), heading: 0, speed: 0, loco: [0, 0, 0], q: { cam: camera.quaternion.toArray() }, feet: [] });
      if (spec.trace) for (const c of [...chars.values(), ...extras]) {
        const q: Record<string, number[]> = {};
        for (const r of TRACE_ROLES) { const b = c.bones[r]; if (b) q[r] = b.getWorldQuaternion(new THREE.Quaternion()).toArray(); }
        const L = c.locomotion;
        (trace[c.spec.id] ??= []).push({ t: i * dt, root: c.root.position.toArray(), heading: c.currentHeading, speed: c.currentSpeed, loco: [L.idle, L.walk, L.run], q,
          feet: [c.bones.footL, c.bones.footR, c.bones.hips, c.bones.head].map((b) => (b ?? c.root).getWorldPosition(new THREE.Vector3()).toArray()) });
      }
      renderMs += performance.now() - s;
    },
    advance(i: number): void { simulate(i); },
    cues: () => [...[...chars.values()].flatMap((c) => c.cues), ...set.cues].sort((a, b) => a.at - b.at),
    info: () => ({
      // proof of what drew the frames: the Three.js build and the GPU behind WebGL
      engine: "three.js", three: THREE.REVISION, gl: glRenderer(renderer),
      setupMs: Math.round(setupMs), glbLoadMs: loadMs, renderMs: Math.round(renderMs), triangles: renderer.info.render.triangles, drawCalls: renderer.info.render.calls,
      geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
      ...(spec.trace ? { trace } : {}),
      world: { ...set.info, pedestrians: extras.length },
      characters: [...chars.values()].map((c) => ({ id: c.spec.id, height: +c.height.toFixed(2), walkSpeed: +c.walkSpeed.toFixed(2), runSpeed: +c.runSpeed.toFixed(2), bones: Object.keys(c.bones).length, clips: Object.keys(c.clips), face: c.face.capabilities, lipSyncFrames: c.faceStats.talkingFrames, mouthMaxOpen: +c.faceStats.maxOpen.toFixed(2), transitions: c.loco.history.map((h) => `${h.t.toFixed(2)} ${h.from}->${h.to}`) })),
    }),
    dispose(): void {
      scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []; for (const x of mats) x.dispose(); });
      envTex.dispose(); pm.dispose(); renderer.renderLists.dispose();
    },
  };
}
