import type { SKRSContext2D } from "@napi-rs/canvas";
import type { Drawable } from "./engine";

export interface Pt { x: number; y: number }

/**
 * Draws `img` (or the sub-rectangle `src`) onto the quadrilateral TL, TR, BR, BL by slicing it into vertical strips whose top and
 * bottom follow the quad's edges: a cheap perspective transform (a door swinging toward the camera gets taller on its free edge).
 */
export function drawQuad(g: SKRSContext2D, img: Drawable, quad: [Pt, Pt, Pt, Pt], src?: { x: number; y: number; w: number; h: number }, strips = 28): void {
  const s = src ?? { x: 0, y: 0, w: img.width, h: img.height };
  const [tl, tr, br, bl] = quad;
  for (let i = 0; i < strips; i++) {
    const u0 = i / strips, u1 = (i + 1) / strips;
    const lerp = (a: Pt, b: Pt, u: number): Pt => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
    const t0 = lerp(tl, tr, u0), t1 = lerp(tl, tr, u1), b0 = lerp(bl, br, u0), b1 = lerp(bl, br, u1);
    const x0 = Math.min(t0.x, b0.x), x1 = Math.max(t1.x, b1.x);
    const top = (t0.y + t1.y) / 2, bot = (b0.y + b1.y) / 2;
    const w = Math.max(0.75, Math.abs(x1 - x0) + 0.8);
    g.drawImage(img, s.x + s.w * u0, s.y, Math.max(1, s.w / strips), s.h, Math.min(x0, x1), top, w, bot - top);
  }
}

export interface DoorDraw {
  /** Bottom-centre of the doorway on screen and its size in screen px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 closed .. 1 wide open. */
  open: number;
  hinge: "left" | "right";
  glow: string;
  leaf: Drawable;
  opacity: number;
  /** Where the camera is looking from: the door is darker and its far edge smaller when seen from the hinge side. */
  zoom: number;
}

/**
 * A door as separate pieces: a frame with a lintel and jambs, an interior (darkness that fills with warm light as the door opens),
 * the door plane swinging about its hinge in perspective, a spill of light across the floor in front of the doorway, and a soft
 * contact shadow. Nothing here is a flat rectangle that "rotates".
 */
export function drawDoor(g: SKRSContext2D, d: DoorDraw): void {
  const left = d.x - d.w / 2, top = d.y - d.h, fw = Math.max(6, d.w * 0.075);
  g.save();
  g.globalAlpha = d.opacity;
  // contact shadow on the ground
  const sh = g.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.w * 0.8);
  sh.addColorStop(0, "rgba(0,0,0,0.5)"); sh.addColorStop(1, "rgba(0,0,0,0)");
  g.save(); g.translate(d.x, d.y); g.scale(1, 0.18); g.translate(-d.x, -d.y); g.fillStyle = sh; g.fillRect(d.x - d.w, d.y - d.w, d.w * 2, d.w * 2); g.restore();
  // interior
  const inner = g.createLinearGradient(0, top, 0, d.y);
  const o = d.open;
  inner.addColorStop(0, `rgba(4,4,6,1)`);
  inner.addColorStop(0.45, mix("#050507", d.glow, Math.min(1, o * 1.1) * 0.85));
  inner.addColorStop(1, mix("#050507", d.glow, Math.min(1, o * 1.2)));
  g.fillStyle = inner;
  g.fillRect(left, top, d.w, d.h);
  // door plane, hinged at one edge, seen in perspective
  const th = o * 1.38; // up to ~79 degrees
  const hingeX = d.hinge === "left" ? left : left + d.w;
  const dir = d.hinge === "left" ? 1 : -1;
  const freeX = hingeX + dir * d.w * Math.cos(th);
  const grow = 1 + 0.16 * Math.sin(th); // the free edge swings toward the camera: taller
  const topFree = d.y - d.h * grow + (d.h * grow - d.h) * 0.0, botFree = d.y + d.h * (grow - 1) * 0.35;
  const quad: [Pt, Pt, Pt, Pt] = d.hinge === "left"
    ? [{ x: hingeX, y: top }, { x: freeX, y: topFree - 0 }, { x: freeX, y: botFree }, { x: hingeX, y: d.y }]
    : [{ x: freeX, y: topFree }, { x: hingeX, y: top }, { x: hingeX, y: d.y }, { x: freeX, y: botFree }];
  if (Math.abs(freeX - hingeX) > 1) {
    drawQuad(g, d.leaf, quad);
    // shade the leaf as it turns away from the light
    g.fillStyle = `rgba(0,0,0,${0.55 * Math.sin(th)})`;
    g.beginPath();
    quad.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.fill();
  }
  // frame: lintel + jambs drawn over the edges of the opening
  const fg = g.createLinearGradient(left - fw, 0, left + d.w + fw, 0);
  fg.addColorStop(0, "#1a1713"); fg.addColorStop(0.5, "#2a241d"); fg.addColorStop(1, "#15120f");
  g.fillStyle = fg;
  g.fillRect(left - fw, top - fw, d.w + 2 * fw, fw);
  g.fillRect(left - fw, top - fw, fw, d.h + fw);
  g.fillRect(left + d.w, top - fw, fw, d.h + fw);
  g.fillStyle = "rgba(255,230,190,0.08)";
  g.fillRect(left - fw, top - fw, d.w + 2 * fw, fw * 0.25);
  // light spilling forward over the floor
  if (o > 0.02) {
    g.globalCompositeOperation = "screen";
    const spill = g.createLinearGradient(0, d.y, 0, d.y + d.h * 0.42);
    spill.addColorStop(0, hexa(d.glow, 0.55 * o)); spill.addColorStop(1, hexa(d.glow, 0));
    g.fillStyle = spill;
    g.beginPath();
    g.moveTo(left, d.y); g.lineTo(left + d.w, d.y); g.lineTo(left + d.w + d.w * 0.7 * o, d.y + d.h * 0.42); g.lineTo(left - d.w * 0.7 * o, d.y + d.h * 0.42);
    g.closePath(); g.fill();
    const halo = g.createRadialGradient(d.x, d.y - d.h * 0.45, 0, d.x, d.y - d.h * 0.45, d.h * 0.9);
    halo.addColorStop(0, hexa(d.glow, 0.28 * o)); halo.addColorStop(1, hexa(d.glow, 0));
    g.fillStyle = halo; g.fillRect(d.x - d.h, d.y - d.h * 1.4, d.h * 2, d.h * 2);
  }
  g.restore();
}

function parse(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const v = m ? parseInt(m[1]!, 16) : 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const mix = (a: string, b: string, k: number): string => {
  const A = parse(a), B = parse(b);
  return `rgb(${Math.round(A[0] + (B[0] - A[0]) * k)},${Math.round(A[1] + (B[1] - A[1]) * k)},${Math.round(A[2] + (B[2] - A[2]) * k)})`;
};
export const hexa = (hex: string, a: number): string => { const [r, g, b] = parse(hex); return `rgba(${r},${g},${b},${a})`; };
