import type { AnimationSettings, Character, Location, Shot, Story } from "@studio/shared";
import { stableHash } from "../pipeline/hash";
import { classifyProp, neededForCharacter, normName, type PropKind } from "./semantics";
import { VIEW_NAMES, type ViewName } from "./types";

/** Bump when prompts or processing change so cached assets are regenerated. */
export const ASSET_RECIPE_VERSION = "anim-assets-v1";

export type ManifestKind = "location" | "character_view" | "head_variant" | "prop";
export interface ManifestAsset {
  /** Stable identity inside a project: the same character/location/prop always gets the same id. */
  id: string;
  kind: ManifestKind;
  ownerId: string;
  view?: ViewName;
  variant?: string;
  label: string;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  model: string;
  /** Cut-out: none (backgrounds), one BiRefNet pass, or several passes (a hand and the phone it holds). */
  matte: "none" | "single" | "multi";
  /** img2img source (another manifest asset) and strength: identity carries over from the front view / the head crop. */
  init?: { assetId: string; denoise: number };
  /** Assets with the same key are generated from the same seed (the camera views of one character keep one identity). */
  seedKey?: string;
  /** Stable content hash: kind + prompt + size + model + recipe + the hash of what it was derived from. */
  hash: string;
  /** Which shots need it (why it is generated). */
  shots: string[];
}
export interface AssetManifest {
  version: 1;
  characters: { id: string; name: string; identity: string; views: ViewName[]; variants: string[]; assetIds: string[] }[];
  locations: { id: string; name: string; assetId: string }[];
  props: { id: string; label: string; kind: PropKind; assetId: string; shots: string[] }[];
  /** Procedural effects (no generation) the shots call for. */
  effects: { type: string; shots: string[] }[];
  assets: ManifestAsset[];
}

const GREY = "plain flat light grey studio background, nothing else in the picture";
const WHITE = "plain flat pure white studio background, soft even lighting";
const VIEW_WORDS: Record<ViewName, string> = {
  front: "standing, legs apart, arms relaxed at the sides, facing slightly to the left",
  "three-quarter": "in three-quarter view turned toward the left, standing, legs apart, arms relaxed",
  side: "seen exactly from the side in profile facing left, standing straight, both arms hanging straight down at the sides, feet together",
  back: "seen from behind with the back to the camera, standing, legs apart, arms relaxed",
};
const VARIANT_WORDS: Record<string, [string, number, number]> = {
  front: ["looking straight into the camera, calm neutral expression", 0.5, 1.8],
  lookL: ["head turned strongly to the left, side profile facing left, eyes looking far to the left", 0.68, 2.4],
  lookR: ["head turned strongly to the right, side profile facing right, eyes looking far to the right", 0.68, 2.4],
  surprised: ["gasping in shock, mouth wide open, eyes huge and wide open, eyebrows raised very high, astonished expression", 0.68, 3.2],
  smile: ["big warm smile showing teeth, happy eyes", 0.6, 2.4],
  worried: ["terrified scared expression, eyes huge and wide, eyebrows raised, mouth open in fear", 0.68, 3.2],
  angry: ["furious angry scowl, eyebrows pulled low and together, teeth clenched", 0.64, 2.6],
};
export const variantSettings = (name: string): { words: string; denoise: number; cfg: number } => {
  const v = VARIANT_WORDS[name] ?? VARIANT_WORDS.front!;
  return { words: v[0], denoise: v[1], cfg: v[2] };
};

const PROP_PROMPTS: Record<PropKind, (label: string) => string> = {
  phone: () => `a hand holding a smartphone with a dark screen, close view from the front, ${GREY}`,
  door: () => `a closed heavy wooden door with panels, seen straight from the front, flat even lighting, filling the picture, ${GREY}`,
  car: () => `a dark sedan car seen exactly from the side, perfect side profile view, both wheels visible, headlights glowing, ${GREY}`,
  package: () => `a cardboard delivery package wrapped with tape, three-quarter view, ${GREY}`,
  picture: (label) => `a ${label}, a single flat sheet seen straight from the front, filling the picture, ${GREY}`,
  generic: (label) => `a ${label}, a single object, ${GREY}`,
};

export function characterIdentityText(c: Pick<Character, "appearance" | "clothing" | "visualIdentity">): string {
  return c.visualIdentity ?? [c.appearance, c.clothing].filter(Boolean).join(", ");
}

/** Effects a location suggests (procedural, no generation): from the words the director used for its look and lighting. */
export function effectsForLocation(l: Pick<Location, "visualIdentity" | "lighting" | "description">): string[] {
  const t = `${l.visualIdentity} ${l.lighting} ${l.description}`.toLowerCase();
  const out: string[] = [];
  if (/(rain|wet|storm|drizzle)/.test(t)) out.push("rain");
  if (/(fog|mist|haze|smoke)/.test(t)) out.push("fog");
  if (/(snow|blizzard|frost)/.test(t)) out.push("snow");
  if (/(neon|flicker|fluorescent|lamp|lantern|streetlight|street light|bulb)/.test(t)) out.push("lightFlicker");
  if (/(dust|abandoned|old|empty|hallway|corridor|warehouse|attic)/.test(t)) out.push("dust");
  if (/(leaves|autumn|park|forest)/.test(t)) out.push("leaves");
  return out;
}

/**
 * Plans every image the animated pipeline needs, and ONLY those: the locations the shots use, each speaking character's front
 * view plus the other camera views and face variants its actions require, and the props the shots name. Pure and deterministic:
 * the same story gives the same ids and hashes, which is what lets assets be cached and reused.
 */
export function planAssets(story: Story, characters: Character[], s: AnimationSettings): AssetManifest {
  const assets: ManifestAsset[] = [];
  const byId = new Map<string, ManifestAsset>();
  const add = (a: Omit<ManifestAsset, "hash">): ManifestAsset => {
    const existing = byId.get(a.id);
    if (existing) { existing.shots = [...new Set([...existing.shots, ...a.shots])]; return existing; }
    const initHash = a.init ? byId.get(a.init.assetId)?.hash : undefined;
    const full: ManifestAsset = { ...a, hash: stableHash({ kind: a.kind, prompt: a.prompt, neg: a.negative, w: a.width, h: a.height, steps: a.steps, cfg: a.cfg, model: a.model, matte: a.matte, seedKey: a.seedKey, init: a.init ? { d: a.init.denoise, h: initHash } : undefined, recipe: ASSET_RECIPE_VERSION }) };
    byId.set(a.id, full);
    assets.push(full);
    return full;
  };

  const usedLocs = [...new Set(story.shots.map((x) => x.locationId))];
  const locations = usedLocs.map((id) => {
    const l = story.locations.find((x) => x.id === id) ?? story.locations[0]!;
    const asset = add({
      id: `loc-${l.id}`, kind: "location", ownerId: l.id, label: l.name, width: s.location.width, height: s.location.height, steps: s.location.steps, cfg: s.location.cfg, model: s.imageModel, negative: s.negativePrompt, matte: "none",
      prompt: `${s.stylePrefix}, wide cinematic view of ${l.visualIdentity}, ${l.lighting}, empty, no people, no cars`, shots: story.shots.filter((x) => x.locationId === id).map((x) => x.id),
    });
    return { id: l.id, name: l.name, assetId: asset.id };
  });

  const chars = [...new Set(story.shots.map((x) => x.subjectIds[0]).filter((x): x is string => !!x))].map((cid) => {
    const c = characters.find((x) => x.id === cid)!;
    const identity = characterIdentityText(c);
    const need = neededForCharacter(story.shots, cid);
    const shotsOf = story.shots.filter((x) => x.subjectIds[0] === cid).map((x) => x.id);
    const views = VIEW_NAMES.filter((v) => need.views.has(v));
    const ids: string[] = [];
    const base = (view: ViewName): ManifestAsset => add({
      id: `char-${cid}-${view}`, kind: "character_view", ownerId: cid, view, label: `${c.name} (${view})`, width: s.character.width, height: s.character.height, steps: view === "front" ? s.character.steps : Math.max(s.character.steps, 8), cfg: view === "front" ? s.character.cfg : Math.max(s.character.cfg, 3), model: s.imageModel, negative: s.negativePrompt, matte: "single",
      // other camera views are text-to-image: img2img from the front view only ever gives the front view again (measured, even at denoise 0.85)
      prompt: `${s.stylePrefix}, full body shot of ${identity}, ${VIEW_WORDS[view]}, ${GREY}`, seedKey: `char-${cid}`, shots: shotsOf,
    });
    const front = base("front");
    ids.push(front.id);
    for (const v of views.filter((x) => x !== "front")) ids.push(base(v).id);
    const variants = [...need.variants].filter((v) => v !== "front").sort();
    if (need.variants.size) variants.unshift("front"); // the redrawn neutral head is the base of the rig whenever any variant exists
    for (const v of variants) {
      const w = variantSettings(v);
      ids.push(add({
        id: `head-${cid}-${v}`, kind: "head_variant", ownerId: cid, variant: v, label: `${c.name} head (${v})`, width: s.head.size, height: s.head.size, steps: s.head.steps, cfg: w.cfg, model: s.imageModel, negative: s.negativePrompt, matte: "single",
        prompt: `${s.stylePrefix}, close portrait of ${c.appearance}${c.clothing ? `, wearing ${c.clothing}` : ""}, ${WHITE}, ${w.words}`, init: { assetId: front.id, denoise: w.denoise }, shots: shotsOf,
      }).id);
    }
    return { id: cid, name: c.name, identity, views, variants, assetIds: ids };
  });

  const propMap = new Map<string, { label: string; kind: PropKind; shots: Set<string> }>();
  const note = (label: string, shotId: string): void => {
    const kind = classifyProp(label);
    const key = kind === "generic" || kind === "picture" ? normName(label) : kind;
    const p = propMap.get(key) ?? { label, kind, shots: new Set<string>() };
    p.shots.add(shotId);
    propMap.set(key, p);
  };
  for (const sh of story.shots) {
    for (const o of sh.animation?.objects ?? []) note(o.object, sh.id);
    if (sh.insert?.kind === "phone") note("phone", sh.id);
  }
  const props = [...propMap.entries()].slice(0, s.maxPropKinds).map(([key, p]) => {
    const asset = add({
      id: `prop-${key}`, kind: "prop", ownerId: key, label: p.label, width: p.kind === "car" ? 768 : s.prop.width, height: p.kind === "car" ? 512 : s.prop.height, steps: s.prop.steps, cfg: s.prop.cfg, model: s.imageModel, negative: s.negativePrompt,
      matte: p.kind === "phone" ? "multi" : "single", prompt: `${s.stylePrefix}, ${PROP_PROMPTS[p.kind](p.label)}`, shots: [...p.shots],
    });
    return { id: key, label: p.label, kind: p.kind, assetId: asset.id, shots: [...p.shots] };
  });

  const effects = new Map<string, Set<string>>();
  for (const sh of story.shots) for (const e of effectsForLocation(story.locations.find((l) => l.id === sh.locationId) ?? story.locations[0]!)) (effects.get(e) ?? effects.set(e, new Set()).get(e)!).add(sh.id);
  return { version: 1, characters: chars, locations, props, effects: [...effects].map(([type, sh]) => ({ type, shots: [...sh] })), assets };
}

/** Compares the manifest with what the project already holds: nothing is regenerated unless its hash changed. */
export function diffManifest(m: AssetManifest, have: Map<string, string>): { missing: ManifestAsset[]; reused: ManifestAsset[] } {
  const missing: ManifestAsset[] = [], reused: ManifestAsset[] = [];
  for (const a of m.assets) (have.get(a.id) === a.hash ? reused : missing).push(a);
  return { missing, reused };
}

export const shotsNeeding = (m: AssetManifest, assetId: string): Shot["id"][] => m.assets.find((a) => a.id === assetId)?.shots ?? [];
