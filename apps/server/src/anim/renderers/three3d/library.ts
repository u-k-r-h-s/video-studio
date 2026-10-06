import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Character } from "@studio/shared";
import type { Cast3D } from "./compile";
import type { PropSpec3D } from "./spec";

/**
 * The local 3D character library: assets/3d/characters/<key>/character.glb (git-ignored; see docs/renderer-3d.md).
 * Casting picks a base model for a story character and dresses it: material colours from the costume words, a courier bag
 * for a delivery person. (AI 3D generation will plug in here later; nothing else depends on where a model comes from.)
 */
export const LIBRARY_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../../../assets/3d/characters");

export function characterFile(asset: string): string { return path.join(LIBRARY_DIR, asset, "character.glb"); }
export function libraryCharacters(): string[] {
  if (!existsSync(LIBRARY_DIR)) return [];
  return readdirSync(LIBRARY_DIR).filter((d) => existsSync(characterFile(d)));
}

const COLOURS: [RegExp, string][] = [
  [/orange/, "#e0641c"], [/red|crimson/, "#a3222a"], [/yellow|mustard/, "#d9a520"], [/green|olive/, "#3f6b3a"], [/blue|navy|denim/, "#2d4f86"],
  [/purple|violet/, "#5a3d86"], [/pink/, "#d07a98"], [/brown|tan|khaki/, "#7a5634"], [/black|dark/, "#22252b"], [/white|cream/, "#d9d6cf"], [/gr[ae]y/, "#6f747c"],
];
const colourIn = (s: string): string | undefined => COLOURS.find(([re]) => re.test(s))?.[1];

/** Base model per story character (the first library model, or one whose folder name appears in the character's words). */
export function castFor(c: Character, available = libraryCharacters()): Cast3D {
  const words = `${c.appearance} ${c.clothing ?? ""} ${c.description}`.toLowerCase();
  const asset = available.find((a) => words.includes(a.replace(/-/g, " "))) ?? (available.includes("casual-man") ? "casual-man" : available[0] ?? "casual-man");
  const clothing = (c.clothing ?? "").toLowerCase();
  const [top, bottom] = clothing.split(/\band\b|,|with/).map((x) => x.trim());
  const wardrobe: Record<string, string> = {};
  const topC = colourIn(top ?? ""), bottomC = colourIn(bottom ?? "");
  // material names of the Quaternius casual rig; other rigs simply ignore unknown names
  if (topC) wardrobe.LightBrown = topC; // shirt / jacket
  if (bottomC) wardrobe.LightBlue = bottomC; // trousers
  const props: PropSpec3D[] = [];
  if (/(delivery|courier|rider|postman|mail)/.test(words)) props.push({ id: `bag-${c.id}`, kind: "bag", socket: "back", color: "#d4692a" });
  return { asset, wardrobe, props };
}
