import type { Shot, ShotAnimAction, ShotObjectAction } from "@studio/shared";
import type { ViewName } from "./types";

/**
 * The director speaks in intent ("walk toward the door", "turn toward the sound", "look at the phone"). This module turns intent
 * into the few facts the rest of the pipeline needs, deterministically: which way an action goes, which camera view of the
 * character it needs, which face variants a shot needs, and what kind of prop a noun is.
 */
export type Direction = "left" | "right" | "camera" | "away" | "object";

export const SCREEN_X = { left: 190, center: 540, right: 890 } as const;

export function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export type PropKind = "phone" | "door" | "car" | "package" | "picture" | "generic";
export function classifyProp(name: string): PropKind {
  const n = normName(name);
  if (/(phone|mobile|smartphone|cell|screen|message|notification)/.test(n)) return "phone";
  if (/(door|gate|entrance|doorway|hatch)/.test(n)) return "door";
  if (/(drawing|painting|picture|photo|photograph|poster|portrait|sketch|note|map|sign)/.test(n)) return "picture";
  if (/(car|vehicle|taxi|cab|van|truck|jeep|sedan|bus)/.test(n)) return "car";
  if (/(package|parcel|box|crate|bag|delivery|envelope|letter|suitcase|briefcase)/.test(n)) return "package";
  return "generic";
}

/** Which way an action is directed. Priority: explicit `to`, then the director's words in `toward`, then the object it names. */
export function resolveDirection(a: Pick<ShotAnimAction, "to" | "toward" | "action">, objects: Pick<ShotObjectAction, "object">[]): { dir: Direction; object?: string } {
  if (a.to === "left" || a.to === "right" || a.to === "camera") return { dir: a.to };
  if (typeof a.to === "number") return { dir: a.to < 540 ? "left" : "right" };
  const t = (a.toward ?? "").toLowerCase();
  if (t) {
    const named = objects.find((o) => normName(o.object).split("-").some((tok) => tok.length > 2 && t.includes(tok)));
    if (named) return { dir: "object", object: named.object };
    if (/\bleft\b/.test(t)) return { dir: "left" };
    if (/\bright\b/.test(t)) return { dir: "right" };
    if (/(camera|viewer|audience|us\b|screen|toward me|towards me)/.test(t)) return { dir: "camera" };
    if (/(away|distance|horizon|into the|inside|hallway|corridor|dark|far|depth|beyond)/.test(t)) return { dir: "away" };
    const door = objects.find((o) => classifyProp(o.object) === "door");
    if (/(door|building|entrance|house|gate|stairs|apartment|shop|store)/.test(t)) return door ? { dir: "object", object: door.object } : { dir: "right" };
    if (/(sound|noise|voice|light|figure|shadow)/.test(t)) return { dir: "right" };
  }
  return { dir: "right" };
}

export const MOVING = new Set(["walk", "run", "enter", "exit", "step-forward", "step-back"]);

/** The camera view of the character an action needs while it happens. */
export function viewFor(action: string, dir: Direction): ViewName | null {
  if (action === "turn" || action === "head-turn") return null;
  if (action === "walk" || action === "run" || action === "enter" || action === "exit") {
    if (dir === "camera") return "front";
    if (dir === "away") return "back";
    return "side";
  }
  return null;
}

/** The head variant that an action or an emotion needs (null = the neutral head and plain transforms suffice). */
export function variantFor(action: string): "lookL" | "lookR" | "front" | "surprised" | "worried" | "angry" | "smile" | null {
  switch (action) {
    case "look-left": return "lookL";
    case "look-right": return "lookR";
    case "head-turn": return "front";
    case "surprise": case "react": return "surprised";
    case "fear": return "worried";
    case "anger": return "angry";
    case "smile": return "smile";
    default: return null;
  }
}

const FACE_SHOTS = new Set(["extreme-close-up", "close-up", "medium-close", "medium", "over-shoulder"]);
const EMOTION_ACTION: Partial<Record<Shot["emotion"], ShotAnimAction["action"]>> = { shock: "surprise", fear: "fear", anger: "anger", joy: "smile", eerie: "smile" };

/**
 * Every shot with a character must contain at least one visible event. The director's actions come first; an emotion the
 * pictures cannot otherwise show is added as a facial action; a shot with nothing at all gets a default that suits its framing.
 */
export function impliedActions(shot: Pick<Shot, "subjectIds" | "shotType" | "emotion" | "animation" | "beat" | "dialogue">): ShotAnimAction[] {
  const who = shot.subjectIds[0];
  if (!who) return [];
  const out: ShotAnimAction[] = (shot.animation?.actions ?? []).map((a) => ({ ...a, character: who }));
  const face = out.some((a) => variantFor(a.action) && a.action !== "head-turn" && a.action !== "look-left" && a.action !== "look-right");
  const emo = EMOTION_ACTION[shot.emotion];
  if (emo && !face && FACE_SHOTS.has(shot.shotType)) out.push({ character: who, action: emo, when: emo === "smile" ? "late" : "early" });
  if (!out.length || !out.some((a) => a.action !== "idle")) {
    const wide = !FACE_SHOTS.has(shot.shotType);
    out.push(wide ? { character: who, action: "walk", when: "start", to: "right" } : { character: who, action: shot.dialogue.length ? "nod" : "look-right", when: "early" });
  }
  return out;
}

/** Views and face variants a character needs, from all its shots. Fewer assets = less ComfyUI time on an 8 GB machine. */
export function neededForCharacter(shots: Shot[], characterId: string): { views: Set<ViewName>; variants: Set<string> } {
  const views = new Set<ViewName>(["front"]);
  const variants = new Set<string>();
  for (const s of shots) {
    if (s.subjectIds[0] !== characterId) continue;
    const objects = s.animation?.objects ?? [];
    for (const a of impliedActions(s)) {
      const v = viewFor(a.action, resolveDirection(a, objects).dir);
      if (v) views.add(v);
      if (a.action === "turn") views.add("three-quarter");
      const hv = variantFor(a.action);
      if (hv && FACE_SHOTS.has(s.shotType)) variants.add(hv);
    }
  }
  return { views, variants };
}
