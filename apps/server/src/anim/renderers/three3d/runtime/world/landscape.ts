import * as THREE from "three";
import type { KitCtx, Clamp } from "../kits";
import type { WorldSpec3D } from "../../spec";
import { forest, grass, lake, river, sea, terrain, waterfall, type Terrain, type WorldCtx } from "./nature";

/**
 * The open-country kit: the action stands on level ground (a meadow, a riverbank, a beach) in front of the camera; behind
 * it, what the story's place calls for: a river, a lake, the sea, a waterfall in the hills; forests (conifers in the
 * mountains, palms by the sea, broadleaf elsewhere), grass, crop fields; hills or snow-capped mountains on the horizon,
 * with haze for depth. No door, no house: the named set points simply do not exist here.
 */
type Landscape = NonNullable<WorldSpec3D["landscape"]>;

export function natureKit(ctx: KitCtx, w: WorldCtx, L: Landscape): { clamp: Clamp; terrain: Terrain; info: Record<string, number | string> } {
  ctx.ground.visible = false;
  const info: Record<string, number | string> = { relief: L.relief, water: L.water ?? "none" };
  const riverZ = (x: number): number => -15 + 4 * Math.sin(x / 37 + 1) + 1.5 * Math.sin(x / 13);
  const pad = { x: 0, z: 3, rx: 16, rz: 9 };
  const hasRiver = L.water === "river" || L.water === "waterfall";
  const lakeShape = L.water === "lake" ? { cx: 0, cz: -62, rx: 130, rz: 38 } : undefined;
  const shoreZ = L.water === "sea" ? -9 : undefined;
  const t = terrain(w, {
    relief: L.water === "sea" ? "flat" : L.relief, pad, snow: L.snow,
    ...(hasRiver ? { river: { z: riverZ, width: 13 } } : {}), ...(lakeShape ? { lake: lakeShape } : {}), ...(shoreZ !== undefined ? { sea: { shoreZ } } : {}),
    ...(L.water === "sea" ? { palette: { grass: "#7f8f4a", dry: "#b8a66a" } } : {}),
  });
  if (hasRiver) river(w, t, { z: riverZ, width: 13 });
  if (lakeShape) lake(w, t, lakeShape);
  if (shoreZ !== undefined) sea(w, t, { shoreZ });
  if (L.water === "waterfall") waterfall(w, t, { x: 26, z: -58, height: 24, width: 6 });

  const inWater = (x: number, z: number): boolean =>
    (hasRiver && Math.abs(z - riverZ(x)) < 9.5) || (!!lakeShape && Math.hypot((x - lakeShape.cx) / lakeShape.rx, (z - lakeShape.cz) / lakeShape.rz) < 1.15) || (shoreZ !== undefined && z < shoreZ + 3);
  const onStage = (x: number, z: number): boolean => Math.hypot((x - pad.x) / (pad.rx * 0.9), (z - pad.z) / (pad.rz * 0.9)) < 1;
  const inView = (x: number, z: number): boolean => z > 12 && Math.abs(x) < 30; // between the camera and the actors
  const free = (x: number, z: number): boolean => !inWater(x, z) && !onStage(x, z) && !inView(x, z);

  const kind = L.palms || L.water === "sea" ? "palm" : L.relief === "mountains" || L.snow ? "conifer" : "broadleaf";
  const density = L.forest ?? 0.5;
  if (density > 0) {
    // the forest climbs the far slopes (it frames the mountains instead of hiding them); near the water only clumps
    info.treesFar = forest(w, t, { kind, count: Math.round(900 * density), area: { x0: -230, x1: 230, z0: -200, z1: -40 }, free, scale: [0.9, 1.7] });
    info.treesNear = forest(w, t, { kind, count: Math.round(45 * density), area: { x0: -80, x1: 80, z0: -32, z1: 26 }, free: (x, z) => free(x, z) && Math.abs(x) > 19, scale: [0.9, 1.4] });
    if (kind === "conifer") info.broadleaf = forest(w, t, { kind: "broadleaf", count: Math.round(40 * density), area: { x0: -90, x1: 90, z0: -36, z1: 25 }, free: (x, z) => free(x, z) && Math.abs(x) > 17, scale: [0.8, 1.2] });
  }
  if ((L.grass ?? 0.7) > 0 && L.water !== "sea") info.grassBlades = grass(w, t, { count: Math.round(30000 * (L.grass ?? 0.7)), area: { x0: -24, x1: 24, z0: -9, z1: 13 }, free: (x, z) => !inWater(x, z) });
  if (L.crop) info.cropPlants = grass(w, t, { count: 22000, crop: L.crop, area: { x0: -70, x1: 70, z0: hasRiver ? -60 : -40, z1: hasRiver ? -24 : -11 }, free: (x, z) => !inWater(x, z) });
  // aerial perspective: distant land fades into the sky colour (the presets leave clear days without haze)
  const scene = w.scene;
  if (!(scene.fog instanceof THREE.FogExp2) || scene.fog.density < 0.004) {
    const warm = w.sunDir.y < 0.35 && w.day;
    // light haze: the mountains (150-280 m) keep their form and fade a little toward the sky colour
    scene.fog = new THREE.Fog(w.day ? (warm ? "#e3c9a8" : "#c5d4e2") : "#0d1522", 160, 720);
  }
  return {
    terrain: t, info,
    clamp: (p) => {
      if (hasRiver && p.z < riverZ(p.x) + 8) p.z = riverZ(p.x) + 8;
      if (shoreZ !== undefined && p.z < shoreZ + 2) p.z = shoreZ + 2;
      const g = t.height(p.x, p.z) + 0.4; if (p.y < g) p.y = g;
    },
  };
}
