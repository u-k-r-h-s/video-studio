import type { CreateProjectInput, HealthResponse, Job, Project, Story } from "@studio/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Cannot reach the backend. Is `npm run dev` running?", 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } } | null)?.error;
    throw new ApiError(err?.message ?? `Request failed (${res.status})`, res.status, err?.code);
  }
  return data as T;
}

export interface ProjectDetail {
  project: Project;
  story: Story | null;
  activeJob: Job | null;
}

export const api = {
  health: () => request<HealthResponse>("GET", "/health"),
  listProjects: () => request<{ projects: Project[] }>("GET", "/projects"),
  createProject: (input: CreateProjectInput) => request<{ project: Project; job: Job }>("POST", "/projects", input),
  getProject: (id: string) => request<ProjectDetail>("GET", `/projects/${id}`),
  saveStory: (id: string, story: Story) => request<{ project: Project; story: Story }>("PUT", `/projects/${id}/story`, story),
  regenerateStory: (id: string, feedback?: string) =>
    request<{ job: Job }>("POST", `/projects/${id}/story/regenerate`, feedback ? { feedback } : {}),
  cancelJob: (jobId: string) => request<{ job: Job }>("POST", `/jobs/${jobId}/cancel`),
};
