import type { FormatProfile, Project, StageId } from "@studio/shared";
import type { StageLog } from "../lib/stagelog";
import type { ScenePlanner } from "../planner/ScenePlanner";
import type { ProfileRegistry } from "../profiles";
import type { ImageProvider } from "../providers/image/ImageProvider";
import type { SubtitleRenderer } from "../providers/subtitle/SubtitleRenderer";
import type { TTSProvider } from "../providers/tts/TTSProvider";
import type { SceneRenderer } from "../render/SceneRenderer";
import type { MemoryAdvisor } from "../services/MemoryAdvisor";
import type { MemoryGate } from "../services/MemoryGate";
import type { ProjectStore } from "../storage/ProjectStore";

/** Provider registries: a FormatProfile selects components by key, so implementations are replaceable. */
export interface PipelineProviders {
  image: Record<string, ImageProvider>;
  tts: Record<string, TTSProvider>;
  subtitle: Record<string, SubtitleRenderer>;
  renderer: Record<string, SceneRenderer>;
}

export interface PipelineServices {
  store: ProjectStore;
  profiles: ProfileRegistry;
  planner: ScenePlanner;
  gate: MemoryGate;
  advisor: Pick<MemoryAdvisor, "snapshot">;
  providers: PipelineProviders;
  memoryWarnFreePercent: number;
}

/** Which part of a project a stage should work on. Empty scope = the whole project. */
export interface Scope {
  sceneIds?: string[];
  /** Regenerate in-scope items even if they are fresh. */
  force?: boolean;
  /** With sceneIds: also create a scene-specific background (instead of the shared location background). */
  includeBackground?: boolean;
  /** With sceneIds: also regenerate the characters used by those scenes. */
  includeCharacters?: boolean;
}

export interface StageCtx {
  projectId: string;
  scope: Scope;
  signal?: AbortSignal;
  progress: (pct: number, message: string) => void;
  log: StageLog;
}

export type StageFn = (svc: PipelineServices, ctx: StageCtx) => Promise<void>;

export const inScope = (scope: Scope, sceneId: string): boolean => !scope.sceneIds || scope.sceneIds.includes(sceneId);

export interface Loaded {
  project: Project;
  profile: FormatProfile;
}

export const STAGE_ORDER: StageId[] = ["scene_planning", "image_generation", "voice_generation", "subtitles", "scene_render", "assembly"];
