import { execFile, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { AppError } from "../errors";

/**
 * The ONLY way the application starts processes.
 *
 * - Never uses a shell: arguments are passed as an array, so text from users or the LLM can never be
 *   interpreted as commands.
 * - Only executables on an explicit allow-list (derived from configuration at start-up) may run.
 * - Nothing here is ever exposed to the LLM; tools call providers, providers call this runner.
 */
export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Raw bytes on stdout instead of text (e.g. image sampling). */
  encoding?: "utf8" | "buffer";
}
export interface CommandRunner {
  run(file: string, args: readonly string[], opts?: RunOptions): Promise<RunResult>;
  /** Long-running process (ComfyUI). Same allow-list, still no shell. */
  spawn(file: string, args: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdout?: number; stderr?: number }): ChildProcess;
}

export class ExecFileRunner implements CommandRunner {
  private readonly allowed: Set<string>;

  constructor(allowed: Iterable<string>) {
    this.allowed = new Set([...allowed].filter(Boolean).map((p) => (path.isAbsolute(p) ? path.normalize(p) : p)));
  }

  private assertAllowed(file: string): void {
    const key = path.isAbsolute(file) ? path.normalize(file) : file;
    if (!this.allowed.has(key)) {
      throw new AppError("command_not_allowed", "That program is not on the allow-list and was not started.", { details: file, status: 403 });
    }
  }

  async run(file: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
    this.assertAllowed(file); // async function: a refusal is a rejected promise, like every other failure
    return new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs, signal: opts.signal, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
          if (err && ((err as { killed?: boolean }).killed || (err as { name?: string }).name === "AbortError")) return reject(err);
          resolve({ stdout: String(stdout), stderr: String(stderr), code });
        },
      );
    });
  }

  spawn(file: string, args: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdout?: number; stderr?: number }): ChildProcess {
    this.assertAllowed(file);
    return spawn(file, [...args], { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", opts.stdout ?? "ignore", opts.stderr ?? "ignore"], shell: false });
  }
}
