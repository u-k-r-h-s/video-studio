import fs from "node:fs";
import { Three3DRenderer } from "../../../../apps/server/src/anim/renderers/three3d/index";
import { characterFile } from "../../../../apps/server/src/anim/renderers/three3d/library";
const night = process.argv[2] === "night";
const parked = [{ kind: "bus", x: -15, z: -1.6, heading: 0 }, { kind: "car", x: -6.5, z: -1.4, heading: 0 }, { kind: "car", x: -1.5, z: -1.4, heading: Math.PI }, { kind: "auto", x: 3, z: -1.4, heading: 0 }, { kind: "motorcycle", x: 6.2, z: -1.4, heading: 0 }, { kind: "scooter", x: 8.6, z: -1.4, heading: Math.PI }, { kind: "bicycle", x: 10.8, z: -1.4, heading: 0 }];
const spec = (pos: [number, number, number], look: [number, number, number]) => ({
  id: "show", duration: 0.2, width: 1080, height: 1920, fps: 30, seed: 7, lighting: night ? "rainy-night" : "sunny-day", sunAzimuth: 35,
  environment: { kind: "road", objects: [{ id: "door", kind: "door", x: 0, z: -8, params: { width: 1, height: 2.1, hinge: "left" } }], weather: { rain: night ? 0.6 : 0 },
    world: { traffic: { mix: ["car"], rate: 0.01, lanes: 2, parked } } },
  characters: [{ id: "arjun", asset: "rb-young-man", start: { x: 13.5, z: 1.4, heading: 0.4 }, events: [] }],
  camera: { shot: "medium", move: "static", target: "arjun", fixed: { position: pos, lookAt: look, fov: 40 } },
});
const r = new Three3DRenderer({ characterFile, imageFile: (k) => k });
// three-quarter views from the pavement at story distances (4-9 m), eye height
const views: [string, [number, number, number], [number, number, number]][] = [["bus", [-4, 1.7, 9.5], [-14, 1.4, -1.6]], ["car1", [-2.2, 1.6, 6.2], [-6.5, 0.7, -1.4]], ["car2", [1.6, 1.6, 6.0], [-1.5, 0.7, -1.4]], ["auto", [5.8, 1.6, 4.8], [3, 0.9, -1.4]], ["moto", [8.0, 1.5, 3.6], [6.2, 0.7, -1.4]], ["scooter", [6.4, 1.5, 3.4], [8.6, 0.7, -1.4]], ["bicycle", [12.6, 1.5, 3.4], [10.8, 0.75, -1.4]]];
for (const [name, pos, look] of views) {
  const res = await r.stills(spec(pos, look) as never, [3]);
  fs.writeFileSync(`projects/v4-proof/lineup-${night ? "night" : "day"}-${name}.png`, res.frames.get(3)!);
}
await r.close();
