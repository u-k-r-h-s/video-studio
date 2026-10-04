import { useCallback, useEffect, useState } from "react";
import { FINAL_VIDEO_ASSET_ID, isJobActive, type Character, type Job, type Scene } from "@studio/shared";
import { api, mediaUrl, type ProfileInfo, type RegenPart } from "../lib/api";
import type { Project } from "@studio/shared";
import { useJobs, useServerEvents } from "../lib/events";
import { homeHref } from "../lib/route";
import { SceneCard } from "./SceneCard";
import { SceneEditor } from "./SceneEditor";
import { ShotList } from "./ShotList";
import { StageList } from "./StageList";
import { btnGhost, btnPrimary, field, Panel } from "./ui";

export function ProjectView({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [initialJob, setInitialJob] = useState<Job | null>(null);
  const [profile, setProfile] = useState<ProfileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const jobs = useJobs();

  const load = useCallback(() => api.getProject(id).then((r) => { setProject(r.project); setInitialJob(r.activeJob); setError(null); }).catch((e: Error) => setError(e.message)), [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void api.profiles().then((r) => setProfile(r.profiles.find((p) => p.id === project?.formatProfile) ?? null)).catch(() => {}); }, [project?.formatProfile]);
  useServerEvents((e) => { if (e.type === "project" && e.projectId === id) void load(); if (e.type === "job" && e.job.projectId === id && !isJobActive(e.job)) void load(); });

  const live = [...jobs.values()].filter((j) => j.projectId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const activeJob = live.find(isJobActive) ?? (live.length === 0 ? initialJob : null);
  const lastFailed = !activeJob && live[0]?.status === "failed" ? live[0] : null;

  if (error && !project) return <p className="text-red-400">{error}</p>;
  if (!project) return <p className="text-zinc-500">Loading...</p>;
  const busy = activeJob !== null;
  const run = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };

  const savePlan = (characters: Character[], scenes: Scene[]) => api.savePlan(id, { title: project.title, characters, scenes });
  const finalVideo = project.assets.find((a) => a.id === FINAL_VIDEO_ASSET_ID && a.status === "ready");
  const failedStage = Object.entries(project.stages).find(([, s]) => s.status === "failed");
  const hasPlan = project.scenes.length > 0;
  const stageError = failedStage?.[1].error ?? lastFailed?.error ?? null;

  return (
    <div className="space-y-5">
      <div>
        <a href={homeHref} className="text-sm text-zinc-500 hover:text-zinc-300">← All projects</a>
        <h1 className="mt-1 text-2xl font-bold">{project.title}</h1>
        <p className="mt-1 text-sm text-zinc-400">{project.inputMode === "idea" ? "Idea" : "Script"}: <span className="text-zinc-500">{project.inputText.length > 200 ? `${project.inputText.slice(0, 200)}...` : project.inputText}</span></p>
        <p className="mt-1 text-xs text-zinc-500">{project.formatProfile} · {profile ? `${profile.video.width}x${profile.video.height} ${profile.video.fps}fps` : ""} · {project.language} · status <strong className="text-zinc-300">{project.status}</strong></p>
      </div>

      <Panel title="Progress">
        <StageList stages={project.stages} />
        {activeJob && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-sm"><span className="text-amber-200">{activeJob.message ?? activeJob.status}</span><button onClick={() => void api.cancelJob(activeJob.id)} className="text-xs text-zinc-400 underline hover:text-zinc-200">Cancel</button></div>
            <div className="h-2 overflow-hidden rounded bg-zinc-800"><div className="h-full bg-indigo-500 transition-all" style={{ width: `${activeJob.progress}%` }} /></div>
          </div>
        )}
        {!activeJob && stageError && <p className="whitespace-pre-wrap rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{stageError}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </Panel>

      {hasPlan && (
        <Panel
          title={project.story ? (project.reviewApproved ? "Shot list (approved)" : "Review the shot list") : project.reviewApproved ? "Scene plan (approved: edits only regenerate what changed)" : "Review the scene plan"}
          right={!project.reviewApproved ? <button className={btnPrimary} disabled={busy} onClick={() => void run(() => api.approve(id))}>Approve plan</button> : undefined}
        >
          {!project.reviewApproved && <p className="text-sm text-zinc-400">{project.story ? "Read the director's shots below (use Re-plan with a note to change them). " : "Check and edit the scenes below. "}Nothing heavy (images, voices, rendering) starts until you approve.</p>}
          <details className="text-sm text-zinc-400">
            <summary className="cursor-pointer">Characters ({project.characters.length}): reused in every image of the character</summary>
            <ul className="mt-2 grid gap-3 md:grid-cols-2">
              {project.characters.map((c, i) => (
                <li key={c.id} className="space-y-1 rounded-lg border border-zinc-800 p-3">
                  <div className="font-medium text-zinc-200">{c.name} <span className="text-xs text-zinc-500">({c.id})</span></div>
                  <label className="block text-xs text-zinc-500">Appearance (the image prompt fragment)
                    <textarea className={`${field} mt-1`} defaultValue={c.appearance} disabled={busy || !!project.story} onBlur={(e) => { if (e.target.value.trim() !== c.appearance) void run(() => savePlan(project.characters.map((x, n) => (n === i ? { ...x, appearance: e.target.value.trim() } : x)), project.scenes)); }} />
                  </label>
                  {(() => { const a = project.assets.find((x) => x.id === `char-${c.id}` && x.status === "ready"); return a ? <img alt={c.name} className="h-40 rounded bg-zinc-800 object-contain" src={mediaUrl(id, a.path, `${a.meta.attempt}`)} /> : null; })()}
                </li>
              ))}
            </ul>
          </details>
          {project.story ? (
            <ShotList project={project} busy={busy} onRegenerate={(sceneId, parts) => { if (parts.includes("assets") && !window.confirm("Regenerate this scene's images? This unloads Ollama and runs ComfyUI (about 40 s per image); every shot that shares those images is re-rendered.")) return; void run(() => api.regenerateScene(id, sceneId, { parts })); }} />
          ) : (
          <div className="space-y-3">
            {project.scenes.map((s, i) => (
              <SceneCard key={s.id} project={project} scene={s} busy={busy} onEdit={() => setEditing(i)}
                onRegenerate={(parts: RegenPart[], includeBackground) => { if (parts.includes("assets") && !window.confirm("Regenerate this scene's images? This unloads Ollama, runs ComfyUI for roughly 40 s per image, and re-renders only this scene.")) return; void run(() => api.regenerateScene(id, s.id, { parts, includeBackground })); }} />
            ))}
          </div>
          )}
        </Panel>
      )}

      {hasPlan && (
        <Panel title="Generate">
          <p className="text-sm text-zinc-400">Runs strictly one heavy model at a time: Ollama is unloaded, ComfyUI makes all images in one session and is stopped, then Piper and FFmpeg run. Finished work is skipped, so this also resumes after a failure.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button className={btnPrimary} disabled={busy || !project.reviewApproved} onClick={() => void run(() => api.produce(id))}>{project.status === "failed" ? "Resume generation" : finalVideo ? "Re-run (only changed parts)" : "Generate video"}</button>
            <input className={`${field} max-w-xs`} placeholder="Optional note for a re-plan, e.g. make it funnier" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            <button className={btnGhost} disabled={busy} onClick={() => { if (window.confirm("Ask Ollama for a new plan? This replaces the scenes (generated images are re-used when the prompts still match).")) void run(() => api.replan(id, note.trim() || undefined)); }}>Re-plan with Ollama</button>
          </div>
        </Panel>
      )}

      {finalVideo && (
        <Panel title="Final video" right={<div className="flex gap-3 text-sm"><a className="text-indigo-300 underline" href={`${mediaUrl(id, finalVideo.path)}?download=1`}>Download MP4</a><a className="text-indigo-300 underline" href={`${mediaUrl(id, "final/subtitles.srt")}?download=1`}>Download SRT</a></div>}>
          <video controls className="max-h-[32rem] rounded-lg border border-zinc-800" src={mediaUrl(id, finalVideo.path, finalVideo.createdAt)} />
          <p className="text-xs text-zinc-500">{String(finalVideo.meta.width)}x{String(finalVideo.meta.height)} · {String(finalVideo.meta.fps)} fps · {Number(finalVideo.meta.durationSec).toFixed(1)} s · {String(finalVideo.meta.encoder)}</p>
        </Panel>
      )}

      {project.assets.some((a) => ["background", "character", "prop", "key_visual"].includes(a.kind)) && (
        <Panel title="Generated images">
          <ul className="flex flex-wrap gap-3">
            {project.assets.filter((a) => ["background", "character", "prop", "key_visual"].includes(a.kind) && a.status === "ready").map((a) => (
              <li key={a.id} className="w-28 text-center text-xs text-zinc-500"><img alt={a.id} className="h-40 w-28 rounded bg-zinc-800 object-contain" src={mediaUrl(id, a.path, `${a.meta.attempt}`)} />{a.id}</li>
            ))}
          </ul>
        </Panel>
      )}

      {editing !== null && project.scenes[editing] && (
        <SceneEditor scene={project.scenes[editing]!} characters={project.characters} maxProps={profile?.planning.maxPropsPerScene ?? 2} onCancel={() => setEditing(null)}
          onSave={async (s) => { await savePlan(project.characters, project.scenes.map((x, n) => (n === editing ? s : x))); setEditing(null); await load(); }} />
      )}
    </div>
  );
}
