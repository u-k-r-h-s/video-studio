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
  /** Total generations allowed when `validate` rejects (default 3). */
  maxAttempts?: number;
  /** Model id registered with the provider (default: the provider's default model). */
  model?: string;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  /** img2img: start from this image (absolute path) with the given denoise strength (0..1). Output has the init image's size. */
  initImage?: { path: string; denoise: number };
  /**
   * "matte": instead of generating, compute the foreground mask of `initImage.path` with a background-removal model and write
   * it to `outPath` as a grey image (white = foreground). Runs in the same ComfyUI session as the generations.
   */
  task?: "generate" | "matte";
  /**
   * Awaited right before this request runs (after the previous requests were saved and reported through `onImage`). It may
   * create the files this request depends on (a head crop cut from an image generated earlier in the batch) and may replace
   * request fields. Return `null` to skip the request.
   */
  prepare?: () => Promise<Partial<Pick<ImageRequest, "initImage" | "prompt">> | null | void>;
}

export interface ImageResult {
  id: string;
  path: string;
  /** The seed that produced the kept image (differs from the requested one after a quality retry). */
  seed: number;
  durationMs: number;
  /** How many generations it took (1 = accepted first time). */
  attempts?: number;
  /** Set when the kept image still failed validation. */
  qualityWarning?: string;
}

export interface BatchHooks {
  signal?: AbortSignal;
  /** Where the provider should append its own diagnostic output (e.g. ComfyUI stdout), if it has any. */
  logFile?: string;
  /** Called right before each image starts generating (for per-image timing logs). */
  onImageStart?: (id: string) => void;
  /**
   * Quality gate run after each image is saved. Return a reason string to reject it: the provider regenerates it with a
   * new seed (up to `maxAttempts` per request, default 3 in total). The last attempt is kept even if it still fails.
   */
  validate?: (result: ImageResult) => Promise<string | null> | string | null;
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
