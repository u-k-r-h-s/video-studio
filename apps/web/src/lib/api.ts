import type { CreateProjectInput, HealthResponse, Job, PlanEdit, Project } from "@studio/shared";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string, public readonly hint?: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers: body !== undefined ? { "Content-Type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError("Cannot reach the studio backend. Is `npm run dev` running?", 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (data as { error?: { message?: string; code?: string; hint?: string } } | null)?.error;
    throw new ApiError(e?.message ?? `Request failed (${res.status})`, res.status, e?.code, e?.hint);
  }
  return data as T;
}

export interface ProfileInfo {
  id: string;
  pipeline?: "scenes" | "shots" | "animated";
  name: string;
  description: string;
  video: { width: number; height: number; fps: number };
  planning: { maxCharacters: number; maxLocations: number; maxPropsPerScene: number };
  timing: { minSceneSeconds: number; maxSceneSeconds: number };
}
export type RegenPart = "assets" | "voice" | "render";

export const api = {
  health: () => request<HealthResponse>("GET", "/health"),
  profiles: () => request<{ profiles: ProfileInfo[] }>("GET", "/profiles"),
  listProjects: () => request<{ projects: Project[] }>("GET", "/projects"),
  createProject: (input: CreateProjectInput) => request<{ project: Project; job: Job }>("POST", "/projects", input),
  getProject: (id: string) => request<{ project: Project; activeJob: Job | null }>("GET", `/projects/${id}`),
  savePlan: (id: string, plan: PlanEdit) => request<{ project: Project }>("PUT", `/projects/${id}/plan`, plan),
  approve: (id: string) => request<{ project: Project }>("POST", `/projects/${id}/approve`),
  replan: (id: string, feedback?: string) => request<{ job: Job }>("POST", `/projects/${id}/replan`, feedback ? { feedback } : {}),
  produce: (id: string) => request<{ job: Job }>("POST", `/projects/${id}/produce`),
  regenerateScene: (id: string, sceneId: string, opts: { parts?: RegenPart[]; includeBackground?: boolean }) =>
    request<{ job: Job }>("POST", `/projects/${id}/scenes/${sceneId}/regenerate`, opts),
  cancelJob: (jobId: string) => request<{ job: Job }>("POST", `/jobs/${jobId}/cancel`),
};

/** URL of a generated file inside a project (images, audio, video, SRT). */
export const mediaUrl = (projectId: string, rel: string, cacheBust?: string): string =>
  `/api/projects/${projectId}/media/${rel.split("/").map(encodeURIComponent).join("/")}${cacheBust ? `?v=${encodeURIComponent(cacheBust)}` : ""}`;
