import { keyVisualAssetId, shotVideoAssetId, NARRATOR_ID, type Project, type Shot } from "@studio/shared";
import { mediaUrl, type RegenPart } from "../lib/api";
import { btnGhost, prettyId } from "./ui";

const nameOf = (p: Project, id: string) => (id === NARRATOR_ID ? "Narrator" : (p.characters.find((c) => c.id === id)?.name ?? id));

function ShotRow({ project, shot }: { project: Project; shot: Shot }) {
  const key = project.assets.find((a) => a.id === keyVisualAssetId(shot.visualKey) && a.status === "ready");
  const clip = project.assets.find((a) => a.id === shotVideoAssetId(shot.id) && a.status === "ready");
  return (
    <li className="flex gap-3 rounded-lg border border-zinc-800 p-2">
      <div className="h-24 w-14 shrink-0 overflow-hidden rounded bg-zinc-800">
        {key && <img alt={shot.visualKey} className="h-full w-full object-cover" src={mediaUrl(project.id, key.path, `${key.meta.attempt}`)} />}
      </div>
      <div className="min-w-0 flex-1 space-y-1 text-sm">
        <p className="text-xs text-zinc-500">
          <strong className="text-zinc-300">{shot.id.replace("shot-", "#")}</strong> · {prettyId(shot.beat)} · {prettyId(shot.shotType)} · {prettyId(shot.motion.type)}{shot.motion.shake ? " + shake" : ""} · {prettyId(shot.emotion)} · {shot.duration.toFixed(1)}s
          {shot.transition.type !== "cut" && ` · ${shot.transition.type} out`}{shot.effects?.impact ? " · impact" : ""}{shot.effects?.flash ? " · flash" : ""}
        </p>
        <p className="text-zinc-300">{shot.action}</p>
        {shot.dialogue.map((d) => <p key={d.id} className="text-zinc-200"><span className="font-medium text-indigo-300">{nameOf(project, d.characterId)}</span> “{d.text}”</p>)}
        {shot.insert && <p className="text-xs text-amber-300">On screen ({shot.insert.kind}): {shot.insert.text}</p>}
        {shot.sfx.length > 0 && <p className="text-xs text-zinc-500">SFX: {shot.sfx.map((s) => s.kind).join(", ")}</p>}
      </div>
      {clip && <video preload="none" muted controls className="h-24 shrink-0 rounded border border-zinc-800" src={mediaUrl(project.id, clip.path, clip.createdAt)} />}
    </li>
  );
}

/** The director's shot list, grouped by scene, with per-scene regeneration (images share across shots, so a scene's images may affect others). */
export function ShotList({ project, busy, onRegenerate }: { project: Project; busy: boolean; onRegenerate: (sceneId: string, parts: RegenPart[]) => void }) {
  const story = project.story!;
  const keys = story.keyVisuals.length;
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">{story.logline} <span className="text-zinc-500">· {story.shots.length} shots from {keys} generated images (shared and varied between shots).</span></p>
      {story.scenes.map((sc, i) => {
        const shots = story.shots.filter((s) => s.sceneId === sc.id);
        const loc = story.locations.find((l) => l.id === sc.locationId);
        return (
          <article key={sc.id} className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <header className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Scene {i + 1} <span className="text-xs font-normal text-zinc-500">· {loc?.name ?? sc.locationId} · {shots.reduce((s, x) => s + x.duration, 0).toFixed(1)}s</span></h3>
              {project.reviewApproved && (
                <div className="flex flex-wrap gap-2">
                  <button className={btnGhost} disabled={busy} onClick={() => onRegenerate(project.scenes[i]!.id, ["assets"])}>New images</button>
                  <button className={btnGhost} disabled={busy} onClick={() => onRegenerate(project.scenes[i]!.id, ["voice"])}>Voice</button>
                  <button className={btnGhost} disabled={busy} onClick={() => onRegenerate(project.scenes[i]!.id, ["render"])}>Re-render</button>
                </div>
              )}
            </header>
            <ul className="space-y-2">{shots.map((s) => <ShotRow key={s.id} project={project} shot={s} />)}</ul>
          </article>
        );
      })}
    </div>
  );
}
