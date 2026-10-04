/**
 * Error model. `userMessage` is what the UI shows (understandable, no stack traces); `hint` says how to fix it;
 * `cause`/`details` carry the diagnostics that go to the logs only.
 */
export interface AppErrorOptions {
  hint?: string;
  cause?: unknown;
  details?: unknown;
  status?: number;
}

export class AppError extends Error {
  readonly hint?: string;
  readonly details?: unknown;
  readonly status: number;
  constructor(
    readonly code: string,
    readonly userMessage: string,
    opts: AppErrorOptions = {},
  ) {
    super(userMessage, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AppError";
    this.hint = opts.hint;
    this.details = opts.details;
    this.status = opts.status ?? 500;
  }
}

/** Request/validation problems returned as 4xx. */
export class HttpError extends AppError {
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(code, message, { status, details });
    this.name = "HttpError";
  }
}

export class OllamaUnavailableError extends AppError {
  constructor(message: string, hint?: string, cause?: unknown) {
    super("ollama_unavailable", message, { hint, cause, status: 503 });
  }
}
export class OllamaUnloadError extends AppError {
  constructor(detail: string, cause?: unknown) {
    super("ollama_unload_failed", "Ollama model could not be unloaded.", {
      hint: "Quit Ollama from the menu bar (or run `ollama stop llama3.2`) and retry. Image generation is blocked while an Ollama model is resident because 8 GB of unified memory cannot hold both.",
      details: detail,
      cause,
      status: 409,
    });
  }
}
export class ComfyStartError extends AppError {
  constructor(detail: string, cause?: unknown) {
    super("comfyui_start_failed", "ComfyUI failed to start.", {
      hint: "Check COMFYUI_DIR / COMFYUI_PYTHON in .env and the log at projects/<id>/logs/comfyui.log. Run `npm run doctor` to verify the install.",
      details: detail,
      cause,
      status: 503,
    });
  }
}
export class ComfyStopError extends AppError {
  constructor(detail: string) {
    super("comfyui_stop_failed", "ComfyUI could not be stopped.", {
      hint: "Quit the process manually (Activity Monitor -> python / ComfyUI) before continuing; the pipeline will not proceed while it is running.",
      details: detail,
      status: 409,
    });
  }
}
export class ComfyTimeoutError extends AppError {
  constructor(detail: string) {
    super("comfyui_timeout", "ComfyUI generation timed out.", {
      hint: "The machine may be under heavy memory pressure. Close other apps (browsers especially) and retry; already generated images are kept.",
      details: detail,
      status: 504,
    });
  }
}
export class ComfyGenerationError extends AppError {
  constructor(detail: string, cause?: unknown) {
    super("comfyui_generation_failed", "ComfyUI could not generate the image.", { details: detail, cause, status: 502 });
  }
}
export class PiperVoiceNotFoundError extends AppError {
  constructor(voiceId: string, file: string) {
    super("piper_voice_not_found", "Piper voice model was not found.", {
      hint: `Voice "${voiceId}" needs ${file}. See README -> "Model installation" (voices are not bundled for licensing reasons).`,
      details: { voiceId, file },
      status: 424,
    });
  }
}
export class PiperError extends AppError {
  constructor(detail: string, cause?: unknown) {
    super("piper_failed", "Piper could not generate the voice audio.", { details: detail, cause, status: 502 });
  }
}
export class EncoderUnavailableError extends AppError {
  constructor(encoder: string) {
    super("encoder_unavailable", encoder === "h264_videotoolbox" ? "FFmpeg VideoToolbox encoder is unavailable." : `FFmpeg encoder ${encoder} is unavailable.`, {
      hint: "Set FFMPEG_ENCODER=auto to allow the libx264 software fallback, or install an FFmpeg build with VideoToolbox.",
      status: 424,
    });
  }
}
export class RenderError extends AppError {
  constructor(detail: string, cause?: unknown) {
    super("render_failed", "FFmpeg could not render the video.", { details: detail, cause, status: 502 });
  }
}
export class SubtitleRenderError extends AppError {
  constructor(detail: string, cause?: unknown) {
    super("subtitle_failed", "Subtitle images could not be rendered.", {
      hint: "The CoreText helper is built with `npm run build:native` (needs Xcode command line tools: xcode-select --install).",
      details: detail,
      cause,
      status: 424,
    });
  }
}
/** A memory gate was violated; the pipeline stops instead of continuing blindly. */
export class GateViolationError extends AppError {
  constructor(message: string, detail?: string) {
    super("memory_gate_violation", message, { details: detail, status: 409 });
  }
}
export class StageOrderError extends AppError {
  constructor(message: string) {
    super("stage_not_ready", message, { status: 409 });
  }
}
/** LLM output still invalid after all repair attempts. */
export class LlmValidationError extends AppError {
  constructor(message: string, readonly issues: string[]) {
    super("llm_invalid_output", message, {
      hint: "Try again, shorten the input, or use a larger Ollama model (set OLLAMA_MODEL).",
      details: issues,
      status: 502,
    });
  }
}
export class CancelledError extends AppError {
  constructor() {
    super("cancelled", "The job was cancelled.", { status: 409 });
  }
}

/** Message safe to show to the user: never includes stack traces. */
export function describeError(err: unknown): string {
  if (err instanceof AppError) {
    const detail = err instanceof LlmValidationError ? ` Problems: ${err.issues.slice(0, 4).join(" | ")}` : "";
    return `${err.userMessage}${detail}${err.hint ? ` ${err.hint}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Full diagnostics for the logs only. */
export function diagnostics(err: unknown): Record<string, unknown> {
  if (err instanceof AppError) {
    return { code: err.code, message: err.userMessage, details: err.details, cause: err.cause instanceof Error ? err.cause.message : err.cause };
  }
  return { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined };
}
