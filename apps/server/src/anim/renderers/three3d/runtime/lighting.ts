import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import type { LightingPreset } from "../spec";

/**
 * Scene lighting presets. Daylight is not "night made brighter": a directional SUN at a real elevation/azimuth (shadow
 * softness from the sky: crisp on a sunny day, very soft when cloudy), a physical SKY (three.js Sky: Rayleigh/Mie scattering)
 * that also lights the scene through an environment map, a hemisphere FILL (sky above, ground bounce below) and a weak BOUNCE
 * from the sunlit ground. Night: moon key, cool fill, strong rim, fog. One shadow-casting key per preset (M1 budget).
 * Practical lights (lamps, a door spill, a torch) belong to the set and the props.
 */
export interface LightingRig {
  key: THREE.DirectionalLight; fill: THREE.HemisphereLight; bounce: THREE.DirectionalLight; rim: THREE.DirectionalLight;
  exposure: number; background: THREE.Color; fog: THREE.FogExp2;
  /** The scene that the environment map (reflections, image-based ambient) is made from. */
  envScene: THREE.Scene;
  envIntensity: number;
  /** Direction toward the sun / moon (unit). */
  sunDir: THREE.Vector3;
  /** 0 dry .. 1 soaked: the set makes its ground and props wetter (darker, smoother). */
  wetness: number;
  daylight: boolean;
  rimStrength: number;
}

interface Preset {
  daylight: boolean;
  /** Sun/moon: colour, intensity, elevation and azimuth (degrees), shadow softness (PCF radius) and map size. */
  sun: [string, number, number, number, number, number];
  sky: { kind: "physical"; turbidity: number; rayleigh: number; mie: number; mieG: number } | { kind: "gradient"; top: string; horizon: string };
  fill: [string, string, number];
  bounce: [string, number];
  rim: [string, number];
  fog: [string, number];
  exposure: number;
  env: number;
  wet: number;
}

const P: Record<Exclude<LightingPreset, "day" | "warehouse" | "street" | "rain" | "horror">, Preset> = {
  "sunny-day": { daylight: true, sun: ["#fff1da", 2.6, 46, 215, 2.5, 2048], sky: { kind: "physical", turbidity: 2.4, rayleigh: 1.1, mie: 0.004, mieG: 0.8 }, fill: ["#a9c6f0", "#6f6450", 0.42], bounce: ["#ffdcb0", 0.3], rim: ["#fff6e6", 0.5], fog: ["#c3d6ec", 0.003], exposure: 0.68, env: 0.32, wet: 0 },
  "cloudy-day": { daylight: true, sun: ["#f2f4f8", 1.2, 55, 200, 14, 1024], sky: { kind: "gradient", top: "#8fa3ba", horizon: "#d4dbe4" }, fill: ["#c6d2e0", "#5f5a52", 0.9], bounce: ["#e8e4dc", 0.2], rim: ["#ffffff", 0.3], fog: ["#c3ccd6", 0.006], exposure: 0.8, env: 0.5, wet: 0 },
  overcast: { daylight: true, sun: ["#e6ebf2", 0.7, 60, 180, 20, 512], sky: { kind: "gradient", top: "#7c8796", horizon: "#bcc3cb" }, fill: ["#b8c2ce", "#4f4d48", 1.0], bounce: ["#d8d6d0", 0.18], rim: ["#e8eef8", 0.25], fog: ["#adb6c0", 0.009], exposure: 0.85, env: 0.55, wet: 0.15 },
  "golden-hour": { daylight: true, sun: ["#ffc477", 2.6, 13, 245, 3, 2048], sky: { kind: "physical", turbidity: 6, rayleigh: 2.2, mie: 0.006, mieG: 0.86 }, fill: ["#8199c8", "#5e402a", 0.4], bounce: ["#ffb26a", 0.35], rim: ["#ffd29a", 1.0], fog: ["#dcbf9c", 0.005], exposure: 0.72, env: 0.35, wet: 0 },
  sunset: { daylight: true, sun: ["#ff9a5a", 2.2, 5, 255, 4, 2048], sky: { kind: "physical", turbidity: 9, rayleigh: 3.2, mie: 0.008, mieG: 0.9 }, fill: ["#62729f", "#4a3022", 0.45], bounce: ["#ff8a4a", 0.35], rim: ["#ffb070", 1.2], fog: ["#b8876e", 0.007], exposure: 0.8, env: 0.35, wet: 0 },
  "rainy-day": { daylight: true, sun: ["#dfe6f0", 0.6, 55, 190, 20, 512], sky: { kind: "gradient", top: "#627082", horizon: "#9ea9b6" }, fill: ["#a6b2c2", "#40403e", 0.9], bounce: ["#c8ccd0", 0.15], rim: ["#d8e2f0", 0.35], fog: ["#8e9aa8", 0.016], exposure: 0.9, env: 0.6, wet: 0.85 },
  night: { daylight: false, sun: ["#9fb8ff", 1.4, 40, 140, 3, 2048], sky: { kind: "gradient", top: "#03060d", horizon: "#141e33" }, fill: ["#2a3a5c", "#0a0c10", 0.75], bounce: ["#1a2236", 0.1], rim: ["#7f9cff", 1.4], fog: ["#0e1626", 0.025], exposure: 1.45, env: 0.5, wet: 0.2 },
  "cinematic-night": { daylight: false, sun: ["#a7beff", 0.8, 42, 135, 3, 2048], sky: { kind: "gradient", top: "#02050b", horizon: "#16203a" }, fill: ["#22304d", "#0b0c0e", 0.6], rim: ["#88a6ff", 1.7], bounce: ["#151c2c", 0.1], fog: ["#101a2c", 0.026], exposure: 1.35, env: 0.5, wet: 0.3 },
  "rainy-night": { daylight: false, sun: ["#93a8d8", 0.5, 45, 140, 4, 2048], sky: { kind: "gradient", top: "#04070e", horizon: "#1c2638" }, fill: ["#283650", "#0a0b0d", 0.75], bounce: ["#141a26", 0.1], rim: ["#a0b8ff", 1.6], fog: ["#1a2333", 0.03], exposure: 1.5, env: 0.45, wet: 1 },
  "indoor-daylight": { daylight: true, sun: ["#fff6e8", 1.8, 35, 200, 6, 1024], sky: { kind: "gradient", top: "#cfd8e2", horizon: "#e6e3dc" }, fill: ["#dfe4ea", "#8e877a", 0.8], bounce: ["#f0e6d6", 0.3], rim: ["#ffffff", 0.4], fog: ["#dcdad4", 0.004], exposure: 0.8, env: 0.5, wet: 0 },
  "warm-interior": { daylight: false, sun: ["#ffd4a0", 2.0, 45, 160, 5, 1024], sky: { kind: "gradient", top: "#1a120c", horizon: "#3a2a1c" }, fill: ["#5a4433", "#20160e", 0.9], bounce: ["#ffb070", 0.25], rim: ["#ffb070", 0.8], fog: ["#2a1e15", 0.015], exposure: 1.2, env: 0.6, wet: 0 },
  "cold-interior": { daylight: false, sun: ["#cfe2ff", 1.8, 45, 200, 5, 1024], sky: { kind: "gradient", top: "#0d121a", horizon: "#253246" }, fill: ["#344766", "#101318", 0.8], bounce: ["#4a5a78", 0.2], rim: ["#9fc0ff", 0.9], fog: ["#141c28", 0.02], exposure: 1.3, env: 0.6, wet: 0 },
};
const ALIAS: Record<string, keyof typeof P> = { day: "sunny-day", warehouse: "cinematic-night", street: "night", rain: "rainy-night", horror: "cinematic-night" };
export const resolvePreset = (p: LightingPreset): keyof typeof P => (p in P ? (p as keyof typeof P) : ALIAS[p] ?? "sunny-day");

function gradientDome(top: string, horizon: string, ground: string): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(top) }, horizon: { value: new THREE.Color(horizon) }, ground: { value: new THREE.Color(ground) } },
    vertexShader: "varying vec3 vW; void main(){ vW = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: "uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; varying vec3 vW; void main(){ float h = vW.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(clamp(h,0.0,1.0), 0.6)) : mix(horizon, ground, clamp(-h*4.0,0.0,1.0)); gl_FragColor = vec4(c,1.0); }",
  });
  return new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), mat);
}

export function applyLighting(scene: THREE.Scene, preset: LightingPreset, opts: { area?: number; center?: THREE.Vector3 } = {}): LightingRig {
  const p = P[resolvePreset(preset)];
  const [sc, si, elev, az, soft, size] = p.sun;
  const e = THREE.MathUtils.degToRad(elev), a = THREE.MathUtils.degToRad(az);
  const sunDir = new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).normalize();
  const c = opts.center ?? new THREE.Vector3();
  const key = new THREE.DirectionalLight(sc, si);
  key.position.copy(c).addScaledVector(sunDir, 40);
  key.target.position.copy(c);
  key.castShadow = true;
  key.shadow.mapSize.set(size, size);
  const ar = opts.area ?? 16;
  Object.assign(key.shadow.camera, { left: -ar, right: ar, top: ar, bottom: -ar, near: 1, far: 100 });
  key.shadow.bias = -0.0003; key.shadow.normalBias = 0.03; key.shadow.radius = soft;
  const fill = new THREE.HemisphereLight(p.fill[0], p.fill[1], p.fill[2]);
  // bounce: the lit ground sends a little warm light back up, from the side opposite the sun
  const bounce = new THREE.DirectionalLight(p.bounce[0], p.bounce[1]);
  bounce.position.copy(c).add(new THREE.Vector3(-sunDir.x, -0.35, -sunDir.z).multiplyScalar(20));
  bounce.target.position.copy(c);
  const rim = new THREE.DirectionalLight(p.rim[0], p.rim[1]); // aimed each frame from behind the subject (see shot.ts)
  scene.add(key, key.target, fill, bounce, bounce.target, rim, rim.target);

  // sky: physical scattering for clear skies, a soft gradient for cloud cover and night
  const envScene = new THREE.Scene();
  let background = new THREE.Color(p.fog[0]);
  if (p.sky.kind === "physical") {
    const sky = new Sky(); sky.scale.setScalar(450);
    const u = sky.material.uniforms;
    u["turbidity"]!.value = p.sky.turbidity; u["rayleigh"]!.value = p.sky.rayleigh; u["mieCoefficient"]!.value = p.sky.mie; u["mieDirectionalG"]!.value = p.sky.mieG;
    u["sunPosition"]!.value.copy(sunDir);
    scene.add(sky);
    const envSky = new Sky(); envSky.scale.setScalar(450);
    for (const k of Object.keys(u)) (envSky.material.uniforms[k]!.value as unknown) = u[k]!.value;
    envScene.add(envSky);
  } else {
    const dome = gradientDome(p.sky.top, p.sky.horizon, p.fill[1]);
    scene.add(dome); envScene.add(gradientDome(p.sky.top, p.sky.horizon, p.fill[1]));
    background = new THREE.Color(p.sky.horizon);
  }
  scene.background = null;
  const fog = new THREE.FogExp2(p.fog[0], p.fog[1]);
  scene.fog = fog;
  return { key, fill, bounce, rim, exposure: p.exposure, background, fog, envScene, envIntensity: p.env, sunDir, wetness: p.wet, daylight: p.daylight, rimStrength: p.rim[1] };
}
