import { PIPELINE_STAGES, type Project } from "@studio/shared";

const ICON: Record<string, { glyph: string; cls: string }> = {
  completed: { glyph: "✓", cls: "text-emerald-400" },
  running: { glyph: "⏳", cls: "text-amber-300" },
  failed: { glyph: "✕", cls: "text-red-400" },
  cancelled: { glyph: "■", cls: "text-zinc-400" },
  pending: { glyph: "○", cls: "text-zinc-600" },
};

export function StageList({ stages }: { stages: Project["stages"] }) {
  return (
    <ol className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-3">
      {PIPELINE_STAGES.map((s) => {
        const st = stages[s.id] ?? { status: "pending" as const };
        const icon = ICON[st.status] ?? ICON.pending!;
        return (
          <li key={s.id} className="flex items-center gap-2" title={st.error}>
            <span className={icon.cls}>{icon.glyph}</span>
            <span className={st.status === "pending" ? "text-zinc-500" : ""}>{s.label}</span>
            {st.durationMs != null && st.status === "completed" && <span className="text-xs text-zinc-600">{(st.durationMs / 1000).toFixed(1)}s</span>}
          </li>
        );
      })}
    </ol>
  );
}
