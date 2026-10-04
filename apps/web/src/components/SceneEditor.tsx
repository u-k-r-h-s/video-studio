import { useState } from "react";
import { CAMERA_MOVEMENTS, EMOTIONS, EMPHASES, ENTRANCES, NARRATOR_ID, SHOTS, SceneSchema, type Character, type Dialogue, type Scene } from "@studio/shared";
import { btnGhost, btnPrimary, field, prettyId } from "./ui";

interface Props {
  scene: Scene;
  characters: Character[];
  maxProps: number;
  onCancel: () => void;
  onSave: (scene: Scene) => Promise<void>;
}

const friendlyPath = (path: PropertyKey[]): string => {
  const words = path.map((p, i) => (typeof p === "number" ? `${i > 0 && path[i - 1] === "dialogue" ? "line " : "#"}${p + 1}` : prettyId(String(p))));
  const t = words.join(" ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function SceneEditor({ scene, characters, maxProps, onCancel, onSave }: Props) {
  const [d, setD] = useState<Scene>(() => structuredClone(scene));
  const [propsText, setPropsText] = useState(scene.props.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const patch = (p: Partial<Scene>) => setD((x) => ({ ...x, ...p }));
  const speakers = [NARRATOR_ID, ...d.characters];

  function toggleCharacter(id: string) {
    const characters = d.characters.includes(id) ? d.characters.filter((c) => c !== id) : [...d.characters, id];
    patch({ characters, dialogue: d.dialogue.map((l) => (l.characterId === NARRATOR_ID || characters.includes(l.characterId) ? l : { ...l, characterId: NARRATOR_ID })) });
  }
  const patchLine = (i: number, p: Partial<Dialogue>) => patch({ dialogue: d.dialogue.map((l, n) => (n === i ? { ...l, ...p } : l)) });

  async function save() {
    const props = propsText.split(",").map((s) => s.trim()).filter(Boolean);
    if (props.length > maxProps) return setError(`At most ${maxProps} props per scene.`);
    const checked = SceneSchema.safeParse({ ...d, props });
    if (!checked.success) return setError(checked.error.issues.map((i) => `${friendlyPath(i.path)} ${i.message}`).join("; "));
    setSaving(true);
    setError(null);
    try { await onSave(checked.data); } catch (e) { setError((e as Error).message); setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
      <div className="my-8 w-full max-w-2xl space-y-4 rounded-xl border border-zinc-700 bg-zinc-900 p-5">
        <h2 className="text-lg font-semibold">Edit {prettyId(scene.id)}</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1"><span className="text-xs text-zinc-400">Location</span><input className={field} value={d.location} onChange={(e) => patch({ location: e.target.value })} /></label>
          <label className="space-y-1"><span className="text-xs text-zinc-400">Length (seconds; derived from the voice once generated)</span><input className={field} type="number" step="0.5" value={d.duration} onChange={(e) => patch({ duration: Number(e.target.value) })} /></label>
        </div>
        <label className="block space-y-1"><span className="text-xs text-zinc-400">What we see (becomes the background illustration)</span><textarea className={`${field} min-h-20`} value={d.visualDescription} onChange={(e) => patch({ visualDescription: e.target.value })} /></label>
        <fieldset className="space-y-1">
          <legend className="text-xs text-zinc-400">Characters in scene</legend>
          <div className="flex flex-wrap gap-3">{characters.map((c) => <label key={c.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={d.characters.includes(c.id)} onChange={() => toggleCharacter(c.id)} />{c.name}</label>)}</div>
        </fieldset>
        <label className="block space-y-1"><span className="text-xs text-zinc-400">Props (comma separated, max {maxProps})</span><input className={field} value={propsText} onChange={(e) => setPropsText(e.target.value)} placeholder="wooden mousetrap" /></label>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <label className="space-y-1"><span className="text-xs text-zinc-400">Camera</span><select className={field} value={d.camera.movement} onChange={(e) => patch({ camera: { ...d.camera, movement: e.target.value as Scene["camera"]["movement"] } })}>{CAMERA_MOVEMENTS.map((m) => <option key={m} value={m}>{prettyId(m)}</option>)}</select></label>
          <label className="space-y-1"><span className="text-xs text-zinc-400">Shot</span><select className={field} value={d.camera.shot} onChange={(e) => patch({ camera: { ...d.camera, shot: e.target.value as Scene["camera"]["shot"] } })}>{SHOTS.map((m) => <option key={m} value={m}>{prettyId(m)}</option>)}</select></label>
          <label className="space-y-1"><span className="text-xs text-zinc-400">Enter from</span><select className={field} value={d.motion.entrance} onChange={(e) => patch({ motion: { ...d.motion, entrance: e.target.value as Scene["motion"]["entrance"] } })}>{ENTRANCES.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          <label className="space-y-1"><span className="text-xs text-zinc-400">Emphasis</span><select className={field} value={d.motion.emphasis} onChange={(e) => patch({ motion: { ...d.motion, emphasis: e.target.value as Scene["motion"]["emphasis"] } })}>{EMPHASES.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs text-zinc-400">Dialogue</legend>
          {d.dialogue.map((line, i) => (
            <div key={i} className="grid grid-cols-[9rem_8rem_1fr_auto] gap-2">
              <select className={field} value={line.characterId} onChange={(e) => patchLine(i, { characterId: e.target.value })}>{speakers.map((id) => <option key={id} value={id}>{id === NARRATOR_ID ? "Narrator" : (characters.find((c) => c.id === id)?.name ?? id)}</option>)}</select>
              <select className={field} value={line.emotion ?? "neutral"} onChange={(e) => patchLine(i, { emotion: e.target.value as Dialogue["emotion"] })}>{EMOTIONS.map((em) => <option key={em} value={em}>{em}</option>)}</select>
              <input className={field} value={line.text} onChange={(e) => patchLine(i, { text: e.target.value })} />
              <button type="button" className="px-2 text-zinc-500 hover:text-red-400" title="Remove line" onClick={() => patch({ dialogue: d.dialogue.filter((_, n) => n !== i) })}>✕</button>
            </div>
          ))}
          {d.dialogue.length < 8 && <button type="button" className="text-sm text-indigo-300 hover:text-indigo-200" onClick={() => patch({ dialogue: [...d.dialogue, { id: `new-${d.dialogue.length}`, characterId: speakers[1] ?? NARRATOR_ID, emotion: "neutral", text: "" }] })}>+ Add line</button>}
        </fieldset>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className={btnGhost} onClick={onCancel} disabled={saving}>Cancel</button>
          <button className={btnPrimary} onClick={save} disabled={saving}>{saving ? "Saving..." : "Save scene"}</button>
        </div>
      </div>
    </div>
  );
}
