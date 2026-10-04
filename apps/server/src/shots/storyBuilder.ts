import { dialogueId, sceneId, shotId, StorySchema, type Beat, type Character, type FormatProfile, type Location, type Shot, type Story } from "@studio/shared";
import { slugify } from "@studio/shared";
import { characterIdentity, planKeyVisuals } from "./keyVisuals";
import { defaultFocus, planCamera } from "./cameraLanguage";
import type { DirectedShots, DirectorOutline } from "./directorSchemas";

export interface BuiltStory { story: Story; characters: Character[] }

/** Base length of a shot by framing (seconds); spoken shots are lengthened to fit the line. */
const BASE: Record<Shot["shotType"], number> = {
  "extreme-close-up": 1.6, "close-up": 1.9, "medium-close": 2.0, medium: 2.2, "medium-wide": 2.3, wide: 2.4, establishing: 2.6, "over-shoulder": 2.2, pov: 2.0, "low-angle": 2.0, "high-angle": 2.0, tracking: 2.4, action: 1.8,
};
const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

type SfxKind = Shot["sfx"][number]["kind"];
const SFX_RULES: [RegExp, SfxKind, number][] = [
  [/\b(phone|message|notification|buzz(es)?|text)\b/i, "ping", 0.1], [/\b(elevator|lift)\b/i, "ding", 0.2], [/\b(door|doors|gate|shutter)\b/i, "door", 0.3],
  [/\b(footsteps?|walks?|steps?|runs?|rushes|sprints?)\b/i, "footsteps", 0.3], [/\b(glitch(es)?|flicker(s|ing)?|static|vanish(es)?|disappear(s)?)\b/i, "glitch", 0.2],
  [/\b(crash(es)?|slam(s)?|explod(es|ing)|bang|smash(es)?|scream(s)?|gasp(s)?)\b/i, "impact", 0.0], [/\b(heartbeat|pounding)\b/i, "heartbeat", 0.2],
];

/** Which story beat a shot falls in when the model's own label is missing or contradicts the order. */
export function beatAt(i: number, n: number): Beat {
  const f = n <= 1 ? 0 : i / (n - 1);
  if (i === 0) return "hook";
  if (i === n - 1) return "payoff";
  return f < 0.2 ? "setup" : f < 0.42 ? "curiosity" : f < 0.62 ? "conflict" : "escalation";
}

/**
 * Turns the model's director output (enums + short text) into a complete, valid Story: ids, scenes, durations,
 * camera, motion, character motion, transitions, SFX, effects, key visuals. Everything that must be consistent or
 * numeric is decided here, deterministically.
 */
export function buildStory(outline: DirectorOutline, directed: DirectedShots, profile: FormatProfile, title: string): BuiltStory {
  const cin = profile.cinematic!;
  const characters: Character[] = outline.characters.map((c) => ({
    id: c.id, name: c.name, description: c.role, appearance: c.appearance, clothing: c.clothing,
    visualIdentity: `${c.appearance}, wearing ${c.clothing}`,
  }));
  const locations: Location[] = outline.locations.map((l) => ({ id: l.id, name: l.name, description: l.look, visualIdentity: l.look, lighting: l.lighting, importantObjects: [] }));
  const known = new Set(characters.map((c) => c.id));
  const raw = directed.shots.slice(0, cin.maxShots);
  const n = raw.length;

  const shots: Shot[] = raw.map((d, i) => {
    const order = i + 1;
    const id = shotId(order);
    const subject = known.has(d.character) ? [d.character] : [];
    // the model's beat is trusted only if it does not contradict the order (first = hook, last = payoff)
    const beat: Beat = i === 0 ? "hook" : i === n - 1 ? "payoff" : d.beat === "hook" || d.beat === "payoff" ? beatAt(i, n) : d.beat;
    const dialogue = d.line && d.line.text.trim()
      ? [{ id: dialogueId(`shot-${String(order).padStart(2, "0")}`, 1), characterId: d.line.speaker === "narrator" || known.has(d.line.speaker) ? d.line.speaker : subject[0] ?? "narrator", text: d.line.text.trim() }]
      : [];
    const words = dialogue.reduce((s, x) => s + wordCount(x.text), 0);
    let duration = BASE[d.shotType];
    if (words) duration = Math.max(duration, 0.45 + words / cin.wordsPerSecond + 0.35);
    if (i === 0) duration = Math.min(duration, Math.max(2.4, words ? 0.5 + words / cin.wordsPerSecond + 0.35 : 2.4));
    duration = Math.round(Math.min(9, duration) * 10) / 10;

    const cam = planCamera({ shotType: d.shotType, beat, emotion: d.emotion, action: d.action, duration, order });
    const sfx: Shot["sfx"] = [];
    for (const [re, kind, at] of SFX_RULES) if (re.test(d.action) && !sfx.some((x) => x.kind === kind) && sfx.length < 2) sfx.push({ kind, at });
    if (i === 0 && !sfx.length) sfx.push({ kind: "riser", at: 0.2, volume: 0.35 });
    if ((d.emotion === "fear" || d.emotion === "tense") && !sfx.some((x) => x.kind === "heartbeat") && sfx.length < 3) sfx.push({ kind: "heartbeat", at: 0.2, volume: 0.35 });
    const intense = d.emotion === "shock" || d.emotion === "fear";
    const characterMotion: Shot["characterMotion"] = !subject.length ? [] : intense
      ? [{ action: "surprise", at: 0.05, strength: 0.9 }, { action: "fear", strength: 0.8 }] : d.emotion === "joy" || d.emotion === "eerie" ? [{ action: "smile", strength: 0.7 }, { action: "breathing" }] : [{ action: "breathing" }];
    const phone = !!d.onScreenText && /\b(phone|message|screen|notification|text|app)\b/i.test(d.action + " " + (d.onScreenText ?? ""));
    const insert: Shot["insert"] = phone ? { kind: "phone", text: d.onScreenText!.toUpperCase() } : i === n - 1 ? { kind: "title", text: title.toUpperCase().slice(0, 60) } : undefined;
    const effects: Shot["effects"] = intense && beat !== "hook" ? { impact: true } : beat === "payoff" && i === n - 2 ? { flash: true } : undefined;
    if (effects?.impact && !sfx.some((x) => x.kind === "impact")) sfx.push({ kind: "impact", at: 0, volume: 0.6 });
    return {
      id, sceneId: "", order, beat, duration, shotType: d.shotType, subjectIds: subject, locationId: locations.some((l) => l.id === d.location) ? d.location : locations[0]!.id, emotion: d.emotion, action: d.action, visualPrompt: d.action, visualKey: "",
      focus: defaultFocus(d.shotType), camera: cam.camera, motion: cam.motion,
      transition: { type: i === n - 1 ? "fade" : "cut" }, characterMotion, dialogue, sfx, ...(insert ? { insert } : {}), ...(effects ? { effects } : {}),
    };
  });

  // a hard cut into a shocking shot lands harder with a zoom punch on the way out of the previous one
  for (let i = 0; i + 1 < shots.length; i++) if (shots[i + 1]!.emotion === "shock" && shots[i]!.transition.type === "cut") shots[i]!.transition = { type: "zoom", duration: 0.3 };

  // scenes: consecutive shots in the same location
  const scenes: Story["scenes"] = [];
  for (const s of shots) {
    const last = scenes[scenes.length - 1];
    if (last && last.locationId === s.locationId) last.shotIds.push(s.id);
    else scenes.push({ id: sceneId(scenes.length + 1), locationId: s.locationId, beat: s.beat, summary: s.action, shotIds: [s.id] });
    s.sceneId = scenes[scenes.length - 1]!.id;
  }

  const style = cin.stylePrefix;
  const { keyVisuals, shotKey } = planKeyVisuals(shots, { style, characters, locations }, cin.maxKeyImages);
  for (const s of shots) s.visualKey = shotKey[s.id]!;

  const story = StorySchema.parse({
    logline: outline.logline,
    beats: [...new Set(shots.map((s) => s.beat))].map((kind) => ({ kind, summary: shots.find((s) => s.beat === kind)!.action })),
    locations, scenes, shots, keyVisuals,
  });
  return { story, characters };
}

export { characterIdentity, slugify };
