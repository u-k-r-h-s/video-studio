import type { ReactNode } from "react";

export const field = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:opacity-50";
export const btn = "rounded-md px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40";
export const btnPrimary = `${btn} bg-indigo-600 hover:bg-indigo-500`;
export const btnGhost = `${btn} border border-zinc-700 hover:border-zinc-500`;

export function Panel({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export const prettyId = (s: string) => s.replaceAll("_", " ").replaceAll("-", " ");
