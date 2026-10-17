/**
 * Deterministic motion filters for the procedural layers. A pose input that steps (a new look target, the start of a
 * walk, an acceleration that switches on) must not step the bones: it is followed by a critically damped spring, which
 * starts with zero velocity, never overshoots, and depends only on the sequence of (value, dt) it is fed, so the same
 * frames always give the same pose (rendering in chunks fast-forwards through the same sequence).
 */
export class Damp {
  private v = 0;
  /** `time`: roughly how long a step takes to settle (s). */
  constructor(public x = 0, private readonly time = 0.25) {}
  /** dt = 0 (the first frame of a shot) jumps straight to the goal: there is no earlier frame to be continuous with. */
  step(goal: number, dt: number): number {
    if (dt <= 0) { this.x = goal; this.v = 0; return this.x; }
    const omega = 2 / Math.max(1e-3, this.time), k = omega * dt;
    const e = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
    const change = this.x - goal, temp = (this.v + omega * change) * dt;
    this.v = (this.v - omega * temp) * e;
    this.x = goal + (change + temp) * e;
    return this.x;
  }
  get velocity(): number { return this.v; }
}

/** An angle (radians) through a damper, along the short way round. */
export class DampAngle {
  private d: Damp;
  constructor(x = 0, time = 0.25) { this.d = new Damp(x, time); }
  step(goal: number, dt: number): number {
    const cur = this.d.x, diff = Math.atan2(Math.sin(goal - cur), Math.cos(goal - cur));
    return this.d.step(cur + diff, dt);
  }
}
