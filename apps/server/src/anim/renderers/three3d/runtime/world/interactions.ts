import type { InteractionSpec3D } from "../../spec";

/**
 * Hand pump and tap as pure functions of the shot time (no state carried between frames: a frame rendered alone, or the
 * first frame of a chunk, is identical to the same frame of a full render).
 *  - handle: a stroke cycle at `rate` strokes/s, eased in and out over 0.4 s at the start and end of the pumping;
 *  - flow (litres/s): water leaves the spout on the DOWN-stroke of the handle, 0.18 s after it (the column has to lift),
 *    and stops shortly after the last stroke;
 *  - bucket level: the integral of the flow from the start (a fixed-step sum from the window start, never accumulated
 *    across frames), capped at the bucket's capacity.
 */
const smooth = (x: number): number => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
export const BUCKET_LITRES = 12;
const STEP = 1 / 240;

export function pumpHandle(i: NonNullable<InteractionSpec3D["handpump"]>, t: number): number {
  const rate = i.rate ?? 0.9, env = smooth((t - i.from) / 0.4) * (1 - smooth((t - i.to) / 0.4));
  if (env <= 0) return 0;
  // 0 = handle level; +1 = handle end raised (piston down), -1 = handle end pushed down (piston up: water comes)
  return env * Math.sin(2 * Math.PI * rate * (t - i.from));
}
/** Litres per second out of the spout at t. */
export function pumpFlow(i: NonNullable<InteractionSpec3D["handpump"]>, t: number): number {
  const lag = 0.18, h = pumpHandle(i, t - lag);
  return Math.max(0, -h) * 1.1; // ~0.6 L per full stroke (an India Mark II delivers about that from a shallow well)
}
export function tapFlow(i: NonNullable<InteractionSpec3D["tap"]>, t: number): number {
  return 0.12 * smooth((t - i.open) / 0.35) * (1 - smooth((t - i.close) / 0.3));
}
/** Litres in the bucket at t (0 .. BUCKET_LITRES). */
export function litres(flow: (t: number) => number, from: number, t: number): number {
  let v = 0;
  for (let x = from; x < t; x += STEP) v += flow(x) * Math.min(STEP, t - x);
  return Math.min(BUCKET_LITRES, v);
}
/** The handle's angle in radians: the grip travels between about waist and shoulder height of a person standing at it
 *  (~0.9 m to ~1.55 m above the ground, inside a child's reach too); at rest it hangs a little below level. */
export const handleAngle = (h: number): number => -0.05 + 0.3 * h;
