// Turns generated pictures into engine assets: keyed cut-outs, the character's rig analysis and its head crop.
//   npx tsx scripts/lab/anim-prep.ts <character-id> [prop-id ...]
import fs from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { analyzeFigure, headCropRect } from "../../apps/server/src/anim/rig";
import { keepMainBody, keyGreyBackdrop } from "../../apps/server/src/lib/chroma";
import { cropToContent, decodePng, encodePng } from "../../apps/server/src/lib/png";

const A = "/Users/apple/Desktop/ai-studio-feasibility/projects/anim-lab";
fs.mkdirSync(`${A}/cutouts`, { recursive: true });
const [charId, ...props] = process.argv.slice(2);
const cut = (id: string, opts: Parameters<typeof keyGreyBackdrop>[1] = {}) => {
  const img = decodePng(fs.readFileSync(`${A}/assets/${id}.png`));
  const k = cropToContent(keepMainBody(keyGreyBackdrop(img, opts)), 20, 2);
  fs.writeFileSync(`${A}/cutouts/${id}.png`, encodePng(k));
  console.log(`cutout ${id}: ${k.width}x${k.height}`);
  return k;
};
const ch = cut(charId!, { erode: 2 });
const a = analyzeFigure(ch);
const rect = headCropRect(a);
fs.writeFileSync(`${A}/cutouts/${charId}.analysis.json`, JSON.stringify({ analysis: a, headCrop: rect }, null, 1));
console.log("analysis", JSON.stringify({ neckY: a.neckY, hipY: a.hipY, crotchY: a.crotchY, splitX: a.splitX, hipLx: Math.round(a.hipLx), hipRx: Math.round(a.hipRx), headRect: a.headRect, rect }));
// head crop over a flat grey backdrop, 512x512, for the expression variants (img2img)
const img = await loadImage(encodePng(ch));
const c = createCanvas(512, 512), g = c.getContext("2d");
g.fillStyle = "#ececec";
g.fillRect(0, 0, 512, 512);
g.scale(512 / rect.w, 512 / rect.h);
g.translate(-rect.x, -rect.y);
g.drawImage(img, 0, 0);
fs.writeFileSync(`${A}/cutouts/${charId}.headcrop.png`, c.toBuffer("image/png"));
for (const p of props) cut(p, p.includes("hand") ? { lumMin: 40 } : {});
