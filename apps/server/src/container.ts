import type { AppConfig } from "./config";
import { EventBus } from "./events";
import { JobManager } from "./jobs/JobManager";
import { ExecFileRunner, type CommandRunner } from "./lib/command";
import { OllamaProvider } from "./llm/OllamaProvider";
import { PipelineRunner } from "./pipeline/PipelineRunner";
import { Studio } from "./pipeline/Studio";
import type { PipelineServices } from "./pipeline/types";
import { ScenePlanner } from "./planner/ScenePlanner";
import { ProfileRegistry } from "./profiles";
import { ComfyProcess } from "./providers/image/ComfyProcess";
import { ComfyUIProvider } from "./providers/image/ComfyUIProvider";
import { CoreTextSubtitleRenderer } from "./providers/subtitle/CoreTextSubtitleRenderer";
import { PiperProvider } from "./providers/tts/PiperProvider";
import { loadVoiceCatalog } from "./providers/tts/voices";
import { FFmpegMotionRenderer } from "./render/FFmpegMotionRenderer";
import { HealthService } from "./services/HealthService";
import { MemoryAdvisor } from "./services/MemoryAdvisor";
import { MemoryGate } from "./services/MemoryGate";
import { OllamaController } from "./services/OllamaController";
import { ProjectStore } from "./storage/ProjectStore";
import { createPipelineTools, TOOL_NAMES } from "./tools/pipelineTools";
import { ToolDispatcher, type ToolRegistry } from "./tools/ToolDispatcher";

export interface Container {
  config: AppConfig;
  runner: CommandRunner;
  bus: EventBus;
  store: ProjectStore;
  jobs: JobManager;
  profiles: ProfileRegistry;
  svc: PipelineServices;
  pipeline: PipelineRunner;
  tools: ToolRegistry;
  dispatcher: ToolDispatcher;
  studio: Studio;
  health: HealthService;
  gate: MemoryGate;
}

/** Wires the real local providers together. Every provider is created here and nowhere else. */
export function createContainer(config: AppConfig): Container {
  const runner = new ExecFileRunner(config.allowedExecutables);
  const bus = new EventBus();
  const store = new ProjectStore(config.projectsDir, (projectId) => bus.emit("project", { projectId }));
  const jobs = new JobManager(bus, 1);
  const profiles = new ProfileRegistry();

  const llm = new OllamaProvider(config.ollama);
  const ollama = new OllamaController(config.ollama.url, runner);
  const comfyProcess = new ComfyProcess(runner, config.comfy);
  const gate = new MemoryGate(ollama, comfyProcess, { unloadTimeoutMs: config.ollama.unloadTimeoutMs });
  const image = new ComfyUIProvider(comfyProcess, gate, {
    baseUrl: `http://${config.comfy.host}:${config.comfy.port}`, checkpoint: config.comfy.checkpoint, lora: config.comfy.lora, imageTimeoutMs: config.comfy.imageTimeoutMs,
  });
  const tts = new PiperProvider(runner, config.piper, loadVoiceCatalog(config.piper.catalogFile));
  const subtitle = new CoreTextSubtitleRenderer(runner, config.subtitles.helper);
  const renderer = new FFmpegMotionRenderer(runner, { ffmpeg: config.ffmpeg.ffmpeg, ffprobe: config.ffmpeg.ffprobe, timeoutMs: config.ffmpeg.timeoutMs, encoderOverride: config.ffmpeg.encoder });

  const svc: PipelineServices = {
    store, profiles, gate,
    planner: new ScenePlanner(llm, { maxRepairs: config.ollama.maxRepairs, temperature: config.ollama.temperature }),
    advisor: new MemoryAdvisor(runner), memoryWarnFreePercent: config.memory.warnFreePercent,
    providers: { image: { [image.name]: image }, tts: { [tts.name]: tts }, subtitle: { [subtitle.name]: subtitle }, renderer: { [renderer.name]: renderer } },
  };
  const pipeline = new PipelineRunner(svc);
  const tools = createPipelineTools(pipeline, (id) => jobs.get(id));
  const dispatcher = new ToolDispatcher(tools, TOOL_NAMES);
  const studio = new Studio(svc, dispatcher);
  const health = new HealthService({ config, llm, image, tts, subtitle, renderer, ollama, comfy: comfyProcess });
  return { config, runner, bus, store, jobs, profiles, svc, pipeline, tools, dispatcher, studio, health, gate };
}
