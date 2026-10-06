import * as THREE from "three";
import type { LightingPreset } from "../spec";

/**
 * Scene-level lighting presets: a key (sun/moon), a fill (sky/ground hemisphere), a rim from behind, fog and exposure.
 * Practical lights (a lamp over a door, a light inside a building, a torch) belong to the set and the props, not here.
 * Shadows: one shadow-casting key per preset (the M1 renders 1080x1920 at ~60 ms/frame with 3-4 shadow maps).
 */
export interface LightingRig { key: THREE.DirectionalLight; fill: THREE.HemisphereLight; rim: THREE.DirectionalLight; exposure: number; background: THREE.Color; fog: THREE.FogExp2 }

const P: Record<LightingPreset, { key: [string, number]; keyDir: [number, number, number]; fill: [string, string, number]; rim: [string, number]; fog: [string, number]; bg: string; exposure: number }> = {
  day: { key: ["#fff1dc", 3.2], keyDir: [6, 10, 4], fill: ["#bcd6ff", "#6b5a45", 1.1], rim: ["#ffffff", 0.6], fog: ["#c9d6e6", 0.006], bg: "#9fbbe0", exposure: 1.0 },
  night: { key: ["#9fb8ff", 1.6], keyDir: [-6, 11, 5], fill: ["#2a3a5c", "#0a0c10", 0.75], rim: ["#7f9cff", 1.4], fog: ["#0e1626", 0.03], bg: "#060a14", exposure: 1.45 },
  warehouse: { key: ["#a7beff", 1.2], keyDir: [-7, 12, 6], fill: ["#22304d", "#0b0c0e", 0.6], rim: ["#88a6ff", 1.6], fog: ["#101a2c", 0.03], bg: "#05080f", exposure: 1.3 },
  street: { key: ["#a9bfff", 1.4], keyDir: [5, 12, 3], fill: ["#2f3a52", "#14110d", 0.8], rim: ["#ffb36b", 1.0], fog: ["#151b28", 0.022], bg: "#070a12", exposure: 1.4 },
  rain: { key: ["#93a8d8", 1.1], keyDir: [-4, 12, 6], fill: ["#283650", "#0a0b0d", 0.75], rim: ["#a0b8ff", 1.3], fog: ["#1a2333", 0.035], bg: "#0b111c", exposure: 1.3 },
  horror: { key: ["#7d95c8", 0.7], keyDir: [-3, 10, 8], fill: ["#1a2236", "#050506", 0.4], rim: ["#6f8bd6", 1.8], fog: ["#0a0f1a", 0.05], bg: "#030509", exposure: 1.6 },
  "warm-interior": { key: ["#ffd4a0", 2.2], keyDir: [3, 6, 2], fill: ["#5a4433", "#20160e", 0.9], rim: ["#ffb070", 0.8], fog: ["#2a1e15", 0.02], bg: "#1a120c", exposure: 1.2 },
  "cold-interior": { key: ["#cfe2ff", 1.8], keyDir: [-3, 6, 2], fill: ["#344766", "#101318", 0.8], rim: ["#9fc0ff", 0.9], fog: ["#141c28", 0.025], bg: "#0d121a", exposure: 1.3 },
};

export function applyLighting(scene: THREE.Scene, preset: LightingPreset, opts: { shadowSize?: number; area?: number } = {}): LightingRig {
  const p = P[preset];
  const key = new THREE.DirectionalLight(p.key[0], p.key[1]);
  key.position.set(...p.keyDir);
  key.castShadow = true;
  const s = opts.shadowSize ?? 2048, a = opts.area ?? 14;
  key.shadow.mapSize.set(s, s);
  Object.assign(key.shadow.camera, { left: -a, right: a, top: a, bottom: -a, near: 0.5, far: 60 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
  const fill = new THREE.HemisphereLight(p.fill[0], p.fill[1], p.fill[2]);
  const rim = new THREE.DirectionalLight(p.rim[0], p.rim[1]);
  rim.position.set(-p.keyDir[0] * 0.4, 4, -12);
  scene.add(key, key.target, fill, rim);
  const fog = new THREE.FogExp2(p.fog[0], p.fog[1]);
  scene.fog = fog;
  const background = new THREE.Color(p.bg);
  scene.background = background;
  return { key, fill, rim, exposure: p.exposure, background, fog };
}
