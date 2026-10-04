import type { Easing, Motion } from "@studio/shared";

/**
 * Compiles motion primitives into FFmpeg filter expressions.
 *
 * Every primitive contributes a value that is its `from` before `start`, eases to `to` between start and end, and
 * holds `to` afterwards. Per layer: translate/shake/pulse(x|y) are ADDITIVE offsets, scale/pulse(scale) are
 * MULTIPLICATIVE factors, so independent primitives compose without knowing about each other.
 *
 * `T` is the time variable in the target filter: "t" for overlay/scale, "(on/FPS)" for zoompan.
 */
const f = (n: number): string => {
  const s = Number(n.toFixed(6)).toString();
  return s.startsWith("-") ? `(${s})` : s;
};

/** Eased progress 0..1 as an FFmpeg expression. */
export function progress(T: string, start: number, end: number, easing: Easing): string {
  const u = end > start ? `clip((${T}-${f(start)})/${f(end - start)},0,1)` : `gte(${T},${f(start)})`;
  switch (easing) {
    case "linear":
      return u;
    case "ease_in":
      return `(${u}*${u})`;
    case "ease_out":
      return `(1-(1-${u})*(1-${u}))`;
    case "ease_in_out":
      return `(0.5-0.5*cos(PI*${u}))`;
    case "ease_out_back": {
      const v = `(${u}-1)`;
      return `(1+2.70158*${v}*${v}*${v}+1.70158*${v}*${v})`;
    }
  }
}

const lerp = (from: number, to: number, p: string): string => `(${f(from)}+${f(to - from)}*${p})`;
const win = (T: string, start: number, end: number): string => `between(${T},${f(start)},${f(end)})`;

export interface LayerExpressions {
  /** additive x offset, canvas fractions */
  dx: string;
  /** additive y offset, canvas fractions */
  dy: string;
  /** multiplicative size factor */
  scale: string;
}

const sum = (terms: string[]): string => (terms.length === 0 ? "0" : terms.join("+"));
const product = (terms: string[]): string => (terms.length === 0 ? "1" : terms.join("*"));

/** Expressions for one layer (character / prop / subtitle) from the motions that target it. */
export function layerExpressions(motions: Motion[], T: string): LayerExpressions {
  const dx: string[] = [];
  const dy: string[] = [];
  const scale: string[] = [];
  for (const m of motions) {
    switch (m.type) {
      case "translate": {
        const p = progress(T, m.start, m.end, m.easing);
        dx.push(lerp(m.from[0], m.to[0], p));
        dy.push(lerp(m.from[1], m.to[1], p));
        break;
      }
      case "scale":
        scale.push(lerp(m.from, m.to, progress(T, m.start, m.end, m.easing)));
        break;
      case "shake":
        dx.push(`${f(m.amplitude)}*sin(2*PI*${f(m.frequency)}*${T})*${win(T, m.start, m.end)}`);
        dy.push(`${f(m.amplitude * 0.6)}*cos(2*PI*${f(m.frequency * 1.3)}*${T})*${win(T, m.start, m.end)}`);
        break;
      case "pulse": {
        const phase = `(${T}-${f(m.start)})`;
        const shape = m.shape === "abs_sine" ? `abs(sin(PI*${f(m.frequency)}*${phase}))` : `sin(2*PI*${f(m.frequency)}*${phase})`;
        const term = `${f(m.amplitude)}*${shape}*${win(T, m.start, m.end)}`;
        if (m.axis === "scale") scale.push(`(1+${term})`);
        else (m.axis === "x" ? dx : dy).push(term);
        break;
      }
      default:
        break; // pan/zoom belong to the camera; fade is compiled to an FFmpeg `fade` filter
    }
  }
  return { dx: sum(dx), dy: sum(dy), scale: product(scale) };
}

export interface CameraExpressions {
  /** zoom factor (>= 1) */
  zoom: string;
  /** crop position fractions of the available slack, 0..1 */
  panX: string;
  panY: string;
}

/** Camera: zoom factors multiply; pans are additive deltas around the centre (0.5). */
export function cameraExpressions(motions: Motion[], T: string): CameraExpressions {
  const zoom: string[] = [];
  const px: string[] = [];
  const py: string[] = [];
  for (const m of motions) {
    if (m.type === "zoom") zoom.push(lerp(m.from, m.to, progress(T, m.start, m.end, m.easing)));
    if (m.type === "pan") {
      const p = progress(T, m.start, m.end, m.easing);
      px.push(`(${lerp(m.from[0], m.to[0], p)}-0.5)`);
      py.push(`(${lerp(m.from[1], m.to[1], p)}-0.5)`);
    }
  }
  return { zoom: product(zoom), panX: `(0.5+${sum(px)})`, panY: `(0.5+${sum(py)})` };
}

/** FFmpeg `fade` filters (alpha) for the fade primitives of a layer, in start order. */
export function fadeFilters(motions: Motion[]): string[] {
  return motions
    .filter((m): m is Extract<Motion, { type: "fade" }> => m.type === "fade" && m.from !== m.to)
    .sort((a, b) => a.start - b.start)
    .map((m) => `fade=t=${m.to > m.from ? "in" : "out"}:st=${f(m.start)}:d=${f(Math.max(0.001, m.end - m.start))}:alpha=1`);
}
