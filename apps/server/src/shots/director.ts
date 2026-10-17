import { z } from "zod";
import { ANIM_ACTIONS, ANIM_WHEN, StorySchema, type ShotAnimAction } from "@studio/shared";
import { BEATS, SHOT_TYPES, STORY_EMOTIONS, type Beat, type Character, type FormatProfile, type ShotType, type Story } from "@studio/shared";
import { generateStructured } from "../llm/structured";
import type { LLMProvider } from "../llm/types";
import {
  BeatShotsSchema, DirectedBeatsSchema, DirectedShotSchema, DirectorOutlineSchema, normalizeBeats, normalizeOutline, normalizeShots,
  type DirectedShot, type DirectedShots, type DirectorOutline,
} from "./directorSchemas";
import { buildStory } from "./storyBuilder";

export interface DirectInput { idea: string; targetDurationSeconds: number; feedback?: string }
export interface DirectHooks { signal?: AbortSignal; onStep?: (s: "outline" | "beats" | "shots", detail?: string) => void; onRepair?: (attempt: number, issues: string[]) => void }
export interface DirectResult { title: string; characters: Character[]; story: Story }

const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

export const expectedShotCount = (profile: FormatProfile, target: number): number => {
  const c = profile.cinematic!;
  return Math.max(c.minShots, Math.min(c.maxShots, Math.round(target / 2.3)));
};

/** How many shots each beat gets: 1 for the hook, 2 for the payoff (twist + final image), the rest spread over the middle. */
export function shotsPerBeat(total: number): Record<Beat, number> {
  const out: Record<Beat, number> = { hook: 1, setup: 1, curiosity: 1, conflict: 1, escalation: 1, payoff: 2 };
  const middle: Beat[] = ["setup", "curiosity", "conflict", "escalation"];
  let left = Math.max(0, total - 7);
  for (let i = 0; left > 0; i++, left--) out[middle[i % 4]!] = Math.min(3, out[middle[i % 4]!] + 1);
  return out;
}

export const directorSystemPrompt = (profile: FormatProfile): string => `You are the director of a premium animated vertical short (YouTube Shorts style, 9:16).
You think in SHOTS, not paragraphs: every shot is one camera set-up with one clear thing to see.
Rules:
- Everything must be ORIGINAL. Never use or imitate characters, names, artwork, plots or stories from existing films, games, comics or franchises.
- Keep it family friendly. ${profile.planning.styleGuidance}
- Respond with a single JSON object that follows the provided schema. No markdown, no commentary.`;

export function outlinePrompt(i: DirectInput, profile: FormatProfile): string {
  const c = profile.cinematic!;
  return `Create the story bible for a ${i.targetDurationSeconds}-second animated short.

Idea: ${i.idea}
${i.feedback ? `\nThe user asked for these changes: ${i.feedback}\n` : ""}
Stay faithful to the idea: its main character (for example a fisherman, a schoolgirl, a shopkeeper), its setting and its genre MUST be what the story is about. Do not swap them for something generic.
Write:
- "title": a short original title.
- "logline": one sentence (who wants what, what goes wrong, the twist).
- "characters": 1 to ${profile.planning.maxCharacters}. The FIRST one is the hero. Each has a lowercase kebab-case "id", a "role", "appearance" (starting with age and gender as the story intends, e.g. "a young man", then face, hair and build: physical features only) and ONE distinctive "clothing" costume built from two strong colours (for example "yellow raincoat with a blue scarf") that also shows their job or role (a fisherman wears a net over his shoulder, a doctor a white coat). The costume is how viewers recognise the character in every shot, so make it simple and bold. Every character is a real person or creature that can be drawn, never a voice or an idea.
- "locations": 2 to ${Math.min(3, profile.planning.maxLocations)}. Each has a kebab-case "id", a "look" (architecture, materials, mood; no people), "lighting" (light colours and sources), "timeOfDay" (morning, day, golden_hour, sunset, night) and "weather" (sunny, clear, cloudy, overcast, rain, fog). Pick what fits THIS story: a cheerful or everyday story is usually a sunny day; only a story that needs darkness happens at night.
Everything is drawn as a cinematic 3D animated film frame, so describe things that look good in moody light.
Image budget: the film is built from about ${c.maxKeyImages} generated pictures, so keep the cast and places few and distinctive.`;
}

export function beatsPrompt(i: DirectInput, outline: DirectorOutline): string {
  const cast = outline.characters.map((c) => `${c.id} (${c.name}: ${c.role})`).join("; ");
  const places = outline.locations.map((l) => `${l.id} (${l.name})`).join("; ");
  return `Write the story of this short as exactly 6 beats, one short paragraph each (what HAPPENS, concretely).

Title: ${outline.title}
Logline: ${outline.logline}
Idea: ${i.idea}
Cast: ${cast}
Places: ${places}
${i.feedback ? `\nThe user asked for these changes: ${i.feedback}\n` : ""}
The beats, in order: ${BEATS.join(" -> ")}.
- hook: an unexplained, intriguing event that starts the film in the first 2 seconds.
- setup: the hero and their ordinary task, in the first place.
- curiosity: something does not add up; the hero goes closer.
- conflict: the hero meets the source of the mystery; it knows something about them.
- escalation: it gets worse, the hero is shaken.
- payoff: a twist that reframes everything we saw, then a final image.
Use at least 2 of the places. The hero is in most beats. Be specific and surprising; never write "mysterious package" or "dark alley" without saying what is strange about it.`;
}

export function beatShotsPrompt(i: DirectInput, profile: FormatProfile, outline: DirectorOutline, beat: Beat, what: string, n: number, soFar: DirectedShot[], wordBudget: number): string {
  const hero = outline.characters[0]!;
  const cast = outline.characters.map((c) => `- ${c.id}: ${c.name}, ${c.role}`).join("\n");
  const places = outline.locations.map((l) => `- ${l.id}: ${l.name}`).join("\n");
  const prev = soFar.length ? soFar.slice(-4).map((s, k) => `${soFar.length - Math.min(4, soFar.length) + k + 1}. [${s.shotType}] ${s.action}${s.line ? ` — ${s.line.speaker}: "${s.line.text}"` : ""}`).join("\n") : "(this is the first shot)";
  return `Direct the "${beat}" part of the short "${outline.title}": ${what}

Write ${n === 1 ? "exactly 1 shot" : `${n} shots`} for this beat.
Cast (use ONLY these ids):
${cast}
Locations (use ONLY these ids):
${places}
Shots so far:
${prev}
${i.feedback ? `\nThe user asked for these changes: ${i.feedback}\n` : ""}
Shot rules:
- "beat" is "${beat}". "shotType" is one of ${SHOT_TYPES.join(", ")}; vary the framing from the shots above and use a close-up for every strong emotion.
- "character" is the ONE character id visible in the shot${beat === "hook" ? " (use \"\" for an object such as a phone or door)" : ""}; the hero is "${hero.id}". Never two characters in one shot.
- "emotion" is one of ${STORY_EMOTIONS.join(", ")}.
- "action": one concrete sentence about what we SEE (present tense), no camera jargon.
- "line": optional, one short line a person would really SAY (max 12 words), never a place name or caption. "speaker" is a character id, or "narrator" (avoid narration). Spoken words left for the whole film: about ${wordBudget}.
- "onScreenText": only for a phone/message/screen close-up: the text shown on it.
- ACTION FIRST. For the visible character give three short plain-words fields: "move" = how they travel in this shot ("walk to the door", "run away", "enter from the left", "none"); "gesture" = what their hands do ("wave to someone", "push the door open", "check the phone", "point at the window", "none"); "reaction" = how they react at the end ("stop and listen", "turn head toward the sound", "step back in fear", "none"). In wide and medium shots at least one of move/gesture must not be "none"; when the character discovers something, give a reaction. Never give coordinates, pixels or frame numbers.
- "actions": optional extra list (walk, run, turn, look-left, look-right, look-up, look-down, head-turn, nod, shake-head, step-back, point, raise-hand, reach, push, pull, raise-object, hold-phone, listen, surprise, fear, smile) with "when" (start, early, mid, late, end) and "toward" in plain words.
- Make the story PHYSICAL: describe what MOVES in "action" (walks down the hallway, pushes the door open, the phone buzzes). At least one shot in three shows the character travelling through the place in a wide or medium shot (walk, run, enter, exit); a door, a phone or a light that changes is an object action.
- "objects": optional, for a visible object that moves: a door that opens, a phone that lights up (action appear, disappear, move, open, close, glow, shake, drive, flicker).
- "location" is one of the ids above.`;
}

/** A small model loops ("What's going on?" three times). Keep the first occurrence of a line, drop the repeats. */
export function dropRepeatedLines(shots: DirectedShot[]): DirectedShot[] {
  const seen = new Set<string>();
  return shots.map((s) => {
    if (!s.line) return s;
    const k = s.line.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (seen.has(k)) { const { line: _drop, ...rest } = s; return rest; }
    seen.add(k);
    return s;
  });
}

/**
 * Deterministic variety pass: no framing three times in a row, and at least 4 different framings overall. A small model
 * repeats itself; swapping a repeated shot for its natural neighbour (wide <-> medium, close-up <-> medium-close) keeps the
 * story but fixes the rhythm.
 */
export function varyFraming(shots: DirectedShot[]): DirectedShot[] {
  const alt: Record<ShotType, ShotType> = {
    wide: "medium-wide", establishing: "low-angle", "medium-wide": "medium", medium: "medium-close", "medium-close": "close-up", "close-up": "extreme-close-up", "extreme-close-up": "close-up",
    "over-shoulder": "medium", pov: "close-up", "low-angle": "high-angle", "high-angle": "low-angle", tracking: "medium-wide", action: "medium",
  };
  const out = shots.map((s) => ({ ...s }));
  for (let i = 2; i < out.length; i++) if (out[i]!.shotType === out[i - 1]!.shotType && out[i]!.shotType === out[i - 2]!.shotType) out[i]!.shotType = alt[out[i]!.shotType];
  const pool: ShotType[] = ["wide", "medium", "close-up", "low-angle", "extreme-close-up"];
  for (let k = 0; new Set(out.map((s) => s.shotType)).size < Math.min(4, out.length) && k < out.length; k++) {
    const i = (k * 3 + 1) % out.length;
    const missing = pool.find((t) => !out.some((s) => s.shotType === t));
    if (missing && i > 0 && i < out.length - 1) out[i]!.shotType = missing;
  }
  return out;
}

/**
 * The AI director. Small structured Ollama calls (story bible, six story beats, then the shots of each beat) whose output
 * is normalised, validated and repaired; everything numeric or visual is then DERIVED by `buildStory` (camera language,
 * durations, SFX, image prompts and image reuse). The model never writes a camera value, a prompt or a filter. Working
 * beat by beat keeps a 3B model coherent: each call is a small task with the story so far in front of it.
 */
export class ShotDirector {
  constructor(private readonly llm: LLMProvider, private readonly opts: { maxRepairs: number; temperature: number }) {}

  async direct(input: DirectInput, profile: FormatProfile, hooks: DirectHooks = {}): Promise<DirectResult> {
    const cin = profile.cinematic;
    if (!cin) throw new Error(`profile ${profile.id} has no cinematic settings`);
    const sys = { role: "system" as const, content: directorSystemPrompt(profile) };
    const common = { llm: this.llm, maxRepairs: this.opts.maxRepairs, temperature: this.opts.temperature, signal: hooks.signal, onRepair: hooks.onRepair };

    hooks.onStep?.("outline");
    const outline = await generateStructured({
      ...common, label: "story bible", schema: DirectorOutlineSchema, messages: [sys, { role: "user", content: outlinePrompt(input, profile) }], normalize: normalizeOutline,
      refine: (v) => ({
        value: v,
        issues: [
          ...(v.characters.length > profile.planning.maxCharacters ? [`Too many characters (${v.characters.length}); use at most ${profile.planning.maxCharacters}.`] : []),
          ...(new Set(v.characters.map((c) => c.id)).size !== v.characters.length ? ["Character ids must be unique."] : []),
          ...(new Set(v.locations.map((l) => l.id)).size !== v.locations.length ? ["Location ids must be unique."] : []),
          ...(v.locations.length > profile.planning.maxLocations ? [`Too many locations; use at most ${profile.planning.maxLocations}.`] : []),
        ],
      }),
    });

    hooks.onStep?.("beats");
    const beats = await generateStructured({
      ...common, label: "story beats", schema: DirectedBeatsSchema, messages: [sys, { role: "user", content: beatsPrompt(input, outline) }], normalize: normalizeBeats,
    });

    const total = expectedShotCount(profile, input.targetDurationSeconds);
    const per = shotsPerBeat(total);
    const wordCap = Math.round(input.targetDurationSeconds * 2.4);
    const shots: DirectedShot[] = [];
    let used = 0;
    let narrated = 0;
    for (const b of beats.beats) {
      hooks.onStep?.("shots", b.beat);
      const n = per[b.beat];
      let softLeft = 1;
      const got = await generateStructured({
        ...common, label: `${b.beat} shots`, schema: BeatShotsSchema,
        messages: [sys, { role: "user", content: beatShotsPrompt(input, profile, outline, b.beat, b.what, n, shots, Math.max(0, wordCap - used)) }],
        normalize: (raw) => normalizeShots(raw, outline),
        // speech-quality advice is sent back once, then accepted: a small model must never block the whole project
        refine: (v) => {
          const issues = checkBeatShots(v.shots, outline, b.beat, narrated);
          if (issues.length && softLeft > 0) { softLeft--; return { value: v, issues }; }
          return { value: v, issues: [] };
        },
      });
      for (const s of got.shots.slice(0, Math.max(n, 1) + 1)) {
        shots.push({ ...s, beat: b.beat });
        used += s.line ? wordCount(s.line.text) : 0;
        if (s.line?.speaker === "narrator") narrated++;
      }
    }
    const directed: DirectedShots = { shots: dropRepeatedLines(varyFraming(shots)).slice(0, cin.maxShots) };
    if (directed.shots.length < cin.minShots) throw new Error(`The director wrote only ${directed.shots.length} shots (at least ${cin.minShots} are needed).`);
    const title = outline.title.trim();
    return { title, ...buildStory(outline, directed, profile, title) };
  }
}

/**
 * An AUTHORED story in the director's own output format ({ outline, shots }): the same normalisation, schemas and whole-film
 * checks as the AI director, then the same deterministic `buildStory` (durations, camera, SFX, prompts). Only the LLM call is
 * skipped. Unlike model output, an authored plan is not silently repaired: an unknown id or beat is an error. The plan's own
 * length is the limit (an authored 3-minute story may have more shots than the AI director writes).
 */
export function storyFromPlan(raw: unknown, profile: FormatProfile, targetSeconds: number): DirectResult & { advice: string[] } {
  const cin = profile.cinematic;
  if (!cin) throw new Error(`profile ${profile.id} has no cinematic settings`);
  const r = (raw ?? {}) as { outline?: unknown; shots?: unknown };
  const o = DirectorOutlineSchema.safeParse(normalizeOutline(r.outline));
  if (!o.success) throw new Error(`plan outline: ${o.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const outline = o.data;
  const rawShots = Array.isArray(r.shots) ? (r.shots as Record<string, unknown>[]) : [];
  if (rawShots.length < 3 || rawShots.length > 60) throw new Error(`plan: ${rawShots.length} shots (an authored plan needs 3-60)`);
  const chars = new Set(outline.characters.map((c) => c.id)), locs = new Set(outline.locations.map((l) => l.id));
  const strict: string[] = [];
  rawShots.forEach((s, i) => {
    if (!locs.has(String(s.location))) strict.push(`shot ${i + 1}: unknown location "${String(s.location)}"`);
    if (s.character && !chars.has(String(s.character))) strict.push(`shot ${i + 1}: unknown character "${String(s.character)}"`);
    const sp = (s.line as { speaker?: unknown } | undefined)?.speaker;
    if (sp !== undefined && sp !== "narrator" && !chars.has(String(sp))) strict.push(`shot ${i + 1}: unknown speaker "${String(sp)}"`);
    if (!(BEATS as readonly string[]).includes(String(s.beat))) strict.push(`shot ${i + 1}: beat must be one of ${BEATS.join(", ")}`);
  });
  if (strict.length) throw new Error(`plan: ${strict.join("; ")}`);
  const parsed = z.object({ shots: z.array(DirectedShotSchema).min(3).max(60) }).safeParse(normalizeShots({ shots: rawShots }, outline));
  if (!parsed.success) throw new Error(`plan shots: ${parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const sized: FormatProfile = { ...profile, cinematic: { ...cin, minShots: Math.min(cin.minShots, parsed.data.shots.length), maxShots: Math.max(cin.maxShots, parsed.data.shots.length) } };
  const { hard, advice } = checkShots(parsed.data, outline, sized, parsed.data.shots.length, targetSeconds);
  if (hard.length) throw new Error(`plan: ${hard.join(" ")}`);
  const title = outline.title.trim();
  const built = buildStory(outline, parsed.data, sized, title, { trustBeats: true });
  applyCastAndPartners(r as AuthoredExtras, built, chars);
  return { title, ...built, story: StorySchema.parse(built.story), advice };
}

/** Plan-only extras: `cast` = per character a 3D model and a voice; per shot `with` = other characters on screen and what they do. */
interface AuthoredExtras {
  artStyle?: string;
  cast?: Record<string, { asset?: string; voice?: string }>;
  shots?: { with?: { character: string; actions?: { action: string; when?: string; toward?: string }[] }[] }[];
}
function applyCastAndPartners(r: AuthoredExtras, built: { characters: Character[]; story: Story }, chars: Set<string>): void {
  const issues: string[] = [];
  if (r.artStyle) built.story.artStyle = r.artStyle;
  for (const [id, c] of Object.entries(r.cast ?? {})) {
    const ch = built.characters.find((x) => x.id === id);
    if (!ch) { issues.push(`cast: unknown character "${id}"`); continue; }
    if (c.asset) ch.asset3d = c.asset;
    if (c.voice) ch.voiceId = c.voice;
  }
  (r.shots ?? []).forEach((s, i) => {
    const shot = built.story.shots[i];
    if (!shot || !s.with?.length) return;
    for (const w of s.with) {
      if (!chars.has(w.character)) { issues.push(`shot ${i + 1}: with: unknown character "${w.character}"`); continue; }
      if (!shot.subjectIds.includes(w.character)) shot.subjectIds.push(w.character);
      for (const a of w.actions ?? []) {
        if (!(ANIM_ACTIONS as readonly string[]).includes(a.action)) { issues.push(`shot ${i + 1}: with ${w.character}: unknown action "${a.action}"`); continue; }
        shot.animation = shot.animation ?? { actions: [], objects: [] };
        shot.animation.actions.push({ character: w.character, action: a.action as ShotAnimAction["action"], when: (ANIM_WHEN as readonly string[]).includes(a.when ?? "") ? (a.when as ShotAnimAction["when"]) : "mid", ...(a.toward ? { toward: a.toward } : {}) });
      }
    }
    if (shot.subjectIds.length > 3) issues.push(`shot ${i + 1}: at most 3 characters on screen`);
  });
  if (issues.length) throw new Error(`plan: ${issues.join("; ")}`);
}

/** Structural checks for one beat's shots (ids were already repaired deterministically; this catches speech problems). */
export function checkBeatShots(shots: DirectedShot[], outline: DirectorOutline, beat?: Beat, narratedSoFar = 0): string[] {
  const issues: string[] = [];
  // narration is a garnish for the first and last beat; the middle belongs to the characters
  if (beat && beat !== "hook" && beat !== "payoff" && shots.some((s) => s.line?.speaker === "narrator")) issues.push(`Narration is only allowed in the hook and the payoff. In this beat let a character speak (set "speaker" to a character id), or omit "line".`);
  else if (shots.some((s) => s.line?.speaker === "narrator") && narratedSoFar >= 1) issues.push(`There is already a narrator line; let a character speak this one (set "speaker" to a character id), or omit "line".`);
  const labels = new Set([...outline.locations.map((l) => l.name.toLowerCase()), ...outline.locations.map((l) => l.id)]);
  for (const s of shots) {
    if (!s.line) continue;
    const t = s.line.text.toLowerCase().replace(/[.!?]+$/, "");
    if (labels.has(t) || (wordCount(t) <= 3 && /\b(alley|office|street|lobby|room|building|city)\b/.test(t))) issues.push(`The line "${s.line.text}" is a place label, not speech. Write what a character would actually say, or omit "line".`);
    if (wordCount(s.line.text) > 16) issues.push(`The line "${s.line.text}" is too long (max 12 words).`);
  }
  return issues;
}

/** Whole-film checks (used for diagnostics and tests; the per-beat calls cannot re-run the whole film). */
export function checkShots(v: DirectedShots, outline: DirectorOutline, profile: FormatProfile, expected: number, targetSeconds: number): { hard: string[]; advice: string[] } {
  const cin = profile.cinematic!;
  const hard: string[] = [];
  const advice: string[] = [];
  const n = v.shots.length;
  if (n < cin.minShots || n > cin.maxShots || Math.abs(n - expected) > 3) hard.push(`Write about ${expected} shots (between ${Math.max(cin.minShots, expected - 3)} and ${Math.min(cin.maxShots, expected + 3)}); you wrote ${n}.`);
  const chars = new Set(outline.characters.map((c) => c.id)), locs = new Set(outline.locations.map((l) => l.id));
  v.shots.forEach((s, i) => {
    if (!locs.has(s.location)) hard.push(`shot ${i + 1}: unknown location "${s.location}" (known: ${[...locs].join(", ")}).`);
    if (s.character && !chars.has(s.character)) hard.push(`shot ${i + 1}: unknown character "${s.character}" (known: ${[...chars].join(", ")}; use "" for none).`);
    if (s.line && s.line.speaker !== "narrator" && !chars.has(s.line.speaker)) hard.push(`shot ${i + 1}: unknown speaker "${s.line.speaker}".`);
  });
  for (let i = 2; i < n; i++) if (v.shots[i]!.shotType === v.shots[i - 1]!.shotType && v.shots[i]!.shotType === v.shots[i - 2]!.shotType) { hard.push(`shots ${i - 1}-${i + 1} use the same shotType "${v.shots[i]!.shotType}" three times in a row; vary the framing.`); break; }
  if (new Set(v.shots.map((s) => s.shotType)).size < Math.min(4, n)) hard.push("Use at least 4 different shot types.");
  const words = v.shots.reduce((s, x) => s + (x.line ? wordCount(x.line.text) : 0), 0);
  if (words === 0) hard.push("The film needs some spoken dialogue or narration (at least 3 lines).");
  if (words > targetSeconds * 2.6) hard.push(`Too much speech (${words} words); keep it under ${Math.round(targetSeconds * 2.4)} words so the pictures can breathe.`);
  if (v.shots.filter((s) => s.line).length < 2) hard.push("Give at least 2 shots a spoken line.");
  const withHero = v.shots.filter((s) => s.character && chars.has(s.character)).length;
  if (withHero < Math.ceil(n / 2)) advice.push(`Only ${withHero} of ${n} shots show a character. Set "character" to the hero's id in at least ${Math.ceil(n / 2)} shots (use "" only for empty places and objects).`);
  const hero = outline.characters[0]!.id;
  if (!v.shots.some((s) => s.character && s.character !== hero) && outline.characters.length > 1) advice.push(`The second character (${outline.characters[1]!.id}) never appears. Show them in at least one shot.`);
  if (v.shots.filter((s) => s.line?.speaker === "narrator").length > 2) advice.push("Too much narration; let the characters speak (at most 1-2 narrator lines).");
  const bad = v.shots.flatMap((s) => (s.line ? checkBeatShots([s], outline) : []))[0];
  if (bad) advice.push(bad);
  const used = new Set(v.shots.map((s) => s.location));
  if (outline.locations.length > 1 && used.size < 2) advice.push(`Every shot is in the same location; use at least 2 of: ${outline.locations.map((l) => l.id).join(", ")}.`);
  return { hard, advice };
}
