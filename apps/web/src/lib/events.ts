import { useEffect, useRef, useState } from "react";
import type { Job } from "@studio/shared";

type ServerEvent =
  | { type: "snapshot"; jobs: Job[] }
  | { type: "job"; job: Job }
  | { type: "project"; projectId: string };

type Listener = (event: ServerEvent) => void;

/** One shared EventSource for the whole app; the browser reconnects automatically. */
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function ensureSource(): void {
  if (source) return;
  const es = new EventSource("/api/events");
  const dispatch = (event: ServerEvent) => listeners.forEach((l) => l(event));
  es.addEventListener("snapshot", (e) => dispatch({ type: "snapshot", jobs: (JSON.parse((e as MessageEvent).data) as { jobs: Job[] }).jobs }));
  es.addEventListener("job", (e) => dispatch({ type: "job", job: JSON.parse((e as MessageEvent).data) as Job }));
  es.addEventListener("project", (e) => dispatch({ type: "project", projectId: (JSON.parse((e as MessageEvent).data) as { projectId: string }).projectId }));
  source = es;
}

export function useServerEvents(listener: Listener): void {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    ensureSource();
    const fn: Listener = (e) => ref.current(e);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
}

/** Live view of all jobs, keyed by id. */
export function useJobs(): Map<string, Job> {
  const [jobs, setJobs] = useState<Map<string, Job>>(new Map());
  useServerEvents((e) => {
    if (e.type === "snapshot") setJobs(new Map(e.jobs.map((j) => [j.id, j])));
    else if (e.type === "job") setJobs((prev) => new Map(prev).set(e.job.id, e.job));
  });
  return jobs;
}
