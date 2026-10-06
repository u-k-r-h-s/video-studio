import { z } from "zod";
import { ANIM_ACTIONS, ANIM_WHEN, BEATS, OBJECT_ACTIONS, SHOT_TYPES, STORY_EMOTIONS, TIMES_OF_DAY, WEATHERS, slugify } from "@studio/shared";

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
    timeOfDay: z.enum(TIMES_OF_DAY).optional().describe("morning, day, golden_hour, sunset or night: whatever the story needs"),
    weather: z.enum(WEATHERS).optional().describe("sunny, clear, cloudy, overcast, rain or fog"),
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
  move: z.string().max(60).optional().describe("how the visible character travels in this shot, a few words: 'walk to the door', 'run away', 'enter from the left', or 'none'"),
  gesture: z.string().max(60).optional().describe("what the character's hands do: 'raise the flashlight', 'push the door open', 'check the phone', 'point at the window', or 'none'"),
  reaction: z.string().max(60).optional().describe("how the character reacts at the end of the shot: 'stop and listen', 'turn head toward the sound', 'step back in fear', or 'none'"),
  actions: z.array(z.object({ action: z.enum(ANIM_ACTIONS), when: z.enum(ANIM_WHEN), toward: z.string().max(40).optional() })).max(3).optional().describe("what the visible character physically does in this shot, in order"),
  objects: z.array(z.object({ object: z.string().min(1).max(30), action: z.enum(OBJECT_ACTIONS), when: z.enum(ANIM_WHEN) })).max(2).optional().describe("what a visible object does (a door opens, a phone lights up)"),
});
export const DirectedBeatsSchema = z.object({
  beats: z.array(z.object({ beat: z.enum(BEATS), what: z.string().min(5).max(220).describe("one or two sentences: what happens in this part of the story") })).length(6),
});
export type DirectedBeats = z.infer<typeof DirectedBeatsSchema>;

/** The shots of ONE beat (1-3). The director asks for them beat by beat so a small model keeps the story coherent. */
export const BeatShotsSchema = z.object({ shots: z.array(DirectedShotSchema).min(1).max(3) });
export const DirectedShotsSchema = z.object({ shots: z.array(DirectedShotSchema).min(3).max(24) });
export type DirectedShot = z.infer<typeof DirectedShotSchema>;
export type DirectedShots = z.infer<typeof DirectedShotsSchema>;

const NAME_STOPWORDS = new Set(["the", "and", "old", "young", "man", "woman", "boy", "girl", "mr", "mrs", "dr", "his", "her"]);
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

const ACTION_SYN: Record<string, string> = { walking: "walk", walks: "walk", running: "run", runs: "run", turns: "turn", "turn-around": "turn", "look-at-camera": "head-turn", "turns-head": "head-turn", "looks-left": "look-left", "looks-right": "look-right", "look-down": "look-down", nods: "nod", gasp: "surprise", startled: "surprise", scared: "fear", frightened: "fear", angry: "anger", smiles: "smile", "steps-forward": "step-forward", "steps-back": "step-back", gesture: "hand-gesture", points: "point", react: "react", stops: "idle", stop: "idle", stand: "idle", standing: "idle" };
const WHEN_SYN: Record<string, string> = { begin: "start", beginning: "start", first: "early", middle: "mid", center: "mid", after: "late", finally: "end", last: "end" };
function normAction(a: unknown): unknown {
  if (!isRecord(a)) return a;
  const k = key(a.action);
  const toward = typeof a.toward === "string" ? a.toward.trim().slice(0, 40) : "";
  return { action: ACTION_SYN[k] ?? k, when: WHEN_SYN[key(a.when)] ?? (key(a.when) || "mid"), ...(toward ? { toward } : {}) };
}

export function normalizeOutline(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  if (Array.isArray(raw.characters)) out.characters = raw.characters.map((c) => (isRecord(c) ? { ...c, id: slugify(String(c.id || c.name || "")) } : c));
  const TOD: Record<string, string> = { afternoon: "day", noon: "day", daytime: "day", midday: "day", dawn: "morning", sunrise: "morning", dusk: "sunset", evening: "sunset", "golden-hour": "golden_hour", golden: "golden_hour", midnight: "night", "late-night": "night" };
  const WX: Record<string, string> = { sun: "sunny", bright: "sunny", rainy: "rain", raining: "rain", storm: "rain", stormy: "rain", drizzle: "rain", foggy: "fog", mist: "fog", misty: "fog", grey: "overcast", gray: "overcast", clouds: "cloudy" };
  const pick = (v: unknown, allowed: readonly string[], syn: Record<string, string>): string | undefined => { const k = key(v).replace(/_/g, "-"); const x = syn[k] ?? k.replace(/-/g, "_"); return allowed.includes(x) ? x : undefined; };
  if (Array.isArray(raw.locations)) out.locations = raw.locations.map((l) => {
    if (!isRecord(l)) return l;
    const { timeOfDay, weather, ...rest } = l as Record<string, unknown>;
    const tod = pick(timeOfDay, TIMES_OF_DAY, TOD), wx = pick(weather, WEATHERS, WX);
    return { ...rest, id: slugify(String(l.id || l.name || "")), ...(tod ? { timeOfDay: tod } : {}), ...(wx ? { weather: wx } : {}) };
  });
  return out;
}

/** Map near-miss enum values / ids from a small model onto the valid ones; unknown values pass through and fail validation (-> repair). */
export function normalizeShots(raw: unknown, outline: DirectorOutline): unknown {
  if (!isRecord(raw)) return raw;
  const arr = Array.isArray(raw.shots) ? raw.shots : Array.isArray(raw.scenes) ? raw.scenes : undefined;
  if (!arr) return raw;
  const charIds = new Set(outline.characters.map((c) => c.id));
  const locIds = outline.locations.map((l) => l.id);
  let lastLoc = locIds[0] ?? "";
  const matchLoc = (v: unknown): string => {
    const k = slugify(String(v ?? ""));
    if (locIds.includes(k)) return k;
    const byName = outline.locations.find((l) => slugify(l.name) === k || (k.length > 2 && (k.includes(l.id) || l.id.includes(k))));
    // an invented place is not worth failing the project for: stay where the previous shot was
    return byName?.id ?? lastLoc;
  };
  const matchChar = (v: unknown): string => {
    const k = slugify(String(v ?? ""));
    if (!k || ["none", "nobody", "null", "n-a", "empty"].includes(k)) return "";
    if (k === "narrator") return "narrator";
    if (charIds.has(k)) return k;
    return outline.characters.find((c) => slugify(c.name) === k || k.includes(c.id))?.id ?? "";
  };
  /** Who is on screen when the model left "character" empty: the person the action names, else the speaker (people usually speak on screen). */
  const inferSubject = (action: string, speaker: string, hasText: boolean): string => {
    const named = outline.characters.find((c) => [c.name, c.id].some((n) => n.split(/[\s-]+/).filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t.toLowerCase())).some((t) => new RegExp(`(^|[^\\p{L}])${t}($|[^\\p{L}])`, "iu").test(action))));
    if (named) return named.id;
    return !hasText && charIds.has(speaker) ? speaker : "";
  };
  return {
    shots: arr.map((s) => {
      if (!isRecord(s)) return s;
      const st = key(s.shotType ?? s.shot_type ?? s.shot), em = key(s.emotion), be = key(s.beat);
      const text = typeof s.onScreenText === "string" ? s.onScreenText.trim() : "";
      const action = typeof s.action === "string" ? s.action.trim() : "";
      const rawSpeaker = isRecord(s.line) ? matchChar(s.line.speaker ?? s.line.character) : "";
      let character = matchChar(s.character);
      if (!character) character = inferSubject(action, rawSpeaker, !!text);
      // an unknown speaker is the person on screen, else the narrator
      const line = isRecord(s.line) ? { speaker: rawSpeaker || (character && character !== "narrator" ? character : "narrator"), text: typeof s.line.text === "string" ? s.line.text.trim() : s.line.text } : undefined;
      const location = matchLoc(s.location);
      lastLoc = location;
      return {
        beat: BEAT_SYNONYMS[be] ?? be, shotType: SHOT_SYNONYMS[st] ?? st, location, character, emotion: EMOTION_SYNONYMS[em] ?? em,
        action: typeof s.action === "string" ? s.action.trim() : s.action,
        ...Object.fromEntries((["move", "gesture", "reaction"] as const).filter((k) => typeof s[k] === "string" && (s[k] as string).trim()).map((k) => [k, (s[k] as string).trim().slice(0, 60)])),
        // junk lines ("-", "...") are dropped: a caption must be words
        ...(Array.isArray(s.actions) ? { actions: s.actions.map(normAction).filter(Boolean) } : {}),
        ...(Array.isArray(s.objects) ? { objects: s.objects.filter(isRecord).map((o) => ({ object: slugify(String(o.object ?? "")), action: key(o.action), when: WHEN_SYN[key(o.when)] ?? (key(o.when) || "mid") })) } : {}),
        ...(line && typeof line.text === "string" && (line.text.match(/\p{L}/gu)?.length ?? 0) >= 2 ? { line } : {}), ...(text ? { onScreenText: text.slice(0, 40) } : {}),
      };
    }),
  };
}

export function normalizeBeats(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const arr = Array.isArray(raw.beats) ? raw.beats : Array.isArray(raw.story) ? raw.story : undefined;
  if (!arr) return raw;
  const order = BEATS as readonly string[];
  return {
    beats: arr.slice(0, 6).map((b, i) => {
      if (typeof b === "string") return { beat: order[i], what: b.trim() };
      if (!isRecord(b)) return b;
      const k = key(b.beat ?? b.name ?? b.kind);
      const what = typeof b.what === "string" ? b.what : typeof b.summary === "string" ? b.summary : typeof b.description === "string" ? b.description : b.action;
      return { beat: order.includes(BEAT_SYNONYMS[k] ?? k) ? (BEAT_SYNONYMS[k] ?? k) : order[i], what: typeof what === "string" ? what.trim() : what };
    }),
  };
}
