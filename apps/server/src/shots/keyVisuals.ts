import type { Character, KeyVisual, Location, Shot, StoryEmotion } from "@studio/shared";
import { slugify } from "@studio/shared";

/** Bump when prompt construction changes so cached key images are regenerated. */
export const KEY_RECIPE_VERSION = "cinematic-key-v1";

const PORTRAIT_TYPES = new Set<Shot["shotType"]>(["extreme-close-up", "close-up", "medium-close", "over-shoulder"]);

const FRAMING: Record<Shot["shotType"], string> = {
  "extreme-close-up": "extreme close-up of the face of", "close-up": "close-up portrait of", "medium-close": "medium close-up of", medium: "medium shot of",
  "medium-wide": "medium wide shot of", wide: "wide shot, a small figure of", establishing: "wide establishing shot, a small figure of", "over-shoulder": "over the shoulder shot of",
  pov: "first person view of", "low-angle": "low angle shot of", "high-angle": "high angle shot of", tracking: "tracking shot following", action: "dynamic action shot of",
};
const ENV_FRAMING: Partial<Record<Shot["shotType"], string>> = {
  "low-angle": "low angle shot looking up at", "high-angle": "high angle shot looking down at", wide: "wide shot of", establishing: "wide establishing shot of", "extreme-close-up": "extreme close-up detail in",
  "close-up": "close-up detail in", "medium-wide": "medium wide shot of", medium: "medium shot of", pov: "first person view of", tracking: "tracking shot through",
};
const EMOTION_LOOK: Record<StoryEmotion, string> = {
  neutral: "neutral calm expression", calm: "calm relaxed expression", curious: "curious attentive look", uneasy: "uneasy worried expression, looking up", tense: "tense focused expression",
  fear: "terrified wide eyes, mouth slightly open", shock: "shocked wide-open eyes, mouth slightly open", anger: "angry furious expression", sad: "sad downcast eyes", joy: "warm genuine smile",
  awe: "awestruck wide eyes", eerie: "eerie calm smile, cold unblinking eyes",
};
/** Emotions that look alike share one generated image; others become img2img variants of the first portrait. */
const GROUP: Record<StoryEmotion, string> = { neutral: "base", calm: "base", curious: "base", sad: "base", joy: "base", awe: "base", uneasy: "uneasy", tense: "uneasy", fear: "intense", shock: "intense", anger: "intense", eerie: "eerie" };

export const characterIdentity = (c: Pick<Character, "appearance" | "clothing" | "visualIdentity">): string => c.visualIdentity ?? [c.appearance, c.clothing].filter(Boolean).join(", ");

export interface PromptCtx { style: string; characters: Character[]; locations: Location[] }

/**
 * The positive prompt for a shot's key image. Built from the character and location BIBLES (never from free text the
 * model wrote for a different shot) so the same costume and the same place appear in every image. Negative wording is
 * avoided on purpose: at LCM's low guidance negatives are ignored, so unwanted things must simply not be mentioned.
 */
export function keyPrompt(shot: Pick<Shot, "shotType" | "emotion" | "subjectIds" | "locationId" | "insert" | "action">, ctx: PromptCtx, kind: KeyVisual["kind"]): string {
  const loc = ctx.locations.find((l) => l.id === shot.locationId) ?? ctx.locations[0]!;
  const who = ctx.characters.find((c) => c.id === shot.subjectIds[0]);
  if (kind === "insert") return `${ctx.style}, close-up of hands holding a smartphone with a bright glowing screen, cold blue light on the fingers, dark background`;
  if (who) {
    const bg = kind === "portrait" ? `blurred background of ${loc.visualIdentity}` : loc.visualIdentity;
    return `${ctx.style}, ${FRAMING[shot.shotType]} ${characterIdentity(who)}, ${EMOTION_LOOK[shot.emotion]}, ${bg}, ${loc.lighting}`;
  }
  return `${ctx.style}, ${ENV_FRAMING[shot.shotType] ?? "wide shot of"} ${loc.visualIdentity}, ${loc.lighting}${loc.importantObjects.length ? `, ${loc.importantObjects[0]}` : ""}`;
}

interface Draft { id: string; kind: KeyVisual["kind"]; locationId: string; subjectIds: string[]; shots: Shot[]; group?: string; env?: string }

function classify(shot: Shot): { kind: KeyVisual["kind"]; ident: string } {
  const subject = shot.subjectIds[0];
  if (!subject && shot.insert?.kind === "phone") return { kind: "insert", ident: "insert-phone" };
  if (subject) return PORTRAIT_TYPES.has(shot.shotType) ? { kind: "portrait", ident: `${subject}|${shot.locationId}|${GROUP[shot.emotion]}` } : { kind: "action", ident: `${subject}|${shot.locationId}|${shot.shotType}|${GROUP[shot.emotion]}` };
  const wide = shot.shotType === "wide" || shot.shotType === "establishing";
  return { kind: "environment", ident: `env|${shot.locationId}|${wide ? "wide" : shot.shotType === "low-angle" || shot.shotType === "high-angle" ? shot.shotType : "detail"}` };
}

/**
 * Decides which images to generate. Shots that would show the same thing share an image (so a 10-shot video needs
 * about 6-8 generations, not 10), emotional variants of a portrait are img2img variants of the first portrait of that
 * character (identity carries over), and a budget caps the total by merging the least-used images into their closest
 * relative. Pure and deterministic.
 */
export function planKeyVisuals(shots: Shot[], ctx: PromptCtx, maxKeys: number): { keyVisuals: KeyVisual[]; shotKey: Record<string, string> } {
  const drafts = new Map<string, Draft>();
  const order: string[] = [];
  for (const shot of shots) {
    const { kind, ident } = classify(shot);
    let d = drafts.get(ident);
    if (!d) {
      d = { id: "", kind, locationId: shot.locationId, subjectIds: shot.subjectIds.slice(0, 1), shots: [], group: ident.split("|").pop() };
      drafts.set(ident, d);
      order.push(ident);
    }
    d.shots.push(shot);
  }
  // budget: merge the least-used draft into its closest relative until the cap holds
  const closest = (d: Draft, pool: Draft[]): Draft | undefined => {
    const score = (o: Draft): number => (o.subjectIds[0] === d.subjectIds[0] ? 4 : 0) + (o.kind === d.kind ? 2 : 0) + (o.locationId === d.locationId ? 1 : 0);
    return pool.filter((o) => o !== d).sort((a, b) => score(b) - score(a) || b.shots.length - a.shots.length)[0];
  };
  while (order.length > Math.max(1, maxKeys)) {
    const live = order.map((k) => drafts.get(k)!);
    const victim = [...live].sort((a, b) => a.shots.length - b.shots.length || live.indexOf(b) - live.indexOf(a))[0]!;
    const target = closest(victim, live);
    if (!target) break;
    target.shots.push(...victim.shots);
    const k = order.find((x) => drafts.get(x) === victim)!;
    order.splice(order.indexOf(k), 1);
    drafts.delete(k);
  }
  // ids + img2img wiring: first portrait of a character is the identity anchor for its other portrait/action images
  const used = new Set<string>();
  const finalDrafts = order.map((k) => drafts.get(k)!);
  const anchorOf = new Map<string, Draft>();
  for (const d of finalDrafts) {
    const base = d.kind === "insert" ? "insert-phone" : d.kind === "environment" ? `env-${d.locationId}` : `${d.kind === "portrait" ? "portrait" : "figure"}-${d.subjectIds[0]}-${slugify(d.group ?? "x")}`;
    let id = base, n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    d.id = id;
    const s = d.subjectIds[0];
    if (s && d.kind === "portrait" && !anchorOf.has(s)) anchorOf.set(s, d);
  }
  const keyVisuals: KeyVisual[] = [];
  const shotKey: Record<string, string> = {};
  // anchors first so the init image exists when a variant is generated
  const sorted = [...finalDrafts].sort((a, b) => Number(isVariant(a, anchorOf)) - Number(isVariant(b, anchorOf)));
  for (const d of sorted) {
    const rep = d.shots[0]!;
    const anchor = d.subjectIds[0] ? anchorOf.get(d.subjectIds[0]) : undefined;
    const initFrom = anchor && anchor !== d && d.kind !== "insert" && d.kind !== "environment" ? { keyId: anchor.id, denoise: d.group === "eerie" || d.group === "intense" ? 0.58 : 0.5 } : undefined;
    keyVisuals.push({
      id: d.id, kind: d.kind, locationId: d.locationId, subjectIds: d.subjectIds, prompt: keyPrompt(rep, ctx, d.kind), shotIds: d.shots.map((s) => s.id), ...(initFrom ? { initFrom } : {}),
    });
    for (const s of d.shots) shotKey[s.id] = d.id;
  }
  return { keyVisuals, shotKey };
}
const isVariant = (d: Draft, anchors: Map<string, Draft>): boolean => !!d.subjectIds[0] && d.kind !== "environment" && d.kind !== "insert" && anchors.get(d.subjectIds[0]) !== d;
