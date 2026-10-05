// Debug view of a puppet: the segmentation labels, the joints, and a row of poses.
//   npx tsx scripts/lab/puppet-debug.ts <raw.png> <matte.png> <out.png>
import fs from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import { makeCutout, readRgba } from "../../apps/server/src/anim/assets";
import { buildPuppet, composePuppet, restPose, segmentFigure, type PuppetPose } from "../../apps/server/src/anim/puppet";

const [rawF, matteF, out] = process.argv.slice(2);
const raw = await readRgba(rawF!), matte = await readRgba(matteF!);
const { cut, box } = makeCutout(raw, matte, true);
const seg = segmentFigure(cut, box);
const p = await buildPuppet("dbg", cut, { box });
console.log(p.report, { arms: p.armRest });
const COL = [[0, 0, 0, 0], [255, 220, 0], [80, 160, 255], [255, 60, 60], [160, 30, 30], [60, 220, 90], [20, 110, 40]];
const lab = createCanvas(cut.width, cut.height), lg = lab.getContext("2d"), d = lg.createImageData(cut.width, cut.height);
for (let i = 0; i < seg.labels.length; i++) { const c = COL[seg.labels[i]!]!; if (seg.labels[i]) { d.data[i * 4] = c[0]!; d.data[i * 4 + 1] = c[1]!; d.data[i * 4 + 2] = c[2]!; d.data[i * 4 + 3] = 255; } }
lg.putImageData(d, 0, 0);
lg.fillStyle = "#fff";
for (const [k, v] of Object.entries(seg.joints)) { lg.beginPath(); lg.arc(v.x, v.y, 5, 0, 7); lg.fill(); void k; }
const poses: Partial<PuppetPose>[] = [
  {},
  { hipN: 24, kneeN: 10, hipF: -24, kneeF: 30, shoulderN: -22, shoulderF: 22, elbowN: 10, elbowF: 25, lean: 3, coat: -3 },
  { hipN: -24, kneeN: 30, hipF: 24, kneeF: 10, shoulderN: 22, shoulderF: -22, elbowN: 25, elbowF: 10, lean: 3, coat: 3 },
  { shoulderN: 85, elbowN: 5, look: -1 },
  { shoulderN: 160, elbowN: 15, headRot: -6, lookUp: -1 },
  { hipN: 40, kneeN: 20, hipF: -40, kneeF: 70, shoulderN: -45, shoulderF: 50, elbowN: 80, elbowF: 80, lean: 12, coat: -6, hair: -6 },
];
const S = 0.55, cw = Math.round((cut.width + 2 * p.figH * 0.45) * S);
const sheet = createCanvas(cut.width * S + cw * poses.length, Math.round((p.h + p.figH * 0.9) * S)), sg = sheet.getContext("2d");
sg.fillStyle = "#3a4a5a"; sg.fillRect(0, 0, sheet.width, sheet.height);
sg.drawImage(lab, 0, p.figH * 0.45 * S + p.pad * S, cut.width * S, cut.height * S);
poses.forEach((po, i) => {
  const r = composePuppet((k, w, h) => createCanvas(w, h), `p${i}`, p, { ...restPose(), ...po });
  sg.drawImage(r.canvas, cut.width * S + i * cw, 0, r.canvas.width * S, r.canvas.height * S);
});
fs.writeFileSync(out!, sheet.toBuffer("image/png"));
