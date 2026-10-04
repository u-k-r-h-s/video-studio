// API-level types shared by server and web.

export type ServiceName = "ollama" | "comfyui" | "piper" | "ffmpeg" | "subtitles";
export type ServiceStatus = "ready" | "unavailable";

export interface ServiceDetail {
  status: ServiceStatus;
  message: string;
  /** Setup instructions when unavailable. */
  hint?: string;
}

export interface HealthResponse {
  services: Record<ServiceName, ServiceDetail>;
  /** Memory gates: heavy models that must NOT be resident at the same time. */
  gates: { ollamaResident: boolean; comfyuiRunning: boolean };
  checkedAt: string;
}

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type JobType = "pipeline";

export interface Job {
  id: string;
  type: JobType;
  projectId: string;
  /** Which stage(s) this job runs, e.g. "scene_planning" or "image_generation..assembly". */
  label: string;
  sceneId: string | null;
  progress: number;
  status: JobStatus;
  message: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const isJobActive = (job: Pick<Job, "status">): boolean => job.status === "queued" || job.status === "running";
