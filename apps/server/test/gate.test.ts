import { beforeAll, describe, expect, it } from "vitest";
import { ComfyStopError, GateViolationError, OllamaUnloadError, describeError } from "../src/errors";
import { setLogQuiet } from "../src/lib/logger";
import { MemoryGate, type ComfyProbe, type OllamaControl } from "../src/services/MemoryGate";

beforeAll(() => setLogQuiet(true));

class FakeOllama implements OllamaControl {
  calls: string[] = [];
  /** unload() only takes effect after `unloadsNeeded` calls; Infinity = never unloads. */
  constructor(public models: string[], public runner = false, private unloadEffective = true, private pollsUntilGone = 0) {}
  async loadedModels() {
    this.calls.push("ps");
    if (this.pollsUntilGone > 0 && this.models.length === 0) return [];
    return [...this.models];
  }
  async unload(m: string) {
    this.calls.push(`unload:${m}`);
    if (this.unloadEffective) { this.models = this.models.filter((x) => x !== m); }
  }
  async hasRunnerProcess() { this.calls.push("runner?"); return this.runner && this.models.length === 0 ? true : this.runner && !this.unloadEffective; }
}
const comfy = (alive: boolean, port: boolean): ComfyProbe => ({ isProcessAlive: () => alive, isPortOpen: async () => port });
const gate = (o: OllamaControl, c: ComfyProbe) => new MemoryGate(o, c, { unloadTimeoutMs: 200, pollMs: 10 });

describe("MemoryGate: Ollama", () => {
  it("unloads every resident model and verifies it is gone", async () => {
    const o = new FakeOllama(["llama3.2:latest", "nomic-embed-text:latest"]);
    await gate(o, comfy(false, false)).ensureOllamaUnloaded();
    expect(o.calls.filter((c) => c.startsWith("unload"))).toEqual(["unload:llama3.2:latest", "unload:nomic-embed-text:latest"]);
    expect(o.models).toEqual([]);
  });

  it("is a no-op when nothing is loaded", async () => {
    const o = new FakeOllama([]);
    await gate(o, comfy(false, false)).ensureOllamaUnloaded();
    expect(o.calls.some((c) => c.startsWith("unload"))).toBe(false);
  });

  it("FAILS with a readable error when the model refuses to unload", async () => {
    const o = new FakeOllama(["llama3.2:latest"], false, false);
    const err = await gate(o, comfy(false, false)).ensureOllamaUnloaded().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OllamaUnloadError);
    expect(describeError(err)).toContain("Ollama model could not be unloaded.");
  });

  it("FAILS when the unload request itself errors", async () => {
    const o = new FakeOllama(["m"]);
    o.unload = async () => { throw new Error("connection reset"); };
    await expect(gate(o, comfy(false, false)).unloadOllama()).rejects.toBeInstanceOf(OllamaUnloadError);
  });

  it("assertOllamaUnloaded throws if a model is resident or a runner process survives", async () => {
    await expect(gate(new FakeOllama(["m"]), comfy(false, false)).assertOllamaUnloaded()).rejects.toBeInstanceOf(OllamaUnloadError);
    await expect(gate(new FakeOllama([], true), comfy(false, false)).assertOllamaUnloaded()).rejects.toThrow(OllamaUnloadError);
    await expect(gate(new FakeOllama([], false), comfy(false, false)).assertOllamaUnloaded()).resolves.toBeUndefined();
  });
});

describe("MemoryGate: ComfyUI", () => {
  it("passes only when the process is gone AND the port is closed", async () => {
    const o = new FakeOllama([]);
    await expect(gate(o, comfy(false, false)).assertComfyUIStopped()).resolves.toBeUndefined();
    await expect(gate(o, comfy(true, false)).assertComfyUIStopped()).rejects.toBeInstanceOf(ComfyStopError);
    await expect(gate(o, comfy(false, true)).assertComfyUIStopped()).rejects.toBeInstanceOf(ComfyStopError);
  });

  it("refuses to let Ollama load while ComfyUI is running", async () => {
    const err = await gate(new FakeOllama([]), comfy(true, true)).assertSafeToLoadOllama().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GateViolationError);
    expect(describeError(err)).toContain("ComfyUI is still running");
  });
});
