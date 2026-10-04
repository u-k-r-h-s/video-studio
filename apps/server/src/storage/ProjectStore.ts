import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  PIPELINE_STAGES,
  ProjectSchema,
  slugify,
  type CreateProjectInput,
  type FormatProfile,
  type Project,
} from "@studio/shared";
import { HttpError } from "../errors";
import { readJsonIfExists, writeJsonAtomic } from "../lib/fsjson";
import { JsonlSink, createLogger } from "../lib/logger";
import { assertSafeId, safeJoin } from "../lib/paths";

const log = createLogger("store");

/** Sub-folders of every project. */
const SUBDIRS = ["characters", "images", "audio", "subtitles", "scenes", "final", "logs"] as const;

/**
 * Filesystem-backed project store (JSON, no database). project.json is the single source of truth the pipeline
 * resumes from: stage states, scene plan, asset registry (with input hashes), errors and timestamps.
 * All callers go through this class, so SQLite could replace it later behind the same methods.
 */
export class ProjectStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly root: string,
    private readonly onChange: (projectId: string) => void = () => {},
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  dir(id: string): string {
    return safeJoin(this.root, assertSafeId(id, "project id"));
  }

  /** Resolve a project-relative path; throws on traversal. */
  resolve(id: string, ...segments: string[]): string {
    return safeJoin(this.dir(id), ...segments);
  }

  exists(id: string, rel: string): boolean {
    try {
      return existsSync(this.resolve(id, rel));
    } catch {
      return false;
    }
  }

  logSink(id: string): JsonlSink {
    return new JsonlSink(this.resolve(id, "logs", "pipeline.jsonl"));
  }

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return next;
  }

  async list(): Promise<Project[]> {
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const projects: Project[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const p = await this.get(entry.name);
        if (p) projects.push(p);
      } catch (err) {
        log.warn(`skipping unreadable project folder "${entry.name}": ${(err as Error).message}`);
      }
    }
    return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Project | undefined> {
    const raw = await readJsonIfExists(this.resolve(id, "project.json"));
    if (raw === undefined) return undefined;
    const parsed = ProjectSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`project.json for "${id}" is invalid: ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  }

  async require(id: string): Promise<Project> {
    const p = await this.get(id);
    if (!p) throw new HttpError(404, "project_not_found", `Project "${id}" does not exist`);
    return p;
  }

  async create(input: Required<Pick<CreateProjectInput, "inputMode" | "inputText">> & Partial<CreateProjectInput>, profile: FormatProfile): Promise<Project> {
    const title = input.title?.trim() || input.inputText.split(/\s+/).slice(0, 6).join(" ").slice(0, 60);
    const slug = slugify(title).slice(0, 36) || "project";
    const id = `${slug}-${randomBytes(3).toString("hex")}`;
    const now = new Date().toISOString();
    const stages = Object.fromEntries(PIPELINE_STAGES.map((s) => [s.id, { status: "pending" }])) as Project["stages"];
    const project: Project = {
      id,
      title,
      inputMode: input.inputMode,
      inputText: input.inputText,
      formatProfile: profile.id,
      language: input.language ?? "en",
      targetDurationSeconds: input.targetDurationSeconds ?? 20,
      scenes: [],
      characters: [],
      assets: [],
      audio: [],
      status: "draft",
      reviewApproved: false,
      stages,
      errors: [],
      createdAt: now,
      updatedAt: now,
    };
    const dir = this.dir(id);
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(SUBDIRS.map((d) => fs.mkdir(this.resolve(id, d), { recursive: true })));
    await writeJsonAtomic(this.resolve(id, "project.json"), ProjectSchema.parse(project));
    log.info("created project", { project: id });
    this.onChange(id);
    return project;
  }

  /** Read-modify-write under a per-project lock; the result is schema-validated before it is written. */
  update(id: string, mutate: (project: Project) => void): Promise<Project> {
    return this.withLock(id, async () => {
      const project = await this.require(id);
      mutate(project);
      project.updatedAt = new Date().toISOString();
      const valid = ProjectSchema.parse(project);
      await writeJsonAtomic(this.resolve(id, "project.json"), valid);
      this.onChange(id);
      return valid;
    });
  }

  /** Mirrors characters to characters/<id>/character.json (+ generated/ folder) for inspection and future libraries. */
  async syncCharacterFiles(project: Project): Promise<void> {
    for (const c of project.characters) {
      const dir = this.resolve(project.id, "characters", c.id);
      await fs.mkdir(this.resolve(project.id, "characters", c.id, "generated"), { recursive: true });
      await writeJsonAtomic(`${dir}/character.json`, c);
    }
  }

  /** After a crash/restart, anything still "running" can never finish: mark failed so it shows as resumable. */
  async recoverInterrupted(): Promise<string[]> {
    const recovered: string[] = [];
    for (const project of await this.list()) {
      const interrupted = PIPELINE_STAGES.filter((s) => project.stages[s.id]?.status === "running");
      if (interrupted.length === 0 && project.status !== "planning" && project.status !== "generating") continue;
      await this.update(project.id, (p) => {
        const now = new Date().toISOString();
        for (const s of interrupted) {
          p.stages[s.id] = { ...p.stages[s.id]!, status: "failed", error: "Interrupted by a server restart. Resume to continue." };
          p.errors.push({ stage: s.id, message: "Interrupted by a server restart. Resume to continue.", at: now });
        }
        p.status = p.scenes.length === 0 ? "draft" : p.reviewApproved ? "approved" : "review";
      });
      recovered.push(project.id);
      log.warn("recovered interrupted project", { project: project.id });
    }
    return recovered;
  }
}
