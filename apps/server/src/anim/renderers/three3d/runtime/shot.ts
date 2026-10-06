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
export interface ShotRuntime { canvas: HTMLCanvasElement; frames: number; renderFrame(i: number): void; cues(): Cue3D[]; info(): Record<string, unknown>; dispose(): void }

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
  if (!renderer.domElement.parentElement) document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const rig = applyLighting(scene, spec.lighting, { area: 16 });
  renderer.toneMappingExposure = rig.exposure;
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

  const set = await buildSet(spec.environment, scene, assets.images, spec.seed, rig);
  if (spec.environment.weather?.fog !== undefined && scene.fog instanceof THREE.FogExp2) scene.fog.density = spec.environment.weather.fog;

  const chars = new Map<string, Character3D>();
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
    const c = new Character3D(cs, await loadGlb(cs.asset, b64), world);
    scene.add(c.root);
    for (const p of c.props) scene.add(p.object);
    chars.set(cs.id, c);
  }
  cam = new CinematicCamera(spec.camera, spec.width / spec.height, spec.duration, (id) => {
    const c = chars.get(id);
    if (c) return { position: c.root.position.clone(), heading: c.currentHeading, height: c.height };
    const p = set.named(id);
    return p ? { position: p.clone().setY(0), heading: 0, height: 1.8 } : null;
  }, (p) => set.clampCamera(p));
  const reactions = spec.characters.flatMap((c) => c.events.filter((e) => e.action === "react" || e.action === "surprise").map((e) => e.at));
  const frames = Math.round(spec.duration * spec.fps), dt = 1 / spec.fps;
  let last = -1;
  const setupMs = performance.now() - t0;
  let renderMs = 0;

  return {
    canvas: renderer.domElement,
    frames,
    renderFrame(i: number): void {
      if (i !== last + 1) throw new Error(`frames must be rendered in order (got ${i} after ${last})`);
      last = i;
      const s = performance.now();
      const t = i * dt, step = i === 0 ? 0 : dt;
      for (const c of chars.values()) c.update(t, step);
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
      set.update(t, step, camera.position);
      renderer.render(scene, camera);
      renderMs += performance.now() - s;
    },
    cues: () => [...[...chars.values()].flatMap((c) => c.cues), ...set.cues].sort((a, b) => a.at - b.at),
    info: () => ({
      setupMs: Math.round(setupMs), renderMs: Math.round(renderMs), triangles: renderer.info.render.triangles, drawCalls: renderer.info.render.calls,
      geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
      characters: [...chars.values()].map((c) => ({ id: c.spec.id, height: +c.height.toFixed(2), walkSpeed: +c.walkSpeed.toFixed(2), runSpeed: +c.runSpeed.toFixed(2), bones: Object.keys(c.bones).length, clips: Object.keys(c.clips), transitions: c.loco.history.map((h) => `${h.t.toFixed(2)} ${h.from}->${h.to}`) })),
    }),
    dispose(): void {
      scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []; for (const x of mats) x.dispose(); });
      envTex.dispose(); pm.dispose(); renderer.renderLists.dispose();
    },
  };
}
