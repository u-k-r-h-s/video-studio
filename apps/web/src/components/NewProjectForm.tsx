import { useEffect, useState, type FormEvent } from "react";
import { LANGUAGES, type InputMode, type LanguageId } from "@studio/shared";
import { api, type ProfileInfo } from "../lib/api";
import { projectHref } from "../lib/route";
import { btnPrimary, field } from "./ui";

const DURATIONS = [15, 20, 30, 45, 60];

export function NewProjectForm() {
  const [mode, setMode] = useState<InputMode>("idea");
  const [text, setText] = useState("");
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [profile, setProfile] = useState("motion-comic");
  const [language, setLanguage] = useState<LanguageId>("en");
  const [duration, setDuration] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.profiles().then((r) => setProfiles(r.profiles)).catch(() => {}); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject({ inputMode: mode, inputText: text, formatProfile: profile, language, targetDurationSeconds: duration });
      window.location.hash = projectHref(project.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">New project</h2>
        <div className="flex overflow-hidden rounded-md border border-zinc-700 text-sm">
          {(["idea", "script"] as const).map((m) => (
            <button type="button" key={m} onClick={() => setMode(m)} className={`px-3 py-1 ${mode === m ? "bg-indigo-600" : "hover:bg-zinc-800"}`}>{m === "idea" ? "Idea" : "Script"}</button>
          ))}
        </div>
      </div>
      <label className="block space-y-1">
        <span className="text-sm text-zinc-400">{mode === "idea" ? "Story idea" : "Script (dialogue is kept exactly as written)"}</span>
        <textarea className={`${field} ${mode === "script" ? "min-h-48 font-mono" : "min-h-24"}`} value={text} onChange={(e) => setText(e.target.value)} required maxLength={8000}
          placeholder={mode === "idea" ? "A clever village detective catches a thief who keeps stealing food at night." : "RAGHU: Someone is stealing food from my shop.\nNARRATOR: He set a simple trap."} />
      </label>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <label className="space-y-1">
          <span className="text-sm text-zinc-400">Format</span>
          <select className={field} value={profile} onChange={(e) => setProfile(e.target.value)}>
            {(profiles.length ? profiles : [{ id: "motion-comic", name: "Motion comic" } as ProfileInfo]).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-sm text-zinc-400">Language</span>
          <select className={field} value={language} onChange={(e) => setLanguage(e.target.value as LanguageId)}>
            {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-sm text-zinc-400">Target length</span>
          <select className={field} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {DURATIONS.map((d) => <option key={d} value={d}>{d} seconds</option>)}
          </select>
        </label>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button type="submit" disabled={busy || text.trim().length < 10} className={btnPrimary}>{busy ? "Creating..." : "Generate scenes"}</button>
    </form>
  );
}
