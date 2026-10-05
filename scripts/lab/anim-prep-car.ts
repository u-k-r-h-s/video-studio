// Side-view car silhouette for background traffic: keys the dark studio backdrop, drops the floor, and fills the windows.
import fs from "node:fs";
import { closeAlpha, keepMainBody, keyGreyBackdrop } from "../../apps/server/src/lib/chroma";
import { cropToContent, decodePng, encodePng } from "../../apps/server/src/lib/png";

const A = "/Users/apple/Desktop/ai-studio-feasibility/projects/anim-lab";
const img = decodePng(fs.readFileSync(`${A}/assets/prop-carside-503.png`));
const k = keepMainBody(keyGreyBackdrop(img, { lumMin: 36, satMax: 20, erode: 1 }));
// the car sits in the upper part of the picture; the rest is floor shadow
const rows = Math.round(img.height * 0.70);
const top = { width: k.width, height: rows, data: k.data.slice(0, k.width * rows * 4) };
const out = cropToContent(closeAlpha(keepMainBody(top), 14), 20, 2);
fs.writeFileSync(`${A}/cutouts/prop-car.png`, encodePng(out));
console.log("car", out.width, out.height);
