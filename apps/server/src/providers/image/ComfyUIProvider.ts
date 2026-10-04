import fs from "node:fs/promises";
import path from "node:path";
import type { ServiceDetail } from "@studio/shared";
import { CancelledError, ComfyGenerationError, ComfyTimeoutError, describeError } from "../../errors";
import { createLogger } from "../../lib/logger";
import type { MemoryGate } from "../../services/MemoryGate";
import type { ComfySession } from "./ComfyProcess";
import { createHash } from "node:crypto";
import { buildWorkflow, OUTPUT_NODE_ID, type ComfyGraph, type ModelSpec, type WorkflowParams } from "./comfyWorkflow";
import type { BatchHooks, ImageProvider, ImageRequest, ImageResult } from "./ImageProvider";

const log = createLogger("comfyui");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ComfyUIOptions {
  baseUrl: string;
  /** Default model (back-compat: a one-file checkpoint + LCM-LoRA). Ignored for ids present in `models`. */
  checkpoint?: string;
  lora?: string;
  /** Registered models by id. The first one (or `defaultModel`) is used when a request names none. */
  models?: Record<string, ModelSpec>;
  defaultModel?: string;
  imageTimeoutMs: number;
  /** Where to append ComfyUI's own stdout/stderr (diagnostics only). */
  logFile?: string;
  pollMs?: number;
  /** Replaceable workflow builder: swapping the workflow never touches the rest of the app. */
  buildWorkflow?: (params: WorkflowParams) => ComfyGraph;
}

/**
 * ImageProvider backed by a local ComfyUI (SD 1.5 + LCM-LoRA, as measured in the feasibility test).
 *
 * generateBatch lifecycle (one session per call, never one per image):
 *   1. ensure Ollama is unloaded and verified (MemoryGate)
 *   2. start ComfyUI
 *   3. generate ALL requested images, saving each as it completes
 *   4. free ComfyUI model memory (/free)
 *   5. stop ComfyUI
 *   6. verify the process is gone and the port closed (MemoryGate)
 * Steps 4-6 run in `finally`, so cancellation and failures also release the memory.
 */
export class ComfyUIProvider implements ImageProvider {
  readonly name = "comfyui";

  constructor(
    private readonly session: ComfySession,
    private readonly gate: MemoryGate,
    private readonly opts: ComfyUIOptions,
  ) {}

  async generateBatch(requests: ImageRequest[], hooks: BatchHooks = {}): Promise<ImageResult[]> {
    if (requests.length === 0) return [];
    await this.gate.ensureOllamaUnloaded(); // 1
    const results: ImageResult[] = [];
    let primaryError: unknown;
    try {
      await this.session.start({ logFile: hooks.logFile ?? this.opts.logFile }); // 2
      for (const [i, req] of requests.entries()) {
        if (hooks.signal?.aborted) throw new CancelledError();
        hooks.onProgress?.(i, requests.length, `Generating ${req.id}`);
        hooks.onImageStart?.(req.id);
        const result = await this.generateWithQc(req, hooks); // 3
        results.push(result);
        await hooks.onImage?.(result);
        hooks.onProgress?.(i + 1, requests.length, `Generated ${req.id}`);
      }
    } catch (err) {
      primaryError = err;
      throw err;
    } finally {
      await this.releaseAndVerify(primaryError !== undefined); // 4-6
    }
    return results;
  }

  /** Generate, then ask the caller's quality gate; on rejection retry with a new seed (same session, no restart). */
  private async generateWithQc(req: ImageRequest, hooks: BatchHooks): Promise<ImageResult> {
    const max = Math.max(1, req.maxAttempts ?? 3);
    let total = 0;
    for (let attempt = 0; ; attempt++) {
      const seed = req.seed + attempt * 7919;
      const r = await this.generateOne({ ...req, seed }, hooks.signal);
      total += r.durationMs;
      const reason = hooks.validate ? await hooks.validate(r) : null;
      if (!reason) return { ...r, durationMs: total, attempts: attempt + 1 };
      log.warn(`image ${req.id} rejected: ${reason}`, { attempt: attempt + 1, of: max, seed });
      if (attempt + 1 >= max) return { ...r, durationMs: total, attempts: attempt + 1, qualityWarning: reason };
    }
  }

  private async releaseAndVerify(alreadyFailing: boolean): Promise<void> {
    try {
      if (this.session.isProcessAlive()) await this.freeMemory(); // 4
    } catch (err) {
      log.warn("freeing ComfyUI memory failed (stopping the process anyway)", { error: (err as Error).message });
    }
    try {
      await this.session.stop(); // 5
      await this.gate.assertComfyUIStopped(); // 6
    } catch (err) {
      if (alreadyFailing) log.error(`could not verify ComfyUI shutdown: ${describeError(err)}`);
      else throw err;
    }
  }

  private async freeMemory(): Promise<void> {
    await fetch(`${this.opts.baseUrl}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(15_000),
    }).then((r) => r.arrayBuffer());
  }

  private modelFor(req: ImageRequest): ModelSpec {
    const models = this.opts.models ?? { sd15: { id: "sd15", checkpoint: this.opts.checkpoint, lora: this.opts.lora } };
    const id = req.model ?? this.opts.defaultModel ?? Object.keys(models)[0]!;
    const m = models[id];
    if (!m) throw new ComfyGenerationError(`unknown image model "${id}" (registered: ${Object.keys(models).join(", ")})`);
    return m;
  }

  /** Uploads an init image to ComfyUI's input folder (content-addressed name, so repeats are free). */
  private async upload(file: string): Promise<string> {
    const bytes = await fs.readFile(file);
    const name = `studio-${createHash("sha1").update(bytes).digest("hex").slice(0, 12)}${path.extname(file) || ".png"}`;
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(bytes)]), name);
    form.append("overwrite", "true");
    const res = await fetch(`${this.opts.baseUrl}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) }).catch((e) => { throw new ComfyGenerationError("could not upload the init image", e); });
    if (!res.ok) throw new ComfyGenerationError(`ComfyUI rejected the init image (HTTP ${res.status})`);
    return ((await res.json()) as { name?: string }).name ?? name;
  }

  private async generateOne(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
    const t0 = Date.now();
    const init = req.initImage ? { imageName: await this.upload(req.initImage.path), denoise: req.initImage.denoise } : undefined;
    const graph = (this.opts.buildWorkflow ?? buildWorkflow)({
      model: this.modelFor(req), prompt: req.prompt, negativePrompt: req.negativePrompt, width: req.width, height: req.height, seed: req.seed,
      steps: req.steps, cfg: req.cfg, sampler: req.sampler, scheduler: req.scheduler, init,
    });
    const promptId = await this.submit(graph);
    const file = await this.waitForImage(promptId, req.id, signal);
    const bytes = await this.download(file);
    await fs.mkdir(path.dirname(req.outPath), { recursive: true });
    const tmp = `${req.outPath}.tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, req.outPath);
    return { id: req.id, path: req.outPath, seed: req.seed, durationMs: Date.now() - t0 };
  }

  private async submit(graph: ComfyGraph): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: graph }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ComfyGenerationError("could not submit the job", err);
    }
    const body = (await res.json().catch(() => ({}))) as { prompt_id?: string; error?: unknown; node_errors?: unknown };
    if (!res.ok || !body.prompt_id) throw new ComfyGenerationError(`ComfyUI rejected the workflow: ${JSON.stringify(body.node_errors ?? body.error ?? res.status).slice(0, 400)}`);
    return body.prompt_id;
  }

  private async waitForImage(promptId: string, label: string, signal?: AbortSignal): Promise<{ filename: string; subfolder: string; type: string }> {
    const deadline = Date.now() + this.opts.imageTimeoutMs;
    for (;;) {
      if (signal?.aborted) {
        await this.interrupt();
        throw new CancelledError();
      }
      if (Date.now() > deadline) {
        await this.interrupt();
        throw new ComfyTimeoutError(`${label} did not finish within ${Math.round(this.opts.imageTimeoutMs / 1000)} s`);
      }
      const res = await fetch(`${this.opts.baseUrl}/history/${promptId}`, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
      const entry = res?.ok ? ((await res.json()) as Record<string, { status?: { status_str?: string; completed?: boolean; messages?: unknown[] }; outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> }>)[promptId] : undefined;
      if (entry?.status?.status_str === "error") throw new ComfyGenerationError(`ComfyUI reported an error for ${label}: ${JSON.stringify(entry.status.messages ?? []).slice(0, 400)}`);
      if (entry?.status?.completed) {
        const image = entry.outputs?.[OUTPUT_NODE_ID]?.images?.[0] ?? Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
        if (!image) throw new ComfyGenerationError(`ComfyUI finished ${label} without an image`);
        return image;
      }
      await sleep(this.opts.pollMs ?? 500);
    }
  }

  private async download(file: { filename: string; subfolder: string; type: string }): Promise<Buffer> {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const res = await fetch(`${this.opts.baseUrl}/view?${q}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new ComfyGenerationError(`could not download the generated image (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async interrupt(): Promise<void> {
    await fetch(`${this.opts.baseUrl}/interrupt`, { method: "POST", signal: AbortSignal.timeout(5000) }).catch(() => {});
  }

  /** Static check only: starting ComfyUI just to probe it would load memory. */
  async health(): Promise<ServiceDetail> {
    return { status: "ready", message: "ComfyUI is started on demand for each image batch" };
  }
}
