import * as THREE from "three";
import type { VehicleKind, VehicleModel } from "./vehicle-models";

/**
 * Secondary vehicle effects, restrained and story-aware (the set decides which are on):
 * - exhaust: combustion vehicles only (no bicycles, no electric vehicles); a faint trace when cruising, a visible puff when
 *   pulling away (most for a diesel bus), a little idle smoke from a bus at its stop; more visible in cold wet air;
 * - dust: only on a dry dirt road, from the rear wheels, growing with speed;
 * - road spray: only on a wet road, thrown up and back from the rear wheels above ~3 m/s;
 * - at night: headlamp and tail glows, a faint headlight beam, light streaks on a wet road, and a fixed pool of two real
 *   spotlights given to the vehicles nearest the camera (the light count never changes, so shaders never recompile);
 * - always: a soft contact shadow under every vehicle (it sits on the road).
 *
 * DETERMINISM: every particle is a pure function of the shot time. Particle k of a vehicle was last emitted at
 * t_e = k * period + m * life (m = how many lives have passed); its position, size and opacity follow from the vehicle's
 * simulated state AT t_e (position, heading, speed, acceleration) and its age t - t_e, with seeded per-particle variation.
 * No state is carried between frames, so a chunk starting at any frame draws exactly what a full render draws.
 */
export interface FxOptions { exhaust: boolean; dust: boolean; spray: boolean; night: boolean; wet: number; electric?: VehicleKind[]; viewportHeight: number }
export interface FxActor { kind: VehicleKind; model: VehicleModel; state(t: number): { p: THREE.Vector3; yaw: number; v: number; a: number } | null }

const hash = (a: number, b: number, c: number, d: number): number => { let h = (a * 374761393 + b * 668265263 + c * 2246822519 + d * 3266489917) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const EXHAUST: Record<VehicleKind, number> = { car: 0.05, auto: 0.14, bus: 0.2, motorcycle: 0.08, scooter: 0.06, bicycle: 0 };

let softDisc: THREE.CanvasTexture | THREE.DataTexture | null = null;
function disc(): THREE.Texture {
  if (softDisc) return softDisc;
  const N = 64, d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const r = Math.hypot(x - N / 2 + 0.5, y - N / 2 + 0.5) / (N / 2), a = Math.max(0, 1 - r) ** 1.6; d.set([255, 255, 255, Math.round(a * 255)], (y * N + x) * 4); }
  softDisc = new THREE.DataTexture(d, N, N); softDisc.needsUpdate = true;
  return softDisc;
}

/** A pool of camera-facing soft particles with per-particle size (metres), opacity and colour. */
function particlePool(n: number, scale: number, blending: THREE.Blending = THREE.NormalBlending): { points: THREE.Points; pos: Float32Array; size: Float32Array; alpha: Float32Array; col: Float32Array; commit(): void } {
  const geo = new THREE.BufferGeometry(), pos = new Float32Array(n * 3), size = new Float32Array(n), alpha = new Float32Array(n), col = new Float32Array(n * 3);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1)); geo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1)); geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending, fog: true,
    uniforms: { uMap: { value: disc() }, uScale: { value: scale }, ...THREE.UniformsLib.fog },
    vertexShader: `attribute float aSize; attribute float aAlpha; attribute vec3 aColor; uniform float uScale; varying float vA; varying vec3 vC;
      #include <fog_pars_vertex>
      void main(){ vA = aAlpha; vC = aColor; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition; gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(0.1, -mvPosition.z) : 0.0;
      #include <fog_vertex>
      }`,
    fragmentShader: `uniform sampler2D uMap; varying float vA; varying vec3 vC;
      #include <fog_pars_fragment>
      void main(){ float a = texture2D(uMap, gl_PointCoord).a * vA; if (a < 0.002) discard; gl_FragColor = vec4(vC, a);
      #include <fog_fragment>
      }`,
  });
  const points = new THREE.Points(geo, mat); points.frustumCulled = false; points.renderOrder = 2;
  return { points, pos, size, alpha, col, commit: () => { for (const k of ["position", "aSize", "aAlpha", "aColor"]) geo.attributes[k]!.needsUpdate = true; } };
}
function sprite(color: string, size: number, opacity: number): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: disc(), color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  s.scale.setScalar(size); return s;
}
function beam(length: number, radius: number, intensity: number): THREE.Mesh {
  const g = new THREE.ConeGeometry(radius, length, 20, 1, true); g.rotateZ(Math.PI / 2); g.translate(length / 2, 0, 0); g.rotateZ(-0.06);
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uLen: { value: length }, uI: { value: intensity }, uC: { value: new THREE.Color("#fff1d2") } },
    vertexShader: "varying float vX; void main(){ vX = position.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "uniform float uLen; uniform float uI; uniform vec3 uC; varying float vX; void main(){ float k = clamp(vX / uLen, 0.0, 1.0); gl_FragColor = vec4(uC * uI * pow(1.0 - k, 2.2) * smoothstep(0.0, 0.08, k), 1.0); }",
  });
  return new THREE.Mesh(g, m);
}
function streakTex(): THREE.Texture {
  const N = 16, M = 128, d = new Uint8Array(N * M * 4);
  for (let y = 0; y < M; y++) for (let x = 0; x < N; x++) { const a = Math.max(0, 1 - Math.abs(x - N / 2 + 0.5) / (N / 2)) ** 2 * Math.sin((y / (M - 1)) * Math.PI) ** 1.5; d.set([255, 255, 255, Math.round(a * 255)], (y * N + x) * 4); }
  const t = new THREE.DataTexture(d, N, M); t.needsUpdate = true; return t;
}

export function vehicleFx(o: FxOptions, actors: FxActor[], parked: VehicleModel[]): { group: THREE.Group; update(t: number, cam?: THREE.Vector3): void } {
  const group = new THREE.Group(), scale = o.viewportHeight * 1.45;
  // ---- contact shadows (children of each vehicle, so they move with it)
  const shadowMat = new THREE.MeshBasicMaterial({ map: disc(), color: "#000000", transparent: true, opacity: o.night ? 0.45 : 0.55, depthWrite: false });
  for (const m of [...actors.map((a) => a.model), ...parked]) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(m.anchors.length * 1.15, m.anchors.width * 1.35), shadowMat); s.rotation.x = -Math.PI / 2; s.position.y = 0.012; s.renderOrder = 1; m.root.add(s);
  }
  // ---- night lights: glows, beams, wet-road streaks (per vehicle), a pool of two real spotlights
  const lit: { a: FxActor | null; model: VehicleModel; streaks: { mesh: THREE.Mesh; tail: boolean; local: THREE.Vector3 }[]; tailGlows: THREE.Sprite[] }[] = [];
  const stex = o.night && o.wet > 0.3 ? streakTex() : null;
  for (const [i, m] of [...actors.map((a) => a.model), ...parked].entries()) {
    if (!o.night) break;
    const big = m.anchors.length > 6, two = m.anchors.width < 1;
    const rec = { a: actors[i] ?? null, model: m, streaks: [] as { mesh: THREE.Mesh; tail: boolean; local: THREE.Vector3 }[], tailGlows: [] as THREE.Sprite[] };
    for (const h of m.anchors.headlamps) {
      const g = sprite("#fff0d0", big ? 1.0 : two ? 0.55 : 0.75, 0.9); g.position.copy(h).add(new THREE.Vector3(0.05, 0, 0)); m.root.add(g);
      const b = beam(two ? 6 : 9, two ? 1.0 : 1.5, two ? 0.05 : 0.065); b.position.copy(h); m.root.add(b);
      if (stex) { const st = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 1), new THREE.MeshBasicMaterial({ map: stex, color: "#ffe2b0", transparent: true, opacity: 0.32 * o.wet, depthWrite: false, blending: THREE.AdditiveBlending })); group.add(st); rec.streaks.push({ mesh: st, tail: false, local: h.clone() }); }
    }
    for (const tl of m.anchors.taillamps) {
      const g = sprite("#ff3020", two ? 0.3 : 0.45, 0.7); g.position.copy(tl).add(new THREE.Vector3(-0.05, 0, 0)); m.root.add(g); rec.tailGlows.push(g);
      if (stex) { const st = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 1), new THREE.MeshBasicMaterial({ map: stex, color: "#ff3a28", transparent: true, opacity: 0.28 * o.wet, depthWrite: false, blending: THREE.AdditiveBlending })); group.add(st); rec.streaks.push({ mesh: st, tail: true, local: tl.clone() }); }
    }
    lit.push(rec);
  }
  const pool = o.night ? [0, 1].map(() => { const l = new THREE.SpotLight("#ffe6c0", 0, 26, 0.55, 0.65, 1.4); group.add(l, l.target); return l; }) : [];

  // ---- particles
  const emitters = actors.map((a, i) => ({ a, i, ex: o.exhaust && a.model.anchors.exhaust && EXHAUST[a.kind] > 0 && !(o.electric ?? []).includes(a.kind) }));
  const EX = { K: 16, period: 0.11 }, DU = { K: 18, period: 0.05 }, SP = { K: 14, period: 0.035 };
  const nEx = emitters.filter((e) => e.ex).length * EX.K;
  const nDu = o.dust ? actors.reduce((n, a) => n + a.model.anchors.rearWheels.length, 0) * DU.K : 0;
  const nSp = o.spray ? actors.reduce((n, a) => n + a.model.anchors.rearWheels.length, 0) * SP.K : 0;
  const pEx = nEx ? particlePool(nEx, scale) : null, pDu = nDu ? particlePool(nDu, scale) : null, pSp = nSp ? particlePool(nSp, scale) : null;
  for (const p of [pEx, pDu, pSp]) if (p) group.add(p.points);
  const tmp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const world = (st: { p: THREE.Vector3; yaw: number }, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 => out.copy(local).applyAxisAngle(up, st.yaw).add(st.p);
  const life = (cfg: { K: number; period: number }, slot: number, t: number): { te: number; age: number; m: number } => {
    const L = cfg.K * cfg.period, m = Math.floor((t - slot * cfg.period) / L), te = slot * cfg.period + m * L; return { te, age: t - te, m };
  };
    // dust is lighter than the earth it comes from (fine powder in the sun), spray lighter than wet asphalt
  const exhaustCol = new THREE.Color(o.night ? "#6a7076" : "#c3c8cd"), dustCol = new THREE.Color("#e6d6b8"), sprayCol = new THREE.Color(o.night ? "#b4bec8" : "#eef2f6");
  const nightK = o.night ? 0.55 : 1;

  return {
    group,
    update(t: number, cam?: THREE.Vector3): void {
      // a light's reflection on a wet road stretches from under the lamp toward the viewer
      const eye = cam ?? new THREE.Vector3(0, 1.5, 10);
      for (const L of lit) {
        const st = L.a ? L.a.state(t) : null, pose = st ?? { p: L.model.root.position, yaw: L.model.root.rotation.y };
        for (const s of L.streaks) {
          if (L.a && !st) { s.mesh.visible = false; continue; }
          world(pose, s.local, tmp); tmp.y = 0.02;
          const dx = eye.x - tmp.x, dz = eye.z - tmp.z, dist = Math.hypot(dx, dz), len = Math.min(s.tail ? 3 : 5, dist * 0.45);
          s.mesh.visible = dist > 0.5;
          s.mesh.position.set(tmp.x + (dx / dist) * len * 0.5, 0.02, tmp.z + (dz / dist) * len * 0.5);
          s.mesh.rotation.set(-Math.PI / 2, 0, -Math.atan2(dx, dz), "XYZ");
          s.mesh.scale.set(1, len, 1);
        }
        const tailI = L.model.tail[0] ? (L.model.tail[0].material as THREE.MeshStandardMaterial).emissiveIntensity : 1.6;
        for (const g of L.tailGlows) { (g.material as THREE.SpriteMaterial).opacity = Math.min(1, 0.25 + tailI * 0.12); g.scale.setScalar((L.model.anchors.width < 1 ? 0.3 : 0.45) * (1 + Math.min(1, (tailI - 1.6) / 5) * 0.8)); }
      }
      if (pool.length && cam) {
        // the two vehicles nearest the camera (visible, with headlamps) get real light; ties broken by index
        const near = actors.map((a, i) => ({ a, i, st: a.state(t) })).filter((x) => x.st && x.a.model.anchors.headlamps.length).map((x) => ({ ...x, d: x.st!.p.distanceTo(cam) })).sort((p, q) => p.d - q.d || p.i - q.i).slice(0, pool.length);
        pool.forEach((l, k) => {
          const x = near[k];
          if (!x || x.d > 45) { l.intensity = 0; return; }
          const h = x.a.model.anchors.headlamps[0]!, st = x.st!;
          world(st, tmp.set(h.x + 0.1, h.y + 0.1, 0), l.position);
          world(st, tmp.set(h.x + 10, 0, 0), l.target.position); l.target.updateMatrixWorld();
          l.intensity = (x.a.model.anchors.width < 1 ? 35 : 70) * Math.min(1, Math.max(0, (45 - x.d) / 15));
        });
      }
      // exhaust
      if (pEx) {
        let n = 0;
        for (const e of emitters) {
          if (!e.ex) continue;
          for (let k = 0; k < EX.K; k++, n++) {
            const { te, age, m } = life(EX, k, t), st = e.a.state(te);
            if (!st) { pEx.alpha[n] = 0; pEx.pos.fill(0, n * 3, n * 3 + 3); continue; }
            const base = EXHAUST[e.a.kind], kick = Math.max(0, Math.min(1.5, st.a)) * (e.a.kind === "bus" ? 0.5 : e.a.kind === "auto" ? 0.3 : 0.18), idle = (e.a.kind === "bus" || e.a.kind === "auto") && st.v < 0.3 ? 0.14 : 0;
            const amount = Math.min(0.55, (base + kick + idle) * (1 + 0.5 * o.wet) * nightK), L = EX.K * EX.period, u = age / L;
            const h1 = hash(e.i, k, m, 1), h2 = hash(e.i, k, m, 2), h3 = hash(e.i, k, m, 3);
            world(st, e.a.model.anchors.exhaust!, tmp);
            const back = new THREE.Vector3(-1, 0, 0).applyAxisAngle(up, st.yaw);
            tmp.addScaledVector(back, 0.25 * age).add(new THREE.Vector3((h1 - 0.5) * 0.5 * age, 0.22 * age + 0.4 * age * age * 0.3, (h2 - 0.5) * 0.5 * age));
            pEx.pos.set([tmp.x, tmp.y, tmp.z], n * 3); pEx.size[n] = 0.08 + 0.55 * age + 0.1 * h3;
            pEx.alpha[n] = amount * Math.min(1, age / 0.08) * (1 - u) ** 1.6; pEx.col.set([exhaustCol.r, exhaustCol.g, exhaustCol.b], n * 3);
          }
        }
        pEx.commit();
      }
      // dust (dry dirt road) and spray (wet road), from the rear wheels
      for (const [pool2, cfg, kind] of [[pDu, DU, "dust"], [pSp, SP, "spray"]] as const) {
        if (!pool2) continue;
        let n = 0;
        for (const [ai, a] of actors.entries()) for (const [wi, wpos] of a.model.anchors.rearWheels.entries()) for (let k = 0; k < cfg.K; k++, n++) {
          const { te, age, m } = life(cfg, k, t), st = a.state(te);
          if (!st) { pool2.alpha[n] = 0; pool2.pos.fill(0, n * 3, n * 3 + 3); continue; }
          const h1 = hash(ai * 7 + wi, k, m, kind === "dust" ? 11 : 13), h2 = hash(ai * 7 + wi, k, m, 17), h3 = hash(ai * 7 + wi, k, m, 19);
          world(st, tmp.set(wpos.x - 0.2, 0.05, wpos.z), tmp);
          const back = new THREE.Vector3(-1, 0, 0).applyAxisAngle(up, st.yaw), side = new THREE.Vector3(0, 0, 1).applyAxisAngle(up, st.yaw);
          if (kind === "dust") {
            const amount = Math.min(1, Math.max(0, (st.v - 0.8) / 3.2)) * (a.model.anchors.width < 1 ? 0.4 : 0.62) * (a.kind === "bicycle" ? 0.45 : 1), u = age / (cfg.K * cfg.period);
            // low puffs that roll off the tyre and settle: under a metre high and ~1.3 m across at most, gone in 0.9 s
            // (a long-lived, growing cloud read as a flat yellow band across the frame)
            tmp.addScaledVector(back, (0.5 + 0.8 * h1) * age).addScaledVector(side, (h2 - 0.5) * 0.9 * age); tmp.y += 0.18 + 0.35 * age * (1 - 0.5 * age);
            pool2.pos.set([tmp.x, Math.min(0.95, tmp.y), tmp.z], n * 3); pool2.size[n] = 0.28 + 1.1 * age + 0.2 * h3;
            pool2.alpha[n] = amount * 0.8 * Math.min(1, age / 0.1) * (1 - u) ** 2; pool2.col.set([dustCol.r, dustCol.g, dustCol.b], n * 3);
          } else {
            // thrown up and back from the tyre, falling under gravity, gone when it lands
            const amount = Math.min(1, Math.max(0, (st.v - 2) / 5)) * 0.75 * Math.min(1, o.wet) * (a.model.anchors.width < 1 ? 0.5 : 1);
            const vb = st.v * (0.15 + 0.15 * h1), vu = 1.2 + 1.1 * h2, vs = (h3 - 0.5) * 0.9;
            tmp.addScaledVector(back, vb * age).addScaledVector(side, vs * age); tmp.y += vu * age - 4.9 * age * age;
            const alive = tmp.y > 0.01 ? 1 : 0;
            pool2.pos.set([tmp.x, Math.max(0.01, tmp.y), tmp.z], n * 3); pool2.size[n] = 0.1 + 0.5 * age;
            pool2.alpha[n] = alive * amount * (1 - age / (cfg.K * cfg.period)); pool2.col.set([sprayCol.r, sprayCol.g, sprayCol.b], n * 3);
          }
        }
        pool2.commit();
      }
    },
  };
}
