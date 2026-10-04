import { z } from "zod";
import { BEATS, SHOT_TYPES, STORY_EMOTIONS, slugify } from "@studio/shared";

/**
 * What the LLM is asked to return. Deliberately small: it chooses ENUMS and short TEXT only. Camera moves, durations,
 * transitions, sound effects, image prompts and image reuse are derived deterministically afterwards, so a small
 * model cannot break the visuals with a bad number.
 */
const Id = z.string().min(1).max(40);

export const DirectorOutlineSchema = z.object({
  title: z.string().min(1).max(60),
  logline: z.string().min(5).max(240).describe("one sentence: who wants what, and what goes wrong"),
  characters: z.array(z.object({
    id: Id.describe("lowercase kebab-case id derived from the name"),
    name: z.string().min(1).max(40),
    role: z.string().min(3).max(200).describe("who they are and how they behave"),
    appearance: z.string().min(3).max(200).describe("face, hair, build, age: physical features only"),
    clothing: z.string().min(3).max(160).describe("ONE distinctive costume with two strong colours, e.g. 'orange jacket with black stripes'"),
  })).min(1).max(3),
  locations: z.array(z.object({
    id: Id.describe("lowercase kebab-case id"),
    name: z.string().min(1).max(40),
    look: z.string().min(3).max(200).describe("what the place looks like: architecture, materials, mood. No people."),
    lighting: z.string().min(3).max(120).describe("light colours and sources, e.g. 'warm lanterns against cold blue haze'"),
  })).min(1).max(3),
});
export type DirectorOutline = z.infer<typeof DirectorOutlineSchema>;

export const DirectedShotSchema = z.object({
  beat: z.enum(BEATS),
  shotType: z.enum(SHOT_TYPES),
  location: Id.describe("a location id from the list"),
  character: z.string().max(40).describe("the ONE character id visible in the shot, or an empty string for an empty environment or an object"),
  emotion: z.enum(STORY_EMOTIONS),
  action: z.string().min(3).max(200).describe("what we SEE in this shot, one sentence, present tense"),
  line: z.object({ speaker: Id.describe("a character id or 'narrator'"), text: z.string().min(1).max(140) }).optional().describe("at most one short spoken line; omit for silent shots"),
  onScreenText: z.string().max(40).optional().describe("only for a phone/message/screen close-up: the text shown"),
});
export const DirectedShotsSchema = z.object({ shots: z.array(DirectedShotSchema).min(3).max(24) });
export type DirectedShot = z.infer<typeof DirectedShotSchema>;
export type DirectedShots = z.infer<typeof DirectedShotsSchema>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const key = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s_]+/g, "-") : "");

const SHOT_SYNONYMS: Record<string, string> = {
  closeup: "close-up", "close": "close-up", "tight": "close-up", "extreme-closeup": "extreme-close-up", "ecu": "extreme-close-up", "cu": "close-up", "detail": "extreme-close-up", "insert": "extreme-close-up",
  "medium-close-up": "medium-close", "mcu": "medium-close", "medium-shot": "medium", "mid": "medium", "mid-shot": "medium", "medium-long": "medium-wide", "long": "wide", "wide-shot": "wide", "long-shot": "wide",
  "establishing-shot": "establishing", "aerial": "establishing", "over-the-shoulder": "over-shoulder", "ots": "over-shoulder", "point-of-view": "pov", "first-person": "pov",
  "low": "low-angle", "high": "high-angle", "dolly": "tracking", "follow": "tracking", "chase": "action",
};
const EMOTION_SYNONYMS: Record<string, string> = {
  scared: "fear", afraid: "fear", terrified: "fear", frightened: "fear", surprised: "shock", shocked: "shock", surprise: "shock", happy: "joy", excited: "joy", relieved: "calm", suspicious: "uneasy", worried: "uneasy", nervous: "uneasy", anxious: "uneasy", mysterious: "eerie", creepy: "eerie", spooky: "eerie", angry: "anger", furious: "anger", sadness: "sad", tension: "tense", determined: "tense", wonder: "awe", amazed: "awe", curiosity: "curious", confused: "curious", thinking: "curious",
};
const BEAT_SYNONYMS: Record<string, string> = { intro: "hook", opening: "hook", introduction: "setup", exposition: "setup", rising: "escalation", "rising-action": "escalation", climax: "escalation", twist: "payoff", resolution: "payoff", ending: "payoff", reveal: "payoff", problem: "conflict", mystery: "curiosity", discovery: "curiosity" };

export function normalizeOutline(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  if (Array.isArray(raw.characters)) out.characters = raw.characters.map((c) => (isRecord(c) ? { ...c, id: slugify(String(c.id || c.name || "")) } : c));
  if (Array.isArray(raw.locations)) out.locations = raw.locations.map((l) => (isRecord(l) ? { ...l, id: slugify(String(l.id || l.name || "")) } : l));
  return out;
}

/** Map near-miss enum values / ids from a small model onto the valid ones; unknown values pass through and fail validation (-> repair). */
export function normalizeShots(raw: unknown, outline: DirectorOutline): unknown {
  if (!isRecord(raw)) return raw;
  const arr = Array.isArray(raw.shots) ? raw.shots : Array.isArray(raw.scenes) ? raw.scenes : undefined;
  if (!arr) return raw;
  const charIds = new Set(outline.characters.map((c) => c.id));
  const locIds = outline.locations.map((l) => l.id);
  const matchLoc = (v: unknown): string => {
    const k = slugify(String(v ?? ""));
    if (locIds.includes(k)) return k;
    const byName = outline.locations.find((l) => slugify(l.name) === k || k.includes(l.id) || l.id.includes(k));
    return byName?.id ?? (typeof v === "string" ? v : "");
  };
  const matchChar = (v: unknown): string => {
    const k = slugify(String(v ?? ""));
    if (!k || ["none", "nobody", "null", "n-a", "empty"].includes(k)) return "";
    if (k === "narrator") return "narrator";
    if (charIds.has(k)) return k;
    return outline.characters.find((c) => slugify(c.name) === k || k.includes(c.id))?.id ?? k;
  };
  return {
    shots: arr.map((s) => {
      if (!isRecord(s)) return s;
      const st = key(s.shotType ?? s.shot_type ?? s.shot), em = key(s.emotion), be = key(s.beat);
      const line = isRecord(s.line) ? { speaker: matchChar(s.line.speaker ?? s.line.character), text: typeof s.line.text === "string" ? s.line.text.trim() : s.line.text } : undefined;
      const text = typeof s.onScreenText === "string" ? s.onScreenText.trim() : "";
      return {
        beat: BEAT_SYNONYMS[be] ?? be, shotType: SHOT_SYNONYMS[st] ?? st, location: matchLoc(s.location), character: matchChar(s.character), emotion: EMOTION_SYNONYMS[em] ?? em,
        action: typeof s.action === "string" ? s.action.trim() : s.action,
        ...(line && line.text ? { line } : {}), ...(text ? { onScreenText: text.slice(0, 40) } : {}),
      };
    }),
  };
}
