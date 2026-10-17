/**
 * Locomotion state machine: IDLE -> WALK -> RUN -> STOP -> IDLE, driven by the speed the character actually moves at.
 * Each state has target clip weights; weights move toward the target with a cross-fade time, so a change of state is a
 * blend, never a snap. Pure and deterministic: step(dt) with the same inputs gives the same weights.
 */
export type LocoState = "idle" | "walk" | "run" | "stop";
export interface LocoWeights { idle: number; walk: number; run: number; walkRate: number; runRate: number }

export interface LocoOptions {
  /** Ground speed (m/s) at which the walk / run clips play at rate 1 (feet do not slide). */
  walkSpeed: number;
  runSpeed: number;
  /** Cross-fade times (s). */
  fade?: { idleWalk?: number; walkRun?: number; stop?: number };
}

export class LocomotionStateMachine {
  state: LocoState = "idle";
  private w = { idle: 1, walk: 0, run: 0 };
  private stopTimer = 0;
  readonly history: { t: number; from: LocoState; to: LocoState }[] = [];
  constructor(private readonly o: LocoOptions) {}

  /** Speed in m/s; `turning` in rad/s (turning on the spot shuffles the feet). */
  step(t: number, dt: number, speed: number, turning = 0): LocoWeights {
    const { walkSpeed, runSpeed } = this.o;
    const prev = this.state;
    const runAt = (walkSpeed + runSpeed) / 2;
    if (speed > runAt) this.state = "run";
    else if (speed > walkSpeed * 0.18) this.state = "walk";
    else if (this.state === "walk" || this.state === "run") { this.state = "stop"; this.stopTimer = 0; }
    else if (this.state === "stop") { this.stopTimer += dt; if (this.stopTimer > (this.o.fade?.stop ?? 0.35)) this.state = "idle"; }
    if (this.state !== prev) this.history.push({ t, from: prev, to: this.state });

    // target weights per state; a turn on the spot borrows a little of the walk (feet step around)
    const shuffle = this.state === "idle" || this.state === "stop" ? Math.min(0.45, Math.abs(turning) * 0.25) : 0;
    // below cruise the walk is blended in by the speed itself (a 1-D blend tree): fully walking from half the cruise speed,
    // and the clip rate set so that weight x rate x clip speed = the body's speed. Starting and stopping, the feet move
    // as fast as the body does (a fixed-time cross-fade let the body glide ahead of feet still in the idle pose)
    const walkShare = Math.min(1, speed / (0.5 * walkSpeed));
    const target = this.state === "run" ? { idle: 0, walk: 0, run: 1 }
      : this.state === "walk" ? { idle: 1 - walkShare, walk: walkShare, run: 0 }
      : this.state === "stop" ? { idle: 1 - Math.max(walkShare, shuffle), walk: Math.max(walkShare, shuffle), run: 0 }
      : { idle: 1 - shuffle, walk: shuffle, run: 0 };
    const fade = this.state === "run" || prev === "run" ? (this.o.fade?.walkRun ?? 0.25) : (this.o.fade?.idleWalk ?? 0.2);
    const k = Math.min(1, dt / Math.max(0.001, fade));
    for (const key of ["idle", "walk", "run"] as const) this.w[key] += (target[key] - this.w[key]) * k;
    const sum = this.w.idle + this.w.walk + this.w.run || 1;
    return {
      idle: this.w.idle / sum, walk: this.w.walk / sum, run: this.w.run / sum,
      // clip rates follow the real speed so the feet stick to the ground
      walkRate: speed > 0.01 ? Math.max(0.5, Math.min(1.5, speed / (Math.max(0.25, this.w.walk / sum) * walkSpeed))) : shuffle ? 0.8 : 1,
      runRate: Math.max(0.7, Math.min(1.4, speed / runSpeed || 1)),
    };
  }
}
