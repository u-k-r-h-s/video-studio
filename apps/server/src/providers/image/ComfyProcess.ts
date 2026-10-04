import { closeSync, mkdirSync, openSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { ComfyStartError, ComfyStopError } from "../../errors";
import type { CommandRunner } from "../../lib/command";
import { createLogger } from "../../lib/logger";
import type { ComfyProbe } from "../../services/MemoryGate";

const log = createLogger("comfyui");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ComfySession extends ComfyProbe {
  start(opts?: { logFile?: string }): Promise<void>;
  stop(): Promise<void>;
}

export interface ComfyProcessOptions {
  dir: string;
  python: string;
  host: string;
  port: number;
  startTimeoutMs: number;
  stopTimeoutMs: number;
}

export function isPortOpen(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Owns the ComfyUI child process. Started on demand, bound to loopback, `--offline` (no cloud nodes).
 * stop() escalates SIGTERM -> SIGKILL and verifies the process is gone and the port is closed.
 */
export class ComfyProcess implements ComfySession {
  private child?: ChildProcess;
  private exited = true;
  private exitInfo = "";
  private readonly killOnExit = () => this.child && !this.exited && this.child.kill("SIGKILL");

  constructor(
    private readonly runner: CommandRunner,
    private readonly opts: ComfyProcessOptions,
  ) {}

  isProcessAlive(): boolean {
    return !!this.child && !this.exited;
  }

  isPortOpen(): Promise<boolean> {
    return isPortOpen(this.opts.host, this.opts.port);
  }

  async start(startOpts: { logFile?: string } = {}): Promise<void> {
    if (this.isProcessAlive()) return;
    const mainPy = path.join(this.opts.dir, "main.py");
    if (!existsSync(this.opts.python)) throw new ComfyStartError(`Python not found at ${this.opts.python}`);
    if (!existsSync(mainPy)) throw new ComfyStartError(`ComfyUI not found at ${this.opts.dir}`);
    // Never hijack (or collide with) a ComfyUI the user started themselves.
    if (await this.isPortOpen()) throw new ComfyStartError(`port ${this.opts.port} is already in use (is another ComfyUI running?)`);

    let fd: number | undefined;
    if (startOpts.logFile) {
      mkdirSync(path.dirname(startOpts.logFile), { recursive: true });
      fd = openSync(startOpts.logFile, "a");
    }
    try {
      this.exited = false;
      this.exitInfo = "";
      this.child = this.runner.spawn(
        this.opts.python,
        [mainPy, "--listen", this.opts.host, "--port", String(this.opts.port), "--disable-auto-launch", "--offline"],
        { cwd: this.opts.dir, env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: "1" }, stdout: fd, stderr: fd },
      );
    } catch (err) {
      this.exited = true;
      throw new ComfyStartError("could not spawn the ComfyUI process", err);
    } finally {
      if (fd !== undefined) closeSync(fd); // the child keeps its own copy of the descriptor
    }
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = `exited with code ${code} signal ${signal}`;
      log.info("process exited", { code: code ?? "null", signal: signal ?? "null" });
    });
    this.child.once("error", (err) => {
      this.exited = true;
      this.exitInfo = `spawn error: ${err.message}`;
    });
    process.once("exit", this.killOnExit);
    log.info("starting", { pid: this.child.pid, port: this.opts.port });

    const deadline = Date.now() + this.opts.startTimeoutMs;
    const base = `http://${this.opts.host}:${this.opts.port}`;
    for (;;) {
      if (this.exited) throw new ComfyStartError(`the process ${this.exitInfo}${startOpts.logFile ? ` (see ${startOpts.logFile})` : ""}`);
      try {
        const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          log.info("ready", { pid: this.child.pid });
          return;
        }
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) {
        await this.stop().catch(() => {});
        throw new ComfyStartError(`not ready after ${Math.round(this.opts.startTimeoutMs / 1000)} s`);
      }
      await sleep(500);
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child && !this.exited) {
      const waitExit = async (ms: number) => {
        const end = Date.now() + ms;
        while (!this.exited && Date.now() < end) await sleep(100);
      };
      child.kill("SIGTERM");
      await waitExit(this.opts.stopTimeoutMs);
      if (!this.exited) {
        log.warn("did not exit after SIGTERM; sending SIGKILL");
        child.kill("SIGKILL");
        await waitExit(5000);
      }
    }
    process.off("exit", this.killOnExit);
    if (this.isProcessAlive()) throw new ComfyStopError("the process would not exit");
    // port release can lag the process by a moment
    for (let i = 0; i < 20; i++) {
      if (!(await this.isPortOpen())) return;
      await sleep(250);
    }
    throw new ComfyStopError(`port ${this.opts.port} is still open after the process exited`);
  }
}
