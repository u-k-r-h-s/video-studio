import { HttpError, StageOrderError } from "../errors";
import type { ToolContext } from "../tools/Tool";
import type { ToolDispatcher } from "../tools/ToolDispatcher";
import { applyPlanEdit } from "./planEdit";
import type { PipelineServices } from "./types";

export type RegenPart = "assets" | "voice" | "render";

export interface RegenOptions {
  /** What to regenerate for the scene. Default: everything (assets + voice + render). */
  parts?: RegenPart[];
  /** Give the scene its own background instead of the shared location one. */
  includeBackground?: boolean;
  /** Also regenerate the characters used in the scene (shared with other scenes!). */
  includeCharacters?: boolean;
}

/**
 * Application service: sequences the allow-listed tools. This is the "constrained orchestration": a fixed,
 * deterministic order with memory gates enforced inside the stages; no model decides what runs next.
 */
export class Studio {
  constructor(
    private readonly svc: PipelineServices,
    private readonly dispatcher: ToolDispatcher,
  ) {}

  /** Idea/Script -> validated scene plan -> waits for human review. */
  async plan(projectId: string, ctx: ToolContext = {}, feedback?: string): Promise<void> {
    await this.dispatcher.dispatch("create_scene_plan", { projectId, feedback }, ctx);
  }

  async approve(projectId: string): Promise<void> {
    const p = await this.svc.store.require(projectId);
    if (p.scenes.length === 0) throw new StageOrderError("There is no scene plan to approve yet.");
    await this.svc.store.update(projectId, (x) => {
      x.reviewApproved = true;
      if (x.status === "review" || x.status === "draft") x.status = "approved";
    });
  }

  async editPlan(projectId: string, edit: unknown): Promise<void> {
    const p = await this.svc.store.require(projectId);
    if (p.status === "planning" || p.status === "generating") throw new HttpError(409, "project_busy", "The project is being processed. Wait for it to finish or cancel it.");
    if ((this.svc.profiles.get(p.formatProfile).pipeline ?? "scenes") !== "scenes") throw new HttpError(400, "plan_not_editable", "Shot-based projects cannot be edited here yet. Ask for a re-plan with feedback instead.");
    const next = applyPlanEdit(p, edit, this.svc.profiles.get(p.formatProfile));
    await this.svc.store.update(projectId, (x) => {
      x.title = next.title;
      x.characters = next.characters;
      x.scenes = next.scenes;
      if (x.status === "completed") x.status = x.reviewApproved ? "approved" : "review";
    });
    await this.svc.store.syncCharacterFiles(await this.svc.store.require(projectId));
  }

  /** images -> voices -> timeline/subtitles/render -> final video. Idempotent and resumable: finished work is skipped. */
  async produce(projectId: string, ctx: ToolContext = {}): Promise<void> {
    const p = await this.svc.store.require(projectId);
    if (!p.reviewApproved) throw new StageOrderError("Review and approve the scene plan before generating.");
    const slice = (from: number, to: number): ToolContext => ({ ...ctx, progress: (pct, msg) => ctx.progress?.(from + ((to - from) * pct) / 100, msg) });
    await this.dispatcher.dispatch("generate_images", { projectId }, slice(0, 60));
    await this.dispatcher.dispatch("generate_voice", { projectId }, slice(60, 70));
    await this.dispatcher.dispatch("render_scene", { projectId }, slice(70, 92));
    await this.dispatcher.dispatch("assemble_video", { projectId }, slice(92, 100));
  }

  /**
   * Regenerate ONE scene without touching the others. Only the requested parts are forced; everything else is
   * served from cache (input hashes), and the final video is re-assembled from the cached + new clips.
   */
  async regenerateScene(projectId: string, sceneId: string, opts: RegenOptions = {}, ctx: ToolContext = {}): Promise<void> {
    const p = await this.svc.store.require(projectId);
    if (!p.reviewApproved) throw new StageOrderError("Review and approve the scene plan before generating.");
    if (!p.scenes.some((s) => s.id === sceneId)) throw new HttpError(404, "scene_not_found", `Scene "${sceneId}" does not exist`);
    const parts = new Set<RegenPart>(opts.parts?.length ? opts.parts : ["assets", "voice", "render"]);
    const sceneIds = [sceneId];
    const slice = (from: number, to: number): ToolContext => ({ ...ctx, progress: (pct, msg) => ctx.progress?.(from + ((to - from) * pct) / 100, msg) });
    // images are always checked (cheap when cached); forced only when requested
    await this.dispatcher.dispatch("generate_images", { projectId, sceneIds, force: parts.has("assets"), includeBackground: parts.has("assets") && opts.includeBackground, includeCharacters: parts.has("assets") && opts.includeCharacters }, slice(0, 60));
    await this.dispatcher.dispatch("generate_voice", { projectId, sceneIds, force: parts.has("voice") }, slice(60, 70));
    await this.dispatcher.dispatch("render_scene", { projectId, sceneIds, force: parts.has("render") }, slice(70, 92));
    await this.dispatcher.dispatch("assemble_video", { projectId }, slice(92, 100));
  }
}
