/**
 * Test 5: motion across a render-chunk boundary. Renders a shot continuously, then renders it again as two chunks
 * (frames [0, cut) and [cut, end), each from a fresh set-up; the second fast-forwards without drawing), and compares every
 * frame byte for byte. Also writes the two-chunk video, and a strip of the frames around the cut.
 * Usage: npx tsx scripts/lab/three3d/v3/chunk-test.ts <spec.json> <cut frame> <out.mp4>
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { Three3DRenderer } from "../../../../apps/server/src/anim/renderers/three3d/index";
import { characterFile } from "../../../../apps/server/src/anim/renderers/three3d/library";
const [file, cutS, out] = process.argv.slice(2) as [string, string, string];
const spec = JSON.parse(fs.readFileSync(file, "utf8")); delete spec._voice;
const total = Math.round(spec.duration * spec.fps), cut = Number(cutS);
const r = new Three3DRenderer({ characterFile, imageFile: (k) => k });
const t0 = Date.now();
const full = await r.stills(spec, Array.from({ length: total }, (_, i) => i));
const tFull = (Date.now() - t0) / 1000, t1 = Date.now();
const a = await r.renderRange(spec, 0, cut), b = await r.renderRange(spec, cut, total);
const tChunks = (Date.now() - t1) / 1000;
await r.close();
const chunked = [...a, ...b];
let same = 0; const diff: number[] = [];
chunked.forEach((png, i) => (png.equals(full.frames.get(i)!) ? same++ : diff.push(i)));
const dir = fs.mkdtempSync("/tmp/chunk-"); chunked.forEach((png, i) => fs.writeFileSync(`${dir}/${String(i).padStart(4, "0")}.png`, png));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(spec.fps), "-i", `${dir}/%04d.png`, "-c:v", "h264_videotoolbox", "-b:v", "8M", "-pix_fmt", "yuv420p", out]);
console.log(`${total} frames; cut at ${cut}; chunked == continuous: ${same}/${total} byte-identical${diff.length ? `; differ: ${diff.slice(0, 10).join(",")}` : ""}`);
console.log(`continuous ${tFull.toFixed(1)} s, two chunks ${tChunks.toFixed(1)} s (the second fast-forwards ${cut} frames without drawing)`);
console.log(`frames: ${dir}`);
