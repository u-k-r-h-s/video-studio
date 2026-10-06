import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * How a character model is presented, whatever generator made it: smooth shading on faceted low-poly meshes, a material
 * response per material kind (skin, hair, eyes, cloth, leather, metal, glass) instead of one generic plastic, and a soft
 * contact shadow under the feet so the figure sits on the ground. All by names and colours, nothing model-specific.
 */
export type MaterialKind = "skin" | "hair" | "eye" | "cloth" | "leather" | "metal" | "glass" | "rubber";
export function materialKind(name: string, color?: THREE.Color): MaterialKind {
  const n = name.toLowerCase();
  if (/skin|face|body_?skin|flesh/.test(n)) return "skin";
  if (/hair|beard|brow|lash/.test(n)) return "hair";
  if (/eye|iris|pupil|cornea/.test(n)) return "eye";
  if (/glass|lens|visor/.test(n)) return "glass";
  if (/metal|steel|iron|chrome|buckle|zip/.test(n)) return "metal";
  if (/leather|boot|belt|jacket|coat/.test(n)) return "leather";
  if (/shoe|sole|rubber|sneaker/.test(n)) return "rubber";
  if (color && color.r > 0.3 && color.g > 0.18 && color.b < color.g && color.r > color.b * 1.6 && /white|light|brown/.test(n) === false) return "cloth";
  return "cloth";
}

const RESPONSE: Record<MaterialKind, { roughness: number; metalness: number; envMapIntensity: number; sheen?: number }> = {
  skin: { roughness: 0.6, metalness: 0, envMapIntensity: 0.45 },
  hair: { roughness: 0.5, metalness: 0, envMapIntensity: 0.5, sheen: 0.3 },
  eye: { roughness: 0.12, metalness: 0, envMapIntensity: 1.2 },
  cloth: { roughness: 0.88, metalness: 0, envMapIntensity: 0.45, sheen: 0.35 },
  leather: { roughness: 0.55, metalness: 0.05, envMapIntensity: 0.8 },
  metal: { roughness: 0.32, metalness: 0.9, envMapIntensity: 1.2 },
  glass: { roughness: 0.06, metalness: 0, envMapIntensity: 1.5 },
  rubber: { roughness: 0.75, metalness: 0, envMapIntensity: 0.4 },
};

/** True when a mesh is flat-shaded (vertices duplicated per face so each face has its own normal). */
function isFaceted(g: THREE.BufferGeometry): boolean {
  const pos = g.getAttribute("position"), nrm = g.getAttribute("normal");
  if (!pos || !nrm) return false;
  const seen = new Map<string, number[]>();
  let split = 0, shared = 0;
  for (let i = 0; i < Math.min(pos.count, 6000); i++) {
    const k = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    const n = [nrm.getX(i), nrm.getY(i), nrm.getZ(i)];
    const prev = seen.get(k);
    if (!prev) { seen.set(k, n); continue; }
    shared++;
    if (prev[0]! * n[0]! + prev[1]! * n[1]! + prev[2]! * n[2]! < 0.98) split++;
  }
  return shared > 50 && split / shared > 0.5;
}

export function presentModel(model: THREE.Object3D, opts: { smooth?: boolean } = {}): { smoothed: number; materials: Record<string, MaterialKind> } {
  let smoothed = 0;
  const kinds: Record<string, MaterialKind> = {};
  const done = new Map<THREE.Material, THREE.Material>();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (opts.smooth !== false && isFaceted(m.geometry)) {
      // merge the duplicated corners (skin weights are equal there) and let the normals average: no more facets
      const g = m.geometry.clone();
      g.deleteAttribute("normal");
      const merged = mergeVertices(g, 1e-4);
      merged.computeVertexNormals();
      m.geometry = merged;
      smoothed++;
    }
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const out = mats.map((mt) => {
      const have = done.get(mt);
      if (have) return have;
      const src = mt as THREE.MeshStandardMaterial;
      const kind = materialKind(src.name, src.color);
      kinds[src.name] = kind;
      const r = RESPONSE[kind];
      const phys = new THREE.MeshPhysicalMaterial({
        name: src.name, color: src.color?.clone() ?? new THREE.Color("#888"), map: src.map ?? null, normalMap: src.normalMap ?? null,
        roughness: r.roughness, metalness: r.metalness, envMapIntensity: r.envMapIntensity,
        ...(r.sheen ? { sheen: r.sheen, sheenRoughness: 0.8, sheenColor: src.color?.clone() } : {}),
        ...(kind === "eye" || kind === "glass" ? { clearcoat: 1, clearcoatRoughness: 0.05 } : {}),
      } as THREE.MeshPhysicalMaterialParameters);
      done.set(mt, phys);
      return phys;
    });
    m.material = Array.isArray(m.material) ? out : out[0]!;
  });
  return { smoothed, materials: kinds };
}

/** A soft contact shadow (ambient occlusion where the feet meet the ground): a radial gradient decal that follows the character. */
export function contactShadow(size = 1): THREE.Mesh {
  const n = 64, d = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const r = Math.hypot((x - n / 2 + 0.5) / (n / 2), (y - n / 2 + 0.5) / (n / 2));
    d.set([0, 0, 0, Math.round(Math.max(0, 1 - r) ** 1.6 * 255)], (y * n + x) * 4);
  }
  const tex = new THREE.DataTexture(d, n, n); tex.needsUpdate = true;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.55, color: "#000000" }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.012; m.renderOrder = 1;
  return m;
}
