import { NARRATOR_ID, sceneVideoAssetId, type Project, type Scene } from "@studio/shared";
import { mediaUrl, type RegenPart } from "../lib/api";
import { btnGhost, prettyId } from "./ui";

interface Props {
  project: Project;
  scene: Scene;
  busy: boolean;
  onEdit: () => void;
  onRegenerate: (parts: RegenPart[], includeBackground?: boolean) => void;
}

const nameOf = (p: Project, id: string) => (id === NARRATOR_ID ? "Narrator" : (p.characters.find((c) => c.id === id)?.name ?? id));

export function SceneCard({ project, scene, busy, onEdit, onRegenerate }: Props) {
  const clip = project.assets.find((a) => a.id === sceneVideoAssetId(scene.id) && a.status === "ready");
  const generated = project.reviewApproved;
  return (
    <article className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{prettyId(scene.id)} <span className="text-xs font-normal text-zinc-500">· {scene.status.replace("_", " ")}</span></h3>
          <p className="text-xs text-zinc-500">{scene.duration}s · {scene.location} · camera {prettyId(scene.camera.movement)}/{scene.camera.shot} · enter {scene.motion.entrance}, emphasis {scene.motion.emphasis}</p>
        </div>
        <button onClick={onEdit} disabled={busy} className={btnGhost}>Edit</button>
      </header>
      <p className="mt-3 text-sm text-zinc-300">{scene.visualDescription}</p>
      <p className="mt-2 text-xs text-zinc-500">Characters: {scene.characters.map((c) => nameOf(project, c)).join(", ") || "-"} · Props: {scene.props.join(", ") || "-"}</p>
      {scene.dialogue.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-zinc-800 pt-3">
          {scene.dialogue.map((d) => {
            const audio = project.audio.find((a) => a.dialogueId === d.id);
            return (
              <li key={d.id} className="flex items-center gap-2 text-sm">
                <span className="font-medium text-indigo-300">{nameOf(project, d.characterId)}</span>
                <span className="flex-1 text-zinc-200">“{d.text}”</span>
                {d.startTime !== undefined && <span className="text-xs text-zinc-600">{d.startTime.toFixed(1)}–{d.endTime?.toFixed(1)}s</span>}
                {audio && <audio controls preload="none" className="h-7 w-40" src={mediaUrl(project.id, audio.path, audio.createdAt)} />}
              </li>
            );
          })}
        </ul>
      )}
      {clip && <video controls preload="metadata" className="mt-3 max-h-80 rounded-lg border border-zinc-800" src={mediaUrl(project.id, clip.path, clip.createdAt)} />}
      {generated && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-zinc-800 pt-3">
          <span className="self-center text-xs text-zinc-500">Regenerate only this scene:</span>
          <button className={btnGhost} disabled={busy} onClick={() => onRegenerate(["assets"])}>Images</button>
          <button className={btnGhost} disabled={busy} onClick={() => onRegenerate(["assets"], true)} title="Give this scene its own background">New background</button>
          <button className={btnGhost} disabled={busy} onClick={() => onRegenerate(["voice"])}>Voice</button>
          <button className={btnGhost} disabled={busy} onClick={() => onRegenerate(["render"])}>Animation</button>
        </div>
      )}
    </article>
  );
}
