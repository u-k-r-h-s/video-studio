import * as THREE from "three";
import type { PropKind3D, PropSpec3D } from "../spec";
import { glowSprite, lightShaft } from "./effects";

/**
 * Props and the generic attachment system. A prop is a small model with a GRIP (the point the hand holds, at its origin) and
 * a pointing axis (+X). Each frame the character places every attached prop at its socket (hand / back / hip) in WORLD space,
 * aligned with the bone chain (forearm direction for a hand), so it works with any rig whatever its bone axes and scale.
 * A prop can carry a light (flashlight beam, phone screen): it is part of the prop, not of the renderer.
 */
export interface Prop3D {
  id: string;
  kind: PropKind3D;
  socket: PropSpec3D["socket"];
  object: THREE.Group;
  /** 0..1, for props with a light. */
  setOn(v: number): void;
  on: number;
  /** Light the prop emits (for the beam's target/shadows). */
  light?: THREE.SpotLight;
}

const mat = (color: string, o: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2, ...o });

function flashlight(color = "#26292e"): { g: THREE.Group; light: THREE.SpotLight; setOn: (v: number) => void } {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.017, 0.17, 18), mat(color, { metalness: 0.75, roughness: 0.35 }));
  body.rotation.z = -Math.PI / 2; body.position.x = 0.04; g.add(body);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.02, 0.05, 20), mat(color, { metalness: 0.8, roughness: 0.3 }));
  head.rotation.z = -Math.PI / 2; head.position.x = 0.14; g.add(head);
  const lensMat = new THREE.MeshBasicMaterial({ color: "#fff6dc" });
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.027, 20), lensMat); lens.position.x = 0.166; lens.rotation.y = Math.PI / 2; g.add(lens);
  const light = new THREE.SpotLight("#fff2d6", 0, 22, 0.3, 0.45, 1.4);
  light.position.set(0.17, 0, 0); light.castShadow = true; light.shadow.mapSize.set(1024, 1024); light.shadow.bias = -0.0005;
  const target = new THREE.Object3D(); target.position.set(6, 0, 0); g.add(target); light.target = target; g.add(light);
  const shaft = lightShaft("#fff1cf", 7, 1.15, 0); shaft.rotation.z = -Math.PI / 2; shaft.position.x = 0.17; g.add(shaft);
  const halo = glowSprite("#fff4dc", 0.12); halo.position.x = 0.19; g.add(halo);
  const setOn = (v: number): void => { light.intensity = 160 * v; shaft.setIntensity(0.32 * v); halo.visible = v > 0.05; (halo.material as THREE.SpriteMaterial).opacity = v; lensMat.color.set(v > 0.05 ? "#fffbe8" : "#5d5a52"); };
  setOn(0);
  return { g, light, setOn };
}

function phone(): { g: THREE.Group; light: THREE.SpotLight; setOn: (v: number) => void } {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.15, 0.009), mat("#15171b", { metalness: 0.6, roughness: 0.25 }));
  body.position.y = 0.06; g.add(body);
  const screenMat = new THREE.MeshBasicMaterial({ color: "#9fd0ff" });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.066, 0.135), screenMat); screen.position.set(0, 0.06, 0.0051); g.add(screen);
  const light = new THREE.SpotLight("#9fd0ff", 0, 2.5, 1.1, 0.8, 2); light.position.set(0, 0.06, 0.02);
  const target = new THREE.Object3D(); target.position.set(0, 0.06, 1); g.add(target); light.target = target; g.add(light);
  const setOn = (v: number): void => { light.intensity = 6 * v; screenMat.color.set(v > 0.05 ? "#bfe3ff" : "#101215"); };
  setOn(1);
  return { g, light, setOn };
}

function simple(kind: PropKind3D, color?: string): THREE.Group {
  const g = new THREE.Group();
  switch (kind) {
    case "bag": { // a courier bag: box body, flap, strap
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.12), mat(color ?? "#c8682a", { roughness: 0.8 })); b.position.set(0, -0.12, -0.09); g.add(b);
      const flap = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.09, 0.13), mat("#20242a", { roughness: 0.7 })); flap.position.set(0, -0.02, -0.09); g.add(flap);
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.55, 0.012), mat("#20242a")); strap.position.set(0.05, 0.1, -0.02); strap.rotation.z = 0.75; g.add(strap); // diagonal across the back, over the shoulder
      break;
    }
    case "box": { const b = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.22, 0.24), mat(color ?? "#b0844f", { roughness: 0.9 })); b.position.x = 0.12; g.add(b); const tape = new THREE.Mesh(new THREE.BoxGeometry(0.325, 0.223, 0.05), mat("#d9c08a", { roughness: 0.4 })); tape.position.x = 0.12; g.add(tape); break; }
    case "keys": { const ring = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.003, 6, 18), mat("#c9c9c9", { metalness: 1, roughness: 0.25 })); g.add(ring); for (let i = 0; i < 3; i++) { const k = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.003), mat(i ? "#b79a4b" : "#c9c9c9", { metalness: 1, roughness: 0.3 })); k.position.set(0.035, -0.01 * i, 0); k.rotation.z = -0.3 + i * 0.3; g.add(k); } break; }
    case "tool": { const h = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 10), mat(color ?? "#8a1f1f", { roughness: 0.6 })); h.rotation.z = -Math.PI / 2; h.position.x = 0.06; g.add(h); const hd = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.07, 0.015), mat("#9aa0a8", { metalness: 1, roughness: 0.3 })); hd.position.x = 0.18; g.add(hd); break; }
    case "weapon": { const h = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.5, 12), mat(color ?? "#1d1f24", { metalness: 0.5, roughness: 0.45 })); h.rotation.z = -Math.PI / 2; h.position.x = 0.2; g.add(h); break; }
    default: { const b = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), mat(color ?? "#7d8590")); b.position.x = 0.06; g.add(b); }
  }
  return g;
}

export function makeProp(spec: PropSpec3D): Prop3D {
  let object: THREE.Group, setOn: (v: number) => void = () => {}, light: THREE.SpotLight | undefined;
  if (spec.kind === "flashlight") ({ g: object, setOn, light } = flashlight(spec.color));
  else if (spec.kind === "phone") ({ g: object, setOn, light } = phone());
  else object = simple(spec.kind, spec.color);
  object.name = `prop:${spec.id}`;
  object.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !(m.material instanceof THREE.ShaderMaterial) && !(m.material instanceof THREE.MeshBasicMaterial)) { m.castShadow = true; m.receiveShadow = true; } });
  const p: Prop3D = { id: spec.id, kind: spec.kind, socket: spec.socket, object, light, on: 0, setOn: (v) => { p.on = v; setOn(v); } };
  p.setOn(spec.on === false ? 0 : spec.kind === "phone" ? 1 : 0);
  return p;
}

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), m4 = new THREE.Matrix4();
/**
 * Places a prop at its socket. Hand: grip at the hand bone, +X along the forearm (elbow -> hand) continued, +Y toward the
 * character's up. Back / hip: on the chest / hips, facing backwards / sideways.
 */
export function placeProp(p: Prop3D, sock: { hand?: THREE.Object3D; elbow?: THREE.Object3D; chest?: THREE.Object3D; hips?: THREE.Object3D; root: THREE.Object3D }, palmOffset = 0.06): void {
  const o = p.object;
  if ((p.socket === "rightHand" || p.socket === "leftHand") && sock.hand && sock.elbow) {
    sock.hand.getWorldPosition(v1); sock.elbow.getWorldPosition(v2);
    const dir = v3.subVectors(v1, v2).normalize();
    // the fist sits a little beyond the wrist bone
    const grip = v1.clone().addScaledVector(dir, palmOffset);
    const up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(dir.dot(up)) > 0.95) up.set(0, 0, 1);
    const z = new THREE.Vector3().crossVectors(dir, up).normalize();
    const y = new THREE.Vector3().crossVectors(z, dir).normalize();
    m4.makeBasis(dir, y, z);
    o.quaternion.setFromRotationMatrix(m4);
    o.position.copy(grip);
  } else if (p.socket === "back" && sock.chest) {
    sock.chest.getWorldPosition(v1);
    o.quaternion.copy(sock.root.getWorldQuaternion(new THREE.Quaternion()));
    o.position.copy(v1).add(new THREE.Vector3(0, -0.08, -0.13).applyQuaternion(o.quaternion));
  } else if (p.socket === "hip" && sock.hips) {
    sock.hips.getWorldPosition(v1);
    o.quaternion.copy(sock.root.getWorldQuaternion(new THREE.Quaternion()));
    o.position.copy(v1).add(new THREE.Vector3(0.2, -0.05, 0).applyQuaternion(o.quaternion));
  }
  o.updateMatrixWorld(true);
}
