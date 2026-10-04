import { useEffect, useState } from "react";
import type { HealthResponse, ServiceName } from "@studio/shared";
import { api } from "../lib/api";

const SERVICES: { id: ServiceName; label: string }[] = [
  { id: "ollama", label: "Ollama" },
  { id: "comfyui", label: "ComfyUI" },
  { id: "piper", label: "Piper" },
  { id: "subtitles", label: "Subtitles" },
  { id: "ffmpeg", label: "FFmpeg" },
];

export function HealthBar() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () => api.health().then((h) => !cancelled && (setHealth(h), setDown(false))).catch(() => !cancelled && setDown(true));
    void load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (down) return <p className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">Backend is not reachable. Start it with <code>npm run dev</code>.</p>;
  if (!health) return <p className="text-sm text-zinc-500">Checking services...</p>;
  const broken = SERVICES.filter((s) => health.services[s.id].status !== "ready");
  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-2">
        {SERVICES.map((s) => {
          const d = health.services[s.id];
          const ok = d.status === "ready";
          return (
            <li key={s.id} title={`${d.message}${d.hint ? `\n${d.hint}` : ""}`} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${ok ? "border-emerald-800 bg-emerald-950/40 text-emerald-300" : "border-red-900 bg-red-950/40 text-red-300"}`}>
              <span className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-400" : "bg-red-500"}`} />
              {s.label}
            </li>
          );
        })}
        <li title="Heavy models must never be resident together (8 GB). Ollama and ComfyUI take turns." className="flex items-center gap-2 rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-400">
          memory: Ollama {health.gates.ollamaResident ? "loaded" : "unloaded"} · ComfyUI {health.gates.comfyuiRunning ? "running" : "stopped"}
        </li>
      </ul>
      {broken.map((s) => (
        <p key={s.id} className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          <strong>{s.label}:</strong> {health.services[s.id].message} {health.services[s.id].hint}
        </p>
      ))}
    </div>
  );
}
