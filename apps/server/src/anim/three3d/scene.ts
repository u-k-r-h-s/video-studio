/**
 * Three.js proof of concept (runs INSIDE a headless Chrome page, bundled by scripts/lab/three3d-poc/render.ts).
 * One 10 s vertical shot: a rigged GLB character outside a dark warehouse at night.
 *   0-2 s idle, looks around | 2-5 s turns and walks to the door | 5-7 s stops, raises a flashlight |
 *   7-9 s reacts to something inside and steps back | 9-10 s the camera pushes in.
 * Skeletal clips (Idle/Walk) are cross-faded by an AnimationMixer; the arm, spine and head are layered on top procedurally
 * (the test character has no "raise flashlight" or "react" clip). Everything is a pure function of the frame sequence, so the
 * renderer steps it frame by frame at exactly 30 fps.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface PocOptions { width: number; height: number; fps: number; duration: number; glbBase64: string }

const smooth = (a: number, b: number, t: number): number => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Procedural canvas textures (no image files needed). */
function corrugated(): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = 512; c.height = 512;
  const g = c.getContext("2d")!;
  for (let x = 0; x < 512; x++) { const v = 58 + 26 * Math.sin((x / 512) * Math.PI * 2 * 24) + (Math.random() - 0.5) * 6; g.fillStyle = `rgb(${v * 0.85},${v * 0.9},${v})`; g.fillRect(x, 0, 1, 512); }
  for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(60,40,25,${Math.random() * 0.25})`; g.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 8, 20 + Math.random() * 120); } // rust streaks
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}
function asphalt(): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const c = document.createElement("canvas"); c.width = c.height = 512;
  const g = c.getContext("2d")!, d = g.createImageData(512, 512);
  const r = document.createElement("canvas"); r.width = r.height = 512;
  const rg = r.getContext("2d")!, rd = rg.createImageData(512, 512);
  for (let i = 0; i < 512 * 512; i++) {
    const n = 30 + Math.random() * 22;
    d.data[i * 4] = n; d.data[i * 4 + 1] = n; d.data[i * 4 + 2] = n * 1.05; d.data[i * 4 + 3] = 255;
    const x = i % 512, y = (i / 512) | 0;
    const puddle = Math.sin(x * 0.021) * Math.cos(y * 0.017) + Math.sin(x * 0.007 + y * 0.011) > 0.9; // wet patches: smooth
    const v = puddle ? 30 : 170 + Math.random() * 60;
    rd.data[i * 4] = rd.data[i * 4 + 1] = rd.data[i * 4 + 2] = v; rd.data[i * 4 + 3] = 255;
  }
  g.putImageData(d, 0, 0); rg.putImageData(rd, 0, 0);
  const map = new THREE.CanvasTexture(c), rough = new THREE.CanvasTexture(r);
  for (const t of [map, rough]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 6); }
  map.colorSpace = THREE.SRGBColorSpace;
  return { map, rough };
}

export interface Poc { renderFrame(i: number): void; canvas: HTMLCanvasElement; frames: number; info(): Record<string, unknown> }

export async function createPoc(o: PocOptions): Promise<Poc> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(o.width, o.height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.45;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#070b14");
  scene.fog = new THREE.FogExp2("#141d2e", 0.032);

  // --- environment: wet asphalt, a corrugated warehouse with a lit door, crates, barrels, a fence, a distant skyline
  const { map, rough } = asphalt();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ map, roughnessMap: rough, roughness: 1, metalness: 0.05, color: "#9aa0aa" }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  const wallTex = corrugated(); wallTex.repeat.set(4, 1);
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.75, metalness: 0.35, color: "#8a93a3" });
  const warehouse = new THREE.Group();
  const WZ = -9; // front wall plane
  const wallL = new THREE.Mesh(new THREE.BoxGeometry(9, 7, 0.3), wallMat); wallL.position.set(-6.1, 3.5, WZ);
  const wallR = new THREE.Mesh(new THREE.BoxGeometry(9, 7, 0.3), wallMat); wallR.position.set(6.1, 3.5, WZ);
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3.2, 0.3), wallMat); lintel.position.set(0, 5.4, WZ);
  for (const m of [wallL, wallR, lintel]) { m.castShadow = true; m.receiveShadow = true; warehouse.add(m); }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(22, 0.4, 14), new THREE.MeshStandardMaterial({ color: "#1a1f29", roughness: 0.9 })); roof.position.set(0, 7.1, WZ - 7); warehouse.add(roof);
  // the open doorway: a dark interior with a faint cold light deep inside (what the character reacts to)
  const interior = new THREE.Mesh(new THREE.BoxGeometry(3.0, 3.8, 6), new THREE.MeshStandardMaterial({ color: "#05070b", roughness: 1, side: THREE.BackSide }));
  interior.position.set(0, 1.9, WZ - 3); interior.receiveShadow = true; warehouse.add(interior);
  const frameMat = new THREE.MeshStandardMaterial({ color: "#2b2f36", roughness: 0.6, metalness: 0.6 });
  for (const [x, w, h, y] of [[-1.55, 0.12, 3.8, 1.9], [1.55, 0.12, 3.8, 1.9], [0, 3.2, 0.14, 3.85]] as const) { const f = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.4), frameMat); f.position.set(x, y, WZ + 0.05); f.castShadow = true; warehouse.add(f); }
  // a half-open sliding door leaf
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.7, 3.7, 0.08), new THREE.MeshStandardMaterial({ map: wallTex.clone(), roughness: 0.7, metalness: 0.4, color: "#6c7584" }));
  leaf.position.set(-1.0, 1.85, WZ + 0.22); leaf.castShadow = true; warehouse.add(leaf);
  scene.add(warehouse);
  const inside = new THREE.PointLight("#7fb0ff", 0, 9, 1.6); inside.position.set(0.4, 1.4, WZ - 4.5); scene.add(inside);
  const eyes = new THREE.Group(); // two faint glints deep inside, revealed by the flashlight
  for (const x of [-0.09, 0.09]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 8), new THREE.MeshBasicMaterial({ color: "#d6f0ff" })); e.position.set(0.5 + x, 1.25, WZ - 4.2); eyes.add(e); }
  eyes.visible = false; scene.add(eyes);

  // practical lamp over the door: warm, casts shadows, with a visible bulb and a soft light cone in the fog
  const lampPos = new THREE.Vector3(0, 4.15, WZ + 0.6);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 16), new THREE.MeshBasicMaterial({ color: "#ffd9a0" })); bulb.position.copy(lampPos); scene.add(bulb);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.22, 24, 1, true), new THREE.MeshStandardMaterial({ color: "#20242b", metalness: 0.7, roughness: 0.4, side: THREE.DoubleSide })); shade.position.copy(lampPos).add(new THREE.Vector3(0, 0.12, 0)); scene.add(shade);
  const lamp = new THREE.SpotLight("#ffc98a", 280, 16, Math.PI / 3.0, 0.6, 1.6);
  lamp.position.copy(lampPos); lamp.target.position.set(0, 0, WZ + 3.5); lamp.castShadow = true; lamp.shadow.mapSize.set(1024, 1024); lamp.shadow.bias = -0.0004;
  scene.add(lamp, lamp.target);
  const coneMat = new THREE.MeshBasicMaterial({ color: "#ffb870", transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const lampCone = new THREE.Mesh(new THREE.ConeGeometry(2.4, 4.4, 32, 1, true), coneMat); lampCone.position.set(0, 2.3, WZ + 1.6); lampCone.rotation.x = -0.25; void lampCone; // a cone mesh read as a flat wedge from this angle: the fog and the light do the job

  // moonlight: cold key from above-left, long soft shadows
  const moon = new THREE.DirectionalLight("#9fb8ff", 2.6);
  moon.position.set(-8, 12, 6); moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048); moon.shadow.camera.left = -10; moon.shadow.camera.right = 10; moon.shadow.camera.top = 10; moon.shadow.camera.bottom = -10; moon.shadow.bias = -0.0003; moon.shadow.radius = 4;
  scene.add(moon);
  scene.add(new THREE.HemisphereLight("#3d4d6e", "#0b0d10", 0.9));

  // props for depth: crates, barrels, a fence in the foreground, distant buildings
  const crateMat = new THREE.MeshStandardMaterial({ color: "#5a4632", roughness: 0.85 });
  for (const [x, z, s] of [[3.6, -7.6, 1.1], [4.5, -7.9, 0.9], [3.9, -6.6, 0.8], [-4.2, -7.4, 1.0]] as const) { const b = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat); b.position.set(x, s / 2, z); b.rotation.y = x * 0.3; b.castShadow = b.receiveShadow = true; scene.add(b); }
  const barrelMat = new THREE.MeshStandardMaterial({ color: "#3c4a3e", roughness: 0.5, metalness: 0.6 });
  for (const [x, z] of [[-3.2, -6.4], [-2.6, -6.9]] as const) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.95, 20), barrelMat); b.position.set(x, 0.475, z); b.castShadow = b.receiveShadow = true; scene.add(b); }
  const postMat = new THREE.MeshStandardMaterial({ color: "#1c2027", metalness: 0.8, roughness: 0.4 });
  for (let i = 0; i < 4; i++) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 8), postMat); p.position.set(3.4 + i * 1.9, 1.2, 3.4); p.castShadow = true; scene.add(p); }
  const skyline = new THREE.Group();
  for (let i = 0; i < 14; i++) { const h = 6 + Math.random() * 14; const b = new THREE.Mesh(new THREE.BoxGeometry(3 + Math.random() * 4, h, 3), new THREE.MeshBasicMaterial({ color: "#0d1422" })); b.position.set(-30 + i * 4.6, h / 2, -38 - Math.random() * 8); skyline.add(b); }
  scene.add(skyline);
  // rain: thin streaks falling through the light
  const RAIN = 2600, rainGeo = new THREE.BufferGeometry(), rp = new Float32Array(RAIN * 6), seeds = new Float32Array(RAIN * 3);
  for (let i = 0; i < RAIN; i++) { seeds[i * 3] = (Math.random() - 0.5) * 16; seeds[i * 3 + 1] = Math.random() * 9; seeds[i * 3 + 2] = -12 + Math.random() * 16; }
  rainGeo.setAttribute("position", new THREE.BufferAttribute(rp, 3));
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: "#9fb4d6", transparent: true, opacity: 0.32 }));
  scene.add(rain);

  // --- character
  const bytes = Uint8Array.from(atob(o.glbBase64), (ch) => ch.charCodeAt(0));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, "");
  const hero = gltf.scene;
  hero.traverse((n) => { const m = n as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  scene.add(hero);
  const bone = (name: string): THREE.Bone => { const b = hero.getObjectByName(`mixamorig${name}`) as THREE.Bone | undefined; if (!b) throw new Error(`bone ${name} missing`); return b; };
  const B = { hips: bone("Hips"), spine: bone("Spine1"), spine2: bone("Spine2"), neck: bone("Neck"), head: bone("Head"), rArm: bone("RightArm"), rFore: bone("RightForeArm"), rHand: bone("RightHand"), lArm: bone("LeftArm"), lFore: bone("LeftForeArm") };
  const mixer = new THREE.AnimationMixer(hero);
  const clip = (n: string): THREE.AnimationClip => { const c = gltf.animations.find((a) => a.name === n); if (!c) throw new Error(`clip ${n} missing`); return c; };
  const idle = mixer.clipAction(clip("Idle")), walk = mixer.clipAction(clip("Walk"));
  for (const a of [idle, walk]) { a.enabled = true; a.setEffectiveTimeScale(1); a.play(); }
  idle.setEffectiveWeight(1); walk.setEffectiveWeight(0);

  // flashlight in the right hand: a small torch mesh parented to the hand bone, a spotlight and a visible beam that follow it
  const torch = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.018, 0.2, 16), new THREE.MeshStandardMaterial({ color: "#23262b", metalness: 0.8, roughness: 0.35 }));
  body.rotation.z = Math.PI / 2; torch.add(body);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.028, 20), new THREE.MeshBasicMaterial({ color: "#fff4d6" })); lens.position.x = 0.101; lens.rotation.y = Math.PI / 2; torch.add(lens);
  const beamLight = new THREE.SpotLight("#fff1d0", 0, 18, 0.32, 0.5, 1.2); beamLight.castShadow = true; beamLight.shadow.mapSize.set(1024, 1024);
  beamLight.position.set(0.1, 0, 0); torch.add(beamLight); const beamTarget = new THREE.Object3D(); beamTarget.position.set(4, 0, 0); torch.add(beamTarget); beamLight.target = beamTarget;
  const beamMat = new THREE.MeshBasicMaterial({ color: "#fff0cc", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(new THREE.ConeGeometry(0.42, 6, 28, 1, true), beamMat); beam.rotation.z = Math.PI / 2; beam.position.x = 3.1; torch.add(beam);
  // the bone frames are scaled by the armature (the GLB is in centimetres under a 0.01 root): compensate once
  B.rHand.add(torch);
  hero.updateMatrixWorld(true);
  const hs = new THREE.Vector3(); B.rHand.getWorldScale(hs);
  torch.scale.setScalar(1 / hs.x);
  torch.position.set(0.0 / hs.x, 0.09 / hs.x, 0.02 / hs.x); // in the palm
  torch.rotation.set(0, 0, Math.PI / 2); // along the fingers

  // --- camera: a 35 mm-ish lens at chest height, slightly low, following the character with lag
  const camera = new THREE.PerspectiveCamera(38, o.width / o.height, 0.1, 200);
  scene.add(camera);

  // --- timeline
  const start = new THREE.Vector3(1.2, 0, 1.0), door = new THREE.Vector3(0.15, 0, WZ + 3.1);
  const WALK_SPEED = 1.32; // m/s, matched to the Walk clip so the feet do not slide
  const tWalk0 = 2.0, walkLen = start.distanceTo(door), tWalk1 = tWalk0 + 0.35 + walkLen / WALK_SPEED; // includes the speed-up
  const headingDoor = Math.atan2(door.x - start.x, door.z - start.z);
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  const addRot = (b: THREE.Bone, x: number, y: number, z: number, w: number): void => { if (w <= 0.0001) return; e.set(x * w, y * w, z * w, "XYZ"); q.setFromEuler(e); b.quaternion.multiply(q); };
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  /** Rotates `b` so the direction from it to `child` points along `dir` (world space), blended by w. */
  const aimBone = (b: THREE.Bone, child: THREE.Object3D, dir: THREE.Vector3, w: number): void => {
    if (w <= 0.0001) return;
    b.updateMatrixWorld(true);
    const p0 = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld), p1 = new THREE.Vector3().setFromMatrixPosition(child.matrixWorld);
    const cur = p1.sub(p0).normalize();
    const delta = new THREE.Quaternion().setFromUnitVectors(cur, dir);
    const worldQ = new THREE.Quaternion(); b.getWorldQuaternion(worldQ);
    const targetW = delta.multiply(worldQ);
    const parentQ = new THREE.Quaternion(); b.parent!.getWorldQuaternion(parentQ);
    const local = parentQ.invert().multiply(targetW);
    b.quaternion.slerp(local, w);
    b.updateMatrixWorld(true);
  };
  let lastI = -1;
  const dt = 1 / o.fps;
  let pos = start.clone(), backStep = 0;
  const frames = Math.round(o.duration * o.fps);

  const renderFrame = (i: number): void => {
    if (i !== lastI + 1) throw new Error("frames must be rendered in order");
    lastI = i;
    const t = i / o.fps;
    // locomotion: distance along the path with ease in/out, the walk clip's weight follows the speed (cross-fade, not a cut)
    const sIn = smooth(tWalk0, tWalk0 + 0.6, t), sOut = 1 - smooth(tWalk1 - 0.5, tWalk1 + 0.15, t);
    const speed = WALK_SPEED * Math.min(sIn, sOut) * (t > tWalk0 ? 1 : 0);
    const dir = new THREE.Vector3().subVectors(door, start).normalize();
    pos.addScaledVector(dir, speed * (i === 0 ? 0 : dt));
    if (pos.distanceTo(start) > walkLen) pos.copy(door);
    // the reaction: two steps backwards (walk clip reversed), 7.15 -> 8.1 s
    const back = smooth(7.15, 7.35, t) * (1 - smooth(7.9, 8.15, t));
    backStep += back * 0.85 * dt;
    const at = pos.clone().addScaledVector(dir, -backStep);
    hero.position.copy(at);
    const walkW = Math.max(speed / WALK_SPEED, back);
    walk.setEffectiveWeight(walkW); idle.setEffectiveWeight(1 - walkW);
    walk.setEffectiveTimeScale(back > 0.01 ? -0.85 : Math.max(0.35, speed / WALK_SPEED));
    // heading: starts three-quarters toward the camera, turns to the door (a real 3D turn), stays facing the door when stepping back
    const heading = lerp(headingDoor + 2.4, headingDoor, smooth(1.55, 2.35, t));
    hero.rotation.y = heading + Math.PI; // this GLB's front is its local -Z
    mixer.update(i === 0 ? 0 : dt);

    // layered upper body (after the clips): look around, raise and aim the torch, flinch
    const look = (t < 2.0 ? Math.sin(t * 2.3) * 0.55 * smooth(0.2, 0.6, t) : 0) * (1 - smooth(1.7, 2.0, t));
    addRot(B.neck, 0, look * 0.45, 0, 1); addRot(B.head, -0.06, look * 0.6, 0, 1);
    const raise = smooth(5.15, 5.85, t);
    // right arm: aimed in world space (the character's forward, slightly down and across the body), forearm straight,
    // so the torch points where the character looks whatever the bone axes of the rig are
    addRot(B.spine2, 0, -0.12, 0, raise);
    hero.updateMatrixWorld(true);
    const fwd = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    const aimDir = fwd.clone().multiplyScalar(1).add(new THREE.Vector3(0, -0.12, 0)).add(new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading)).multiplyScalar(-0.12)).normalize();
    aimBone(B.rArm, B.rFore, aimDir, raise);
    aimBone(B.rFore, B.rHand, aimDir, raise);
    const flinch = smooth(7.0, 7.12, t) * (1 - smooth(7.6, 8.6, t));
    addRot(B.spine, -0.22, 0, 0, flinch); addRot(B.head, -0.25, 0.12, 0, flinch);
    addRot(B.lArm, -0.5, 0, 0.55, flinch); addRot(B.lFore, 0, 0, 1.2, flinch);
    torch.visible = t > 4.9;
    const on = smooth(5.6, 5.7, t) * (t > 8.7 ? 1 - 0.6 * smooth(8.7, 8.75, t) * (Math.sin(t * 60) > 0 ? 1 : 0.3) : 1);
    beamLight.intensity = 260 * on; beamMat.opacity = 0.03 * on; lens.visible = on > 0.1;
    eyes.visible = t > 6.85 && t < 9.2 && on > 0.5;
    inside.intensity = 3 + 30 * smooth(6.8, 7.0, t) * (1 - smooth(8.6, 9.4, t));
    // practical lamp hum: a tiny flicker
    lamp.intensity = 280 * (0.93 + 0.07 * Math.sin(t * 41) * Math.sin(t * 7.3));

    // camera: follows from behind-right at chest height, eases with lag; slight handheld drift; push-in 9-10 s
    const tgt = hero.position.clone().add(new THREE.Vector3(0, 1.35, 0));
    const push = smooth(8.9, 10, t);
    const behind = new THREE.Vector3(1.6 - 0.4 * push, 1.45 - 0.05 * push, 4.4 - 1.6 * push - 0.6 * smooth(4.5, 7, t));
    const want = hero.position.clone().add(behind);
    if (i === 0) { camPos.copy(want); camLook.copy(tgt); } else { camPos.lerp(want, 0.06); camLook.lerp(tgt, 0.1); }
    camera.position.copy(camPos).add(new THREE.Vector3(Math.sin(t * 1.3) * 0.02, Math.sin(t * 1.7 + 1) * 0.015, 0));
    camera.lookAt(camLook.clone().add(new THREE.Vector3(0, 0, 0)).add(new THREE.Vector3(-0.15, 0.05, 0)));
    camera.fov = 38 - 4 * push; camera.updateProjectionMatrix();
    // reaction camera kick
    if (t > 7.0 && t < 7.6) camera.rotation.z += 0.012 * Math.sin((t - 7) * 40) * (1 - (t - 7) / 0.6);

    // rain
    for (let k = 0; k < RAIN; k++) {
      const y = ((seeds[k * 3 + 1]! - t * 9 * (0.8 + (k % 7) * 0.05)) % 9 + 9) % 9;
      const x = seeds[k * 3]! + hero.position.x * 0.0, z = seeds[k * 3 + 2]!;
      rp.set([x, y, z, x + 0.03, y + 0.35, z], k * 6);
    }
    rainGeo.attributes.position!.needsUpdate = true;
    renderer.render(scene, camera);
  };

  return {
    renderFrame, canvas: renderer.domElement, frames,
    info: () => ({ clips: gltf.animations.map((a) => `${a.name} ${a.duration.toFixed(2)}s`), triangles: renderer.info.render.triangles, calls: renderer.info.render.calls, textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries, gl: (renderer.getContext().getParameter(renderer.getContext().VERSION) as string), walkMeters: walkLen.toFixed(2) }),
  };
}
