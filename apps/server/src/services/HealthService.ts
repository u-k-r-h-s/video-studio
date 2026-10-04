import { existsSync } from "node:fs";
import path from "node:path";
import type { HealthResponse, ServiceDetail } from "@studio/shared";
import type { AppConfig } from "../config";
import type { LLMProvider } from "../llm/types";
import type { ImageProvider } from "../providers/image/ImageProvider";
import type { SubtitleRenderer } from "../providers/subtitle/SubtitleRenderer";
import type { TTSProvider } from "../providers/tts/TTSProvider";
import type { SceneRenderer } from "../render/SceneRenderer";
import type { ComfyProbe, OllamaControl } from "./MemoryGate";

const CACHE_MS = 5000;

export interface HealthDeps {
  config: Pick<AppConfig, "comfy">;
  llm: LLMProvider;
  image: ImageProvider;
  tts: TTSProvider;
  subtitle: SubtitleRenderer;
  renderer: SceneRenderer;
  ollama: OllamaControl;
  comfy: ComfyProbe;
}

/**
 * Reports which local tools are usable, with setup hints, plus the memory-gate state (is a heavy model resident?).
 * ComfyUI is checked by its INSTALLATION (files present), never by starting it: probing would load memory.
 */
export class HealthService {
  private cache?: { at: number; value: HealthResponse };

  constructor(private readonly deps: HealthDeps) {}

  async check(force = false): Promise<HealthResponse> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const d = this.deps;
    const [ollama, piper, ffmpeg, subtitles, resident] = await Promise.all([d.llm.health(), d.tts.health(), d.renderer.health(), d.subtitle.health(), d.ollama.loadedModels()]);
    const value: HealthResponse = {
      services: { ollama, comfyui: this.comfyInstall(), piper, ffmpeg, subtitles },
      gates: { ollamaResident: resident.length > 0, comfyuiRunning: d.comfy.isProcessAlive() || (await d.comfy.isPortOpen()) },
      checkedAt: new Date().toISOString(),
    };
    this.cache = { at: Date.now(), value };
    return value;
  }

  private comfyInstall(): ServiceDetail {
    const { dir, python, checkpoint, lora } = this.deps.config.comfy;
    const missing: string[] = [];
    if (!existsSync(python)) missing.push(`Python at ${python}`);
    if (!existsSync(path.join(dir, "main.py"))) missing.push(`ComfyUI at ${dir}`);
    if (!existsSync(path.join(dir, "models", "checkpoints", checkpoint))) missing.push(`checkpoint ${checkpoint}`);
    if (!existsSync(path.join(dir, "models", "loras", lora))) missing.push(`LoRA ${lora}`);
    if (missing.length) return { status: "unavailable", message: `ComfyUI is not fully installed (missing: ${missing.join("; ")})`, hint: "See README -> Installation and Model installation, then run `npm run doctor`." };
    return { status: "ready", message: "ComfyUI install found (started on demand, once per image batch)" };
  }
}
