import type { ServiceDetail } from "@studio/shared";

export interface ImageRequest {
  /** Asset id the image belongs to (e.g. "bg-village-shop"). */
  id: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  seed: number;
  /** Absolute destination path (inside the project). */
  outPath: string;
}

export interface ImageResult {
  id: string;
  path: string;
  seed: number;
  durationMs: number;
}

export interface BatchHooks {
  signal?: AbortSignal;
  /** Called as soon as EACH image is saved, so the caller can persist progress (resumability). */
  onImage?: (result: ImageResult) => Promise<void> | void;
  onProgress?: (done: number, total: number, message: string) => void;
}

/**
 * Image generation behind an interface so another backend can replace ComfyUI later.
 * Contract: `generateBatch` owns the provider's whole lifecycle for ONE project batch. It may start heavy
 * resources, must generate every request in a single session, and must release/stop them before returning
 * (also on failure or cancellation).
 */
export interface ImageProvider {
  readonly name: string;
  generateBatch(requests: ImageRequest[], hooks?: BatchHooks): Promise<ImageResult[]>;
  health(): Promise<ServiceDetail>;
}
