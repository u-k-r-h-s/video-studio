import { PlanEditSchema, dialogueId, validatePlanIntegrity, type Project, type Scene } from "@studio/shared";
import { HttpError } from "../errors";
import type { FormatProfile } from "@studio/shared";

const editable = (s: Scene) => JSON.stringify([s.duration, s.location, s.visualDescription, s.dialogue.map((d) => [d.characterId, d.text, d.emotion]), s.characters, s.props, s.camera, s.motion]);

/**
 * Applies a human edit of the plan. Validates the schema, cross references and the profile's limits; renumbers
 * dialogue ids by position (so new lines get ids) and resets derived fields of scenes whose content changed.
 * Generated assets are NOT deleted: they are re-used or regenerated later by comparing input hashes.
 */
export function applyPlanEdit(project: Project, rawEdit: unknown, profile: FormatProfile): Pick<Project, "title" | "characters" | "scenes"> {
  const parsed = PlanEditSchema.safeParse(rawEdit);
  if (!parsed.success) {
    throw new HttpError(400, "plan_invalid", parsed.error.issues.map((i) => `${i.path.join(".") || "plan"}: ${i.message}`).join("; "), parsed.error.issues);
  }
  const edit = parsed.data;
  const ids = new Set<string>();
  const old = new Map(project.scenes.map((s) => [s.id, s]));
  const scenes: Scene[] = edit.scenes.map((s, i) => {
    if (ids.has(s.id)) throw new HttpError(400, "plan_invalid", `Duplicate scene id ${s.id}`);
    ids.add(s.id);
    const dialogue = s.dialogue.map((d, n) => ({ id: dialogueId(s.id, n + 1), characterId: d.characterId, text: d.text, ...(d.emotion ? { emotion: d.emotion } : {}) }));
    const next: Scene = { ...s, order: i + 1, dialogue, generatedAssets: old.get(s.id)?.generatedAssets ?? [] };
    const before = old.get(s.id);
    if (!before || editable(before) !== editable(next)) next.status = "planned";
    else next.status = before.status;
    return next;
  });
  const issues = validatePlanIntegrity({ characters: edit.characters, scenes });
  if (edit.characters.length > profile.planning.maxCharacters) issues.push(`At most ${profile.planning.maxCharacters} characters are allowed.`);
  for (const s of scenes) {
    if (s.props.length > profile.planning.maxPropsPerScene) issues.push(`${s.id}: at most ${profile.planning.maxPropsPerScene} props per scene.`);
    if (s.duration < profile.timing.minSceneSeconds || s.duration > profile.timing.maxSceneSeconds) issues.push(`${s.id}: duration must be ${profile.timing.minSceneSeconds}-${profile.timing.maxSceneSeconds} s.`);
  }
  if (issues.length) throw new HttpError(400, "plan_invalid", issues.join(" "), issues);
  return { title: edit.title, characters: edit.characters, scenes };
}
