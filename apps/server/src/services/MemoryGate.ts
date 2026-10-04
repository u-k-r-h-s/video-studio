import { ComfyStopError, GateViolationError, OllamaUnloadError } from "../errors";
import { createLogger } from "../lib/logger";

const log = createLogger("memory-gate");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the gate needs to know about Ollama. Implemented over HTTP + a process check; faked in tests. */
export interface OllamaControl {
  /** Names of models currently resident (Ollama /api/ps). Empty when Ollama is not running. */
  loadedModels(): Promise<string[]>;
  /** Ask Ollama to evict a model immediately (keep_alive: 0). */
  unload(model: string): Promise<void>;
  /** Is a model-runner process (llama-server / ollama runner) still alive? */
  hasRunnerProcess(): Promise<boolean>;
}

/** What the gate needs to know about ComfyUI. */
export interface ComfyProbe {
  isProcessAlive(): boolean;
  isPortOpen(): Promise<boolean>;
}

export interface GateOptions {
  unloadTimeoutMs: number;
  pollMs?: number;
}

/**
 * Enforces the 8 GB rule: Ollama and ComfyUI must never be resident at the same time.
 * Every gate VERIFIES the state instead of trusting that a previous call worked, and throws a user-readable
 * error so the pipeline stops rather than continuing blindly.
 */
export class MemoryGate {
  constructor(
    private readonly ollama: OllamaControl,
    private readonly comfy: ComfyProbe,
    private readonly opts: GateOptions,
  ) {}

  /** Evict every resident Ollama model, then wait until it is really gone. */
  async unloadOllama(): Promise<void> {
    const loaded = await this.ollama.loadedModels();
    if (loaded.length > 0) log.info("unloading ollama models", { models: loaded.join(",") });
    for (const m of loaded) {
      try {
        await this.ollama.unload(m);
      } catch (err) {
        throw new OllamaUnloadError(`unload request for ${m} failed: ${(err as Error).message}`, err);
      }
    }
    await this.waitUntilUnloaded();
  }

  /** Throws unless no Ollama model is resident and no runner process is alive. */
  async assertOllamaUnloaded(): Promise<void> {
    const loaded = await this.ollama.loadedModels();
    if (loaded.length > 0) throw new OllamaUnloadError(`still resident: ${loaded.join(", ")}`);
    if (await this.ollama.hasRunnerProcess()) throw new OllamaUnloadError("an Ollama runner process is still alive");
  }

  /** unload + verify. Used before anything that loads another heavy model. */
  async ensureOllamaUnloaded(): Promise<void> {
    await this.unloadOllama();
    await this.assertOllamaUnloaded();
    log.info("ollama unloaded and verified");
  }

  /** Throws unless ComfyUI's process is gone AND its port is closed. */
  async assertComfyUIStopped(): Promise<void> {
    if (this.comfy.isProcessAlive()) throw new ComfyStopError("the ComfyUI process is still running");
    if (await this.comfy.isPortOpen()) throw new ComfyStopError("something is still listening on the ComfyUI port");
  }

  /** Before Ollama is used: ComfyUI must not be holding memory. */
  async assertSafeToLoadOllama(): Promise<void> {
    try {
      await this.assertComfyUIStopped();
    } catch (err) {
      throw new GateViolationError("Ollama was not started because ComfyUI is still running.", err instanceof Error ? err.message : String(err));
    }
  }

  private async waitUntilUnloaded(): Promise<void> {
    const deadline = Date.now() + this.opts.unloadTimeoutMs;
    const poll = this.opts.pollMs ?? 500;
    for (;;) {
      const loaded = await this.ollama.loadedModels();
      if (loaded.length === 0 && !(await this.ollama.hasRunnerProcess())) return;
      if (Date.now() >= deadline) {
        throw new OllamaUnloadError(`after ${this.opts.unloadTimeoutMs} ms: models=[${loaded.join(", ")}] runnerAlive=${await this.ollama.hasRunnerProcess()}`);
      }
      await sleep(poll);
    }
  }
}
