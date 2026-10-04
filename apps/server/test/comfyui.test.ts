import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CancelledError, ComfyGenerationError, ComfyStopError, ComfyTimeoutError, OllamaUnloadError } from "../src/errors";
import { setLogQuiet } from "../src/lib/logger";
import { ComfyUIProvider } from "../src/providers/image/ComfyUIProvider";
import { buildLcmWorkflow } from "../src/providers/image/comfyWorkflow";
import type { ComfySession } from "../src/providers/image/ComfyProcess";
import type { ImageRequest } from "../src/providers/image/ImageProvider";
import type { MemoryGate } from "../src/services/MemoryGate";

beforeAll(() => setLogQuiet(true));

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // fake bytes: the provider only stores them

/** A fake ComfyUI HTTP API. */
function fakeComfy(opts: { pollsBeforeDone?: number; failWith?: string; neverFinish?: boolean } = {}) {
  const events: string[] = [];
  const graphs: any[] = [];
  let n = 0;
  const polls = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const json = (o: unknown, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url.pathname === "/prompt" && req.method === "POST") {
      let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
        const g = JSON.parse(body).prompt; graphs.push(g); events.push("http:prompt");
        json({ prompt_id: `p${++n}` });
      });
    } else if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.split("/")[2]!; const k = (polls.get(id) ?? 0) + 1; polls.set(id, k);
      if (opts.neverFinish || k <= (opts.pollsBeforeDone ?? 0)) return json({});
      if (opts.failWith) return json({ [id]: { status: { status_str: "error", completed: false, messages: [opts.failWith] }, outputs: {} } });
      json({ [id]: { status: { status_str: "success", completed: true, messages: [] }, outputs: { "9": { images: [{ filename: `${id}.png`, subfolder: "", type: "temp" }] } } } });
    } else if (url.pathname === "/view") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(PNG); }
    else if (url.pathname === "/free") { events.push("http:free"); json({}); }
    else if (url.pathname === "/interrupt") { events.push("http:interrupt"); json({}); }
    else json({ error: "nope" }, 404);
  });
  return { server, events, graphs };
}

let dir: string;
let comfy: ReturnType<typeof fakeComfy>;
let base: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-comfy-")); });
afterEach(async () => { comfy.server.close(); await fs.rm(dir, { recursive: true, force: true }); });

async function setup(copts?: Parameters<typeof fakeComfy>[0], over: { startFails?: boolean; stopFails?: boolean; ollamaFails?: boolean; verifyFails?: boolean; imageTimeoutMs?: number } = {}) {
  comfy = fakeComfy(copts);
  await new Promise<void>((r) => comfy.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(comfy.server.address() as AddressInfo).port}`;
  const events = comfy.events; // one shared timeline for gate + process + http
  const gate = {
    ensureOllamaUnloaded: async () => { events.push("gate:ollama-unloaded"); if (over.ollamaFails) throw new OllamaUnloadError("still resident"); },
    assertComfyUIStopped: async () => { events.push("gate:comfy-stopped"); if (over.verifyFails) throw new ComfyStopError("port still open"); },
  } as unknown as MemoryGate;
  let alive = false;
  const session: ComfySession = {
    start: async () => { events.push("proc:start"); if (over.startFails) throw new Error("boom"); alive = true; },
    stop: async () => { events.push("proc:stop"); alive = false; if (over.stopFails) throw new ComfyStopError("won't die"); },
    isProcessAlive: () => alive,
    isPortOpen: async () => alive,
  };
  const provider = new ComfyUIProvider(session, gate, { baseUrl: base, checkpoint: "ck.safetensors", lora: "lcm.safetensors", imageTimeoutMs: over.imageTimeoutMs ?? 5000, pollMs: 5 });
  return { provider, events };
}

const reqs = (n: number): ImageRequest[] => Array.from({ length: n }, (_, i) => ({
  id: `img-${i + 1}`, prompt: `prompt ${i + 1}`, negativePrompt: "neg", width: 512, height: 896, seed: 100 + i, outPath: path.join(dir, `img-${i + 1}.png`),
}));

describe("ComfyUIProvider lifecycle", () => {
  it("runs the gates and the session in the required order, ONE session for the whole batch", async () => {
    const { provider, events } = await setup({ pollsBeforeDone: 2 });
    const saved: string[] = [];
    const out = await provider.generateBatch(reqs(3), { onImage: (r) => { saved.push(r.id); } });
    expect(out.map((r) => r.id)).toEqual(["img-1", "img-2", "img-3"]);
    expect(saved).toEqual(["img-1", "img-2", "img-3"]);
    expect(events).toEqual([
      "gate:ollama-unloaded", "proc:start",
      "http:prompt", "http:prompt", "http:prompt",
      "http:free", "proc:stop", "gate:comfy-stopped",
    ]);
    expect(events.filter((e) => e === "proc:start")).toHaveLength(1);
    for (const r of reqs(3)) expect((await fs.readFile(r.outPath)).equals(PNG)).toBe(true);
  });

  it("sends the proven workflow (SD1.5 + LCM-LoRA, 512x896, lcm sampler) with the request's prompt and seed", async () => {
    const { provider } = await setup();
    await provider.generateBatch(reqs(1));
    const g = comfy.graphs[0];
    expect(g["1"].inputs.ckpt_name).toBe("ck.safetensors");
    expect(g["2"].inputs.lora_name).toBe("lcm.safetensors");
    expect(g["6"].inputs).toMatchObject({ width: 512, height: 896 });
    expect(g["7"].inputs).toMatchObject({ seed: 100, steps: 5, cfg: 1.5, sampler_name: "lcm", scheduler: "sgm_uniform" });
    expect(g["4"].inputs.text).toBe("prompt 1");
    expect(g["9"].class_type).toBe("PreviewImage"); // temp output: ComfyUI's output folder never fills up
  });

  it("does nothing (no gate, no process) for an empty batch", async () => {
    const { provider, events } = await setup();
    expect(await provider.generateBatch([])).toEqual([]);
    expect(events).toEqual([]);
  });

  it("never starts ComfyUI if Ollama cannot be unloaded", async () => {
    const { provider, events } = await setup({}, { ollamaFails: true });
    await expect(provider.generateBatch(reqs(1))).rejects.toBeInstanceOf(OllamaUnloadError);
    expect(events).toEqual(["gate:ollama-unloaded"]);
  });

  it("still stops and verifies ComfyUI when generation fails, and rethrows the ORIGINAL error", async () => {
    const { provider, events } = await setup({ failWith: "CUDA out of memory" });
    const err = await provider.generateBatch(reqs(2)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComfyGenerationError);
    expect(events.slice(-3)).toEqual(["http:free", "proc:stop", "gate:comfy-stopped"]);
    expect(events.filter((e) => e === "http:prompt")).toHaveLength(1); // stopped at the first failure
  });

  it("times out a stuck image, interrupts it, and still shuts down", async () => {
    const { provider, events } = await setup({ neverFinish: true }, { imageTimeoutMs: 120 });
    const err = await provider.generateBatch(reqs(1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComfyTimeoutError);
    expect(events).toContain("http:interrupt");
    expect(events.slice(-2)).toEqual(["proc:stop", "gate:comfy-stopped"]);
  });

  it("cancels between/within images, interrupts, and releases memory", async () => {
    const { provider, events } = await setup({ pollsBeforeDone: 50 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    const err = await provider.generateBatch(reqs(2), { signal: ac.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelledError);
    expect(events).toContain("http:interrupt");
    expect(events.slice(-2)).toEqual(["proc:stop", "gate:comfy-stopped"]);
  });

  it("reports a failed shutdown verification instead of silently continuing", async () => {
    const { provider } = await setup({}, { verifyFails: true });
    await expect(provider.generateBatch(reqs(1))).rejects.toBeInstanceOf(ComfyStopError);
  });

  it("reports a ComfyUI start failure without trying to generate", async () => {
    const { provider, events } = await setup({}, { startFails: true });
    await expect(provider.generateBatch(reqs(1))).rejects.toThrow("boom");
    expect(events).not.toContain("http:prompt");
    expect(events.slice(-2)).toEqual(["proc:stop", "gate:comfy-stopped"]);
  });
});

describe("image quality gate", () => {
  it("regenerates a rejected image with a NEW seed in the same session, then accepts it", async () => {
    const { provider, events } = await setup();
    const seeds: number[] = [];
    let calls = 0;
    const out = await provider.generateBatch(reqs(1), { validate: (r) => { seeds.push(r.seed); return ++calls < 2 ? "a poster survived" : null; } });
    expect(events.filter((e) => e === "http:prompt")).toHaveLength(2);
    expect(events.filter((e) => e === "proc:start")).toHaveLength(1);
    expect(new Set(seeds).size).toBe(2);
    expect(out[0]).toMatchObject({ attempts: 2, seed: seeds[1] });
    expect(out[0]!.qualityWarning).toBeUndefined();
  });
  it("keeps the last attempt (with a warning) when every attempt is rejected, never looping forever", async () => {
    const { provider, events } = await setup();
    const out = await provider.generateBatch(reqs(1), { validate: () => "still bad" });
    expect(events.filter((e) => e === "http:prompt")).toHaveLength(3);
    expect(out[0]).toMatchObject({ attempts: 3, qualityWarning: "still bad" });
  });
});

describe("workflow builder", () => {
  it("is a pure function of its parameters", () => {
    const a = buildLcmWorkflow({ checkpoint: "c", lora: "l", prompt: "p", negativePrompt: "n", width: 512, height: 512, seed: 1 });
    const b = buildLcmWorkflow({ checkpoint: "c", lora: "l", prompt: "p", negativePrompt: "n", width: 512, height: 512, seed: 1 });
    expect(a).toEqual(b);
    expect(a["6"]!.inputs).toMatchObject({ width: 512, height: 512 });
  });
});
