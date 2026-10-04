import { useCallback, useEffect, useState } from "react";
import type { Project } from "@studio/shared";
import { api } from "../lib/api";
import { useServerEvents } from "../lib/events";
import { projectHref } from "../lib/route";

export function ProjectList() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const load = useCallback(() => api.listProjects().then((r) => setProjects(r.projects)).catch(() => setProjects([])), []);
  useEffect(() => { void load(); }, [load]);
  useServerEvents((e) => { if (e.type === "project") void load(); });
  if (!projects) return null;
  if (projects.length === 0) return <p className="text-sm text-zinc-500">No projects yet.</p>;
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Projects</h2>
      <ul className="grid gap-2 md:grid-cols-2">
        {projects.map((p) => (
          <li key={p.id}>
            <a href={projectHref(p.id)} className="block rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 hover:border-zinc-600">
              <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{p.title}</span><span className="text-xs text-zinc-400">{p.status}</span></div>
              <div className="mt-1 text-xs text-zinc-500">{p.formatProfile} · {p.language} · {p.scenes.length} scenes · {new Date(p.updatedAt).toLocaleString()}</div>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
