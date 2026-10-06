// Character pose lab: one character, a scripted list of semantic events, a fixed side camera -> a contact sheet.
//   npx tsx scripts/lab/three3d/pose-lab.ts <out.png> <t1,t2,...> '<events json>' [props json]
import fs from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Three3DRenderer } from "../../../apps/server/src/anim/renderers/three3d";
import { characterFile } from "../../../apps/server/src/anim/renderers/three3d/library";
import type { Shot3DSpec } from "../../../apps/server/src/anim/renderers/three3d/spec";

const [out, ts, evJson, propsJson, camJson] = process.argv.slice(2);
const times = ts!.split(",").map(Number);
const spec: Shot3DSpec = {
  id: "lab", duration: Math.max(...times) + 0.1, width: 540, height: 960, fps: 30, seed: 1, lighting: "day",
  environment: { kind: "warehouse-exterior", objects: [{ id: "door", kind: "door", x: 0, z: -8 }] },
  characters: [{ id: "a", asset: "casual-man", start: { x: 0, z: -3, heading: Math.PI / 2 }, props: JSON.parse(propsJson ?? "[]"), events: JSON.parse(evJson!) }],
  camera: JSON.parse(camJson ?? '{"shot":"wide","move":"static","target":"a","side":1,"handheld":0}'),
};
const r = new Three3DRenderer({ characterFile });
try {
  const res = await r.stills(spec, times.map((t) => Math.round(t * 30)));
  const W = 270, H = 480, sheet = createCanvas(W * times.length, H), g = sheet.getContext("2d");
  let i = 0;
  for (const t of times) { const img = await loadImage(res.frames.get(Math.round(t * 30))!); g.drawImage(img, i * W, 0, W, H); g.fillStyle = "#fff"; g.font = "16px sans-serif"; g.fillText(`${t}s`, i * W + 6, 18); i++; }
  fs.writeFileSync(out!, sheet.toBuffer("image/png"));
  console.log(JSON.stringify(res.info.characters));
} finally { await r.close(); }
