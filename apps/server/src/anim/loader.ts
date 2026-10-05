import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { closeAlpha, keepMainBody, keyGreyBackdrop } from "../lib/chroma";
import { decodePng } from "../lib/png";
import { HEAD_VARIANTS } from "./character";
import type { AssetLibrary, Drawable } from "./engine";
import { addHeadVariant, buildRig, type FigureAnalysis } from "./rig";

/**
 * Loads a character rig from its cut-out (`cutouts/<id>.png` + `<id>.analysis.json`) and any head variants that were drawn
 * (`heads/<id>-<name>.png`, keyed from the grey backdrop and stretched over the head crop square).
 */
export async function loadRig(lib: AssetLibrary, dir: string, id: string, rigId = id): Promise<string[]> {
  const cutout = decodePng(await fs.readFile(`${dir}/cutouts/${id}.png`));
  const meta = JSON.parse(await fs.readFile(`${dir}/cutouts/${id}.analysis.json`, "utf8")) as { analysis: FigureAnalysis; headCrop: { x: number; y: number; w: number; h: number } };
  const rig = await buildRig(rigId, cutout, { analysis: meta.analysis, nativeFacing: -1 });
  const found: string[] = [];
  for (const name of HEAD_VARIANTS) {
    const file = `${dir}/heads/${id}-${name}.png`;
    if (!existsSync(file)) continue;
    const raw = decodePng(await fs.readFile(file));
    // the backdrop is a light grey of varying brightness: key everything about as bright as its darkest border pixel (hair and denim are far darker)
    let minLum = 255;
    for (let x = 0; x < raw.width; x += 2) for (const y of [1, raw.height - 2]) { const i = (y * raw.width + x) * 4; minLum = Math.min(minLum, 0.299 * raw.data[i]! + 0.587 * raw.data[i + 1]! + 0.114 * raw.data[i + 2]!); }
    const keyed = closeAlpha(keepMainBody(keyGreyBackdrop(raw, { lumMin: Math.max(70, minLum - 28), satMax: 18, erode: 1 })), 5);
    await addHeadVariant(rig, name, keyed, meta.headCrop);
    found.push(name);
  }
  // the redrawn "front" head is crisper and cleanly keyed: use it as the neutral head too, so every head in the rig shares one hairline
  if (rig.variants.front) rig.head = rig.variants.front;
  lib.addRig(rig);
  return found;
}

/** A tall dark street-lamp silhouette with a warm glow: foreground element that sweeps past quickly (strong parallax cue). */
export function makePole(): Canvas {
  const c = createCanvas(760, 1900), g = c.getContext("2d");
  g.translate(150, 0);
  const gr = g.createLinearGradient(190, 0, 230, 0);
  gr.addColorStop(0, "#07080c"); gr.addColorStop(0.5, "#161a24"); gr.addColorStop(1, "#05060a");
  g.fillStyle = gr;
  g.fillRect(190, 180, 40, 1720); // post
  g.fillRect(170, 1830, 80, 70); // base
  g.fillRect(205, 110, 150, 18); // arm
  g.fillStyle = "#0a0c12";
  g.beginPath(); g.moveTo(330, 118); g.lineTo(390, 118); g.lineTo(372, 150); g.lineTo(348, 150); g.closePath(); g.fill(); // lamp hood
  const glow = g.createRadialGradient(360, 150, 0, 360, 150, 190);
  glow.addColorStop(0, "rgba(255,214,150,0.95)"); glow.addColorStop(0.18, "rgba(255,190,110,0.5)"); glow.addColorStop(1, "rgba(255,170,90,0)");
  g.globalCompositeOperation = "lighter";
  g.fillStyle = glow; g.fillRect(0, -200, 760, 700);
  return c;
}

/** A dark wooden door leaf with panels and a handle (hinged at its left edge when drawn with `door.hinge = "left"`). */
export function makeDoorLeaf(w = 300, h = 620): Canvas {
  const c = createCanvas(300, 620), g = c.getContext("2d");
  const gr = g.createLinearGradient(0, 0, 300, 0);
  gr.addColorStop(0, "#2a1b12"); gr.addColorStop(0.5, "#3a261a"); gr.addColorStop(1, "#22150e");
  g.fillStyle = gr; g.fillRect(0, 0, 300, 620);
  g.strokeStyle = "rgba(0,0,0,0.55)"; g.lineWidth = 6;
  for (const [x, y, w, h] of [[34, 36, 232, 230], [34, 300, 232, 280]] as const) {
    g.strokeRect(x, y, w, h);
    g.strokeStyle = "rgba(255,220,180,0.10)"; g.lineWidth = 3; g.strokeRect(x + 4, y + 4, w - 8, h - 8); g.strokeStyle = "rgba(0,0,0,0.55)"; g.lineWidth = 6;
  }
  g.fillStyle = "#b99a62"; g.beginPath(); g.arc(256, 330, 11, 0, Math.PI * 2); g.fill();
  if (w === 300 && h === 620) return c;
  const out = createCanvas(w, h);
  out.getContext("2d").drawImage(c, 0, 0, w, h);
  return out;
}

/** The hand-held phone with its screen lit: a bright cool gradient with message lines, drawn over the dark screen quad. */
export async function makeLitPhone(src: Drawable, quad: [number, number][], message?: { from: string; lines: string[] }): Promise<Canvas> {
  const c = createCanvas(src.width, src.height), g = c.getContext("2d");
  g.drawImage(src, 0, 0);
  g.save();
  g.beginPath();
  quad.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.clip();
  const ys = quad.map((q) => q[1]), xs = quad.map((q) => q[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, "#e8f6ff"); gr.addColorStop(0.5, "#8fd0ff"); gr.addColorStop(1, "#3d8fe8");
  g.fillStyle = gr;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  g.fillStyle = "rgba(20,60,120,0.55)";
  const w = x1 - x0, h = y1 - y0;
  if (message) {
    g.fillStyle = "rgba(10,40,90,0.9)";
    g.font = `bold ${Math.round(h * 0.045)}px Helvetica`;
    g.fillText(message.from, x0 + w * 0.1, y0 + h * 0.1);
    g.fillStyle = "rgba(255,255,255,0.96)";
    g.fillRect(x0 + w * 0.06, y0 + h * 0.16, w * 0.88, h * 0.42);
    g.fillStyle = "#c01818";
    g.font = `bold ${Math.round(h * 0.062)}px Helvetica`;
    message.lines.forEach((ln, i) => g.fillText(ln, x0 + w * 0.12, y0 + h * (0.26 + i * 0.1)));
    g.restore();
    return c;
  }
  g.fillRect(x0 + w * 0.12, y0 + h * 0.10, w * 0.5, h * 0.035); // sender
  for (const [yy, ww] of [[0.2, 0.76], [0.26, 0.6], [0.32, 0.68]] as const) g.fillRect(x0 + w * 0.12, y0 + h * yy, w * ww, h * 0.028); // message lines
  g.fillStyle = "rgba(255,255,255,0.92)";
  g.fillRect(x0 + w * 0.12, y0 + h * 0.5, w * 0.76, h * 0.12); // notification card
  g.fillStyle = "rgba(255,70,70,0.9)";
  g.beginPath(); g.arc(x0 + w * 0.2, y0 + h * 0.56, h * 0.025, 0, Math.PI * 2); g.fill();
  g.restore();
  return c;
}

/** A hand torch, drawn: handle on the left, lens on the right (grip at x 0.3, pointing along +x). */
export function makeFlashlight(w = 320, h = 90): Canvas {
  const c = createCanvas(w, h), g = c.getContext("2d");
  const body = g.createLinearGradient(0, h * 0.25, 0, h * 0.75);
  body.addColorStop(0, "#5b5f66"); body.addColorStop(0.45, "#2a2d33"); body.addColorStop(1, "#141518");
  g.fillStyle = body;
  g.beginPath(); g.roundRect(4, h * 0.3, w * 0.62, h * 0.4, h * 0.12); g.fill();
  // head flares out toward the lens
  g.beginPath(); g.moveTo(w * 0.6, h * 0.28); g.lineTo(w * 0.86, h * 0.08); g.lineTo(w * 0.94, h * 0.08); g.lineTo(w * 0.94, h * 0.92); g.lineTo(w * 0.86, h * 0.92); g.lineTo(w * 0.6, h * 0.72); g.closePath(); g.fill();
  g.fillStyle = "#c9a54a"; g.fillRect(w * 0.28, h * 0.3, w * 0.03, h * 0.4); // switch ring
  const lens = g.createLinearGradient(w * 0.94, 0, w, 0);
  lens.addColorStop(0, "#fff6d8"); lens.addColorStop(1, "#ffe9a8");
  g.fillStyle = lens; g.fillRect(w * 0.94, h * 0.1, w * 0.06, h * 0.8);
  g.strokeStyle = "rgba(255,255,255,0.18)"; g.lineWidth = 2; g.beginPath(); g.moveTo(10, h * 0.36); g.lineTo(w * 0.6, h * 0.36); g.stroke();
  return c;
}

/** A phone held in the hand, screen lit (portrait; grip at the lower middle, pointing up along -y = axis -90). */
export function makeHeldPhone(w = 120, h = 230): Canvas {
  const c = createCanvas(w, h), g = c.getContext("2d");
  g.fillStyle = "#16181c"; g.beginPath(); g.roundRect(0, 0, w, h, 16); g.fill();
  const gr = g.createLinearGradient(0, 10, 0, h - 10);
  gr.addColorStop(0, "#e8f6ff"); gr.addColorStop(0.5, "#8fd0ff"); gr.addColorStop(1, "#3d8fe8");
  g.fillStyle = gr; g.beginPath(); g.roundRect(7, 12, w - 14, h - 24, 9); g.fill();
  g.fillStyle = "rgba(255,255,255,0.9)"; g.fillRect(16, h * 0.42, w - 32, h * 0.12);
  g.fillStyle = "rgba(20,60,120,0.55)"; for (const y of [0.2, 0.26, 0.32]) g.fillRect(16, h * y, (w - 32) * 0.8, h * 0.025);
  return c;
}
