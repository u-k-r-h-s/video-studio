import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { findExecutable } from "./lib/exe";

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/server/src -> repo root */
export const REPO_ROOT = path.resolve(here, "../../..");

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  SERVER_HOST: z.string().default("127.0.0.1"),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  PROJECTS_DIR: z.string().default("./projects"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  OLLAMA_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().min(1).default("llama3.2"),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(1000).default(240_000),
  OLLAMA_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
  OLLAMA_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  OLLAMA_UNLOAD_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20_000),
  PLANNER_MAX_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(5).default(2),

  COMFYUI_DIR: z.string().default("./comfyui"),
  COMFYUI_PYTHON: z.string().default("./venv-comfy/bin/python"),
  COMFYUI_PORT: z.coerce.number().int().min(1024).max(65535).default(8188),
  COMFYUI_CHECKPOINT: z.string().default("v1-5-pruned-emaonly-fp16.safetensors"),
  COMFYUI_LORA: z.string().default("lcm-lora-sdv1-5.safetensors"),
  /** DreamShaper 8 split components (Lykon/dreamshaper-8, CreativeML OpenRAIL-M): used by the cinematic profile. */
  COMFYUI_DS8_UNET: z.string().default("dreamshaper8_unet_fp16.safetensors"),
  COMFYUI_DS8_CLIP: z.string().default("dreamshaper8_clip_fp16.safetensors"),
  COMFYUI_DS8_VAE: z.string().default("dreamshaper8_vae_fp16.safetensors"),
  COMFYUI_START_TIMEOUT_MS: z.coerce.number().int().min(5000).default(180_000),
  COMFYUI_IMAGE_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(600_000),
  COMFYUI_STOP_TIMEOUT_MS: z.coerce.number().int().min(2000).default(20_000),

  PIPER_PYTHON: z.string().default("./venv-piper/bin/python"),
  PIPER_VOICES_DIR: z.string().default("./piper-voices"),
  PIPER_TIMEOUT_MS: z.coerce.number().int().min(5000).default(60_000),

  FFMPEG_PATH: optional,
  FFPROBE_PATH: optional,
  FFMPEG_ENCODER: z.enum(["auto", "h264_videotoolbox", "libx264"]).default("auto"),
  FFMPEG_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(600_000),

  SUBTITLE_HELPER: z.string().default("./bin/subpng"),
  MEMORY_WARN_FREE_PERCENT: z.coerce.number().int().min(1).max(90).default(30),
});

export interface AppConfig {
  repoRoot: string;
  server: { host: string; port: number; allowedOrigins: string[] };
  projectsDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  ollama: { url: string; model: string; timeoutMs: number; retries: number; temperature: number; unloadTimeoutMs: number; maxRepairs: number };
  comfy: {
    dir: string;
    python: string;
    host: string;
    port: number;
    checkpoint: string;
    lora: string;
    ds8: { unet: string; clip: string; vae: string };
    startTimeoutMs: number;
    imageTimeoutMs: number;
    stopTimeoutMs: number;
  };
  piper: { python: string; voicesDir: string; catalogFile: string; timeoutMs: number };
  ffmpeg: { ffmpeg: string; ffprobe: string; encoder: "auto" | "h264_videotoolbox" | "libx264"; timeoutMs: number };
  subtitles: { helper: string };
  memory: { warnFreePercent: number };
  /** Absolute executables the CommandRunner may start. Everything else is refused. */
  allowedExecutables: string[];
}

/** `localhost` and `127.0.0.1` are the same machine; a user may open the UI with either spelling. */
export function withLoopbackAliases(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost") return [origin, origin.replace("//localhost", "//127.0.0.1")];
    if (url.hostname === "127.0.0.1") return [origin, origin.replace("//127.0.0.1", "//localhost")];
  } catch {
    /* keep as-is */
  }
  return [origin];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root: string = REPO_ROOT): AppConfig {
  if (env === process.env) {
    try {
      process.loadEnvFile(path.join(root, ".env"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration (see .env.example):\n${problems}`);
  }
  const e = parsed.data;
  const abs = (p: string) => path.resolve(root, p);
  const ffmpeg = findExecutable("ffmpeg", e.FFMPEG_PATH) ?? "ffmpeg";
  const ffprobe = findExecutable("ffprobe", e.FFPROBE_PATH) ?? "ffprobe";
  const comfyPython = abs(e.COMFYUI_PYTHON);
  const piperPython = abs(e.PIPER_PYTHON);
  const helper = abs(e.SUBTITLE_HELPER);
  return {
    repoRoot: root,
    server: {
      host: e.SERVER_HOST,
      port: e.SERVER_PORT,
      allowedOrigins: [...new Set([...e.WEB_ORIGIN.split(",").flatMap((o) => withLoopbackAliases(o.trim().replace(/\/$/, ""))), ...withLoopbackAliases(`http://localhost:${e.SERVER_PORT}`)])],
    },
    projectsDir: abs(e.PROJECTS_DIR),
    logLevel: e.LOG_LEVEL,
    ollama: {
      url: e.OLLAMA_URL.replace(/\/$/, ""),
      model: e.OLLAMA_MODEL,
      timeoutMs: e.OLLAMA_TIMEOUT_MS,
      retries: e.OLLAMA_RETRIES,
      temperature: e.OLLAMA_TEMPERATURE,
      unloadTimeoutMs: e.OLLAMA_UNLOAD_TIMEOUT_MS,
      maxRepairs: e.PLANNER_MAX_REPAIR_ATTEMPTS,
    },
    comfy: {
      dir: abs(e.COMFYUI_DIR),
      python: comfyPython,
      host: "127.0.0.1",
      port: e.COMFYUI_PORT,
      checkpoint: e.COMFYUI_CHECKPOINT,
      lora: e.COMFYUI_LORA,
      ds8: { unet: e.COMFYUI_DS8_UNET, clip: e.COMFYUI_DS8_CLIP, vae: e.COMFYUI_DS8_VAE },
      startTimeoutMs: e.COMFYUI_START_TIMEOUT_MS,
      imageTimeoutMs: e.COMFYUI_IMAGE_TIMEOUT_MS,
      stopTimeoutMs: e.COMFYUI_STOP_TIMEOUT_MS,
    },
    piper: { python: piperPython, voicesDir: abs(e.PIPER_VOICES_DIR), catalogFile: path.join(root, "config", "voices.json"), timeoutMs: e.PIPER_TIMEOUT_MS },
    ffmpeg: { ffmpeg, ffprobe, encoder: e.FFMPEG_ENCODER, timeoutMs: e.FFMPEG_TIMEOUT_MS },
    subtitles: { helper },
    memory: { warnFreePercent: e.MEMORY_WARN_FREE_PERCENT },
    allowedExecutables: [ffmpeg, ffprobe, comfyPython, piperPython, helper, "/usr/bin/pgrep", "/usr/bin/memory_pressure", "/usr/sbin/sysctl"],
  };
}
