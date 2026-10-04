import { z } from "zod";
import { assembleFinal } from "../pipeline/stages/assemble";
import { generateImages } from "../pipeline/stages/generateImages";
import { generateVoices } from "../pipeline/stages/generateVoices";
import { buildSceneTimelines } from "../pipeline/stages/buildTimeline";
import { planScenes } from "../pipeline/stages/planScenes";
import { assembleShots } from "../pipeline/stages/shots/assembleShots";
import { buildShotTimeline } from "../pipeline/stages/shots/buildShotTimeline";
import { generateKeyVisuals } from "../pipeline/stages/shots/generateKeyVisuals";
import { generateShotVoices } from "../pipeline/stages/shots/generateShotVoices";
import { planStory } from "../pipeline/stages/shots/planStory";
import { renderShots } from "../pipeline/stages/shots/renderShots";
import { renderScenes } from "../pipeline/stages/renderScenes";
import type { PipelineRunner } from "../pipeline/PipelineRunner";
import type { Job } from "@studio/shared";
import type { Tool } from "./Tool";
import { ToolRegistry } from "./ToolDispatcher";

const ProjectInput = z.object({ projectId: z.string().min(1) });
const ScopeInput = ProjectInput.extend({
  sceneIds: z.array(z.string()).optional(),
  force: z.boolean().optional(),
});

/** The six tools of this MVP. Names are the allow-list. */
export const TOOL_NAMES = ["create_scene_plan", "generate_images", "generate_voice", "render_scene", "assemble_video", "get_job_status"] as const;

export function createPipelineTools(runner: PipelineRunner, getJob: (id: string) => Job | undefined): ToolRegistry {
  const createScenePlan: Tool<z.infer<typeof ProjectInput> & { feedback?: string }, { ok: true }> = {
    name: "create_scene_plan",
    description: "Ask Ollama to turn the project's idea or script into a validated scene plan (then unloads Ollama and verifies it).",
    inputSchema: ProjectInput.extend({ feedback: z.string().max(500).optional() }),
    async execute(i, ctx) {
      const shots = (await runner.pipelineOf(i.projectId)) === "shots";
      await runner.runStage(i.projectId, "scene_planning", shots ? planStory(i.feedback) : planScenes(i.feedback), {}, ctx);
      return { ok: true };
    },
  };
  const generateImagesTool: Tool<z.infer<typeof ScopeInput> & { includeBackground?: boolean; includeCharacters?: boolean }, { ok: true }> = {
    name: "generate_images",
    description: "Generate all missing/stale background, character and prop images for the project in ONE ComfyUI session (Ollama is unloaded first; ComfyUI is stopped and verified afterwards).",
    inputSchema: ScopeInput.extend({ includeBackground: z.boolean().optional(), includeCharacters: z.boolean().optional() }),
    async execute(i, ctx) {
      const shots = (await runner.pipelineOf(i.projectId)) === "shots";
      await runner.runStage(i.projectId, "image_generation", shots ? generateKeyVisuals : generateImages, { sceneIds: i.sceneIds, force: i.force, includeBackground: i.includeBackground, includeCharacters: i.includeCharacters }, ctx);
      return { ok: true };
    },
  };
  const generateVoice: Tool<z.infer<typeof ScopeInput>, { ok: true }> = {
    name: "generate_voice",
    description: "Generate Piper voice audio for the dialogue (trimmed of silence). Requires ComfyUI to be stopped.",
    inputSchema: ScopeInput,
    async execute(i, ctx) {
      const shots = (await runner.pipelineOf(i.projectId)) === "shots";
      await runner.runStage(i.projectId, "voice_generation", shots ? generateShotVoices : generateVoices, { sceneIds: i.sceneIds, force: i.force }, ctx);
      return { ok: true };
    },
  };
  const renderScene: Tool<z.infer<typeof ScopeInput>, { ok: true }> = {
    name: "render_scene",
    description: "Build the voice timeline and subtitle images, then render the motion-comic clip of each scene with FFmpeg (cached; only changed scenes are re-rendered).",
    inputSchema: ScopeInput,
    async execute(i, ctx) {
      const scope = { sceneIds: i.sceneIds, force: i.force };
      const shots = (await runner.pipelineOf(i.projectId)) === "shots";
      await runner.runStage(i.projectId, "subtitles", shots ? buildShotTimeline : buildSceneTimelines, scope, { ...ctx, progress: (p, m) => ctx.progress?.(p / 2, m) });
      await runner.runStage(i.projectId, "scene_render", shots ? renderShots : renderScenes, scope, { ...ctx, progress: (p, m) => ctx.progress?.(50 + p / 2, m) });
      return { ok: true };
    },
  };
  const assembleVideo: Tool<z.infer<typeof ProjectInput> & { force?: boolean }, { ok: true }> = {
    name: "assemble_video",
    description: "Join the rendered scene clips into the final 1080x1920 MP4 and write the SRT.",
    inputSchema: ProjectInput.extend({ force: z.boolean().optional() }),
    async execute(i, ctx) {
      const shots = (await runner.pipelineOf(i.projectId)) === "shots";
      await runner.runStage(i.projectId, "assembly", shots ? assembleShots : assembleFinal, { force: i.force }, ctx);
      return { ok: true };
    },
  };
  const getJobStatus: Tool<{ jobId: string }, { job: Job | null }> = {
    name: "get_job_status",
    description: "Read the status and progress of a job.",
    inputSchema: z.object({ jobId: z.string().min(1) }),
    async execute(i) {
      return { job: getJob(i.jobId) ?? null };
    },
  };
  return new ToolRegistry().register(createScenePlan).register(generateImagesTool).register(generateVoice).register(renderScene).register(assembleVideo).register(getJobStatus);
}
