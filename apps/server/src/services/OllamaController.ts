import type { CommandRunner } from "../lib/command";
import type { OllamaControl } from "./MemoryGate";

/** Ollama control over its local HTTP API plus a runner-process check. Fixed endpoints only. */
export class OllamaController implements OllamaControl {
  constructor(
    private readonly url: string,
    private readonly runner: CommandRunner,
    private readonly pgrep = "/usr/bin/pgrep",
  ) {}

  async loadedModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.url}/api/ps`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: { name: string }[] };
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return []; // Ollama not running: nothing is resident
    }
  }

  async unload(model: string): Promise<void> {
    const res = await fetch(`${this.url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Ollama answered HTTP ${res.status}`);
    await res.arrayBuffer();
  }

  /** Ollama 0.32 runs models in `llama-server`; older versions used `ollama runner`. */
  async hasRunnerProcess(): Promise<boolean> {
    for (const pattern of ["llama-server", "ollama runner"]) {
      const r = await this.runner.run(this.pgrep, ["-f", pattern], { timeoutMs: 5000 }).catch(() => ({ code: 1 }) as { code: number });
      if (r.code === 0) return true;
    }
    return false;
  }
}
