import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Character } from "@studio/shared";

/**
 * Story-level casting: every story character gets the library model that best fits its description (gender, age, style,
 * matching words), and no two characters share a model while there are others to choose from. An explicit choice
 * (Character.asset3d, or --asset) always wins. Nothing here assumes a particular story (no default courier).
 */
export interface CatalogEntry { style: string; gender: "male" | "female"; age: "child" | "adult" | "elder"; tags: string[]; face: string; license: string; source: string }
const CATALOG_FILE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../../../config/characters3d.json");

export function loadCatalog(file = CATALOG_FILE, available?: (key: string) => boolean): Record<string, CatalogEntry> {
  if (!existsSync(file)) return {};
  const all = (JSON.parse(readFileSync(file, "utf8")) as { characters: Record<string, CatalogEntry> }).characters;
  return Object.fromEntries(Object.entries(all).filter(([k]) => !available || available(k)));
}

const words = (c: Character): string => `${c.name} ${c.appearance} ${c.clothing ?? ""} ${c.description} ${c.visualIdentity ?? ""}`.toLowerCase();
export function genderOf(c: Character): "male" | "female" | null {
  const t = ` ${words(c)} `;
  const f = /\b(woman|women|girl|she|her|mother|mom|maa|amma|sister|didi|aunt|aunty|grandmother|dadi|nani|wife|daughter|lady|female|queen|teacher woman)\b/.test(t);
  const m = /\b(man|men|boy|he|his|father|papa|brother|bhaiya|uncle|kaka|chacha|grandfather|dada|nana|husband|son|gentleman|male|king)\b/.test(t);
  return f && !m ? "female" : m && !f ? "male" : f && m ? (/(^| )(she|her|woman|girl)\b/.test(t) ? "female" : "male") : null;
}
export function ageOf(c: Character): "child" | "adult" | "elder" {
  const t = words(c);
  if (/\b(child|kid|girl|boy|daughter|son|\d{1,2}-year-old|ten|eleven|twelve|teen|student)\b/.test(t) && !/\b(\d{2,})-year-old\b/.test(t.replace(/\b1\d-year-old\b/, ""))) return /\b(old man|old woman|grand)\b/.test(t) ? "elder" : "child";
  if (/\b(old|elderly|aged|grey|gray|retired|grandfather|grandmother|dada|dadi|nana|nani|kaka|wrinkled)\b/.test(t)) return "elder";
  return "adult";
}

/** The model for each character id. `style` prefers models of that art style (e.g. "semi-realistic"). */
export function castStory(characters: Character[], catalog: Record<string, CatalogEntry>, style?: string, forced?: string): Record<string, string> {
  const out: Record<string, string> = {}, used = new Map<string, number>();
  for (const c of characters) if (c.asset3d) { out[c.id] = c.asset3d; used.set(c.asset3d, (used.get(c.asset3d) ?? 0) + 1); }
  for (const c of characters) {
    if (out[c.id]) continue;
    if (forced) { out[c.id] = forced; continue; }
    const g = genderOf(c), a = ageOf(c), t = words(c);
    const score = (k: string, e: CatalogEntry): number =>
      (g && e.gender === g ? 40 : g ? -40 : 0) + (e.age === a ? 20 : a === "elder" || e.age === "elder" ? -15 : -5) + (style && e.style === style ? 25 : 0)
      + (e.face !== "none" ? 8 : 0) + e.tags.filter((x) => t.includes(x)).length * 4 - (used.get(k) ?? 0) * 60;
    const best = Object.entries(catalog).sort((x, y) => score(y[0], y[1]) - score(x[0], x[1]))[0];
    if (!best) continue;
    out[c.id] = best[0];
    used.set(best[0], (used.get(best[0]) ?? 0) + 1);
  }
  return out;
}
