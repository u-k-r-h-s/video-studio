import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The reusable 3D asset registry (config/assets3d.json): stable ids, a category, the file (or null for assets built
 * procedurally in code), the source, licence and attribution, and how to place the asset (target height, forward axis,
 * clip names). Lookups never throw: a missing id or file is reported as a diagnostic and resolves to a fallback (the
 * caller skips the asset or uses its procedural version), so a missing download cannot break a render.
 */
export type AssetCategory = "character" | "animal" | "house" | "prop" | "vegetation" | "vehicle";
export interface AssetEntry {
  category: AssetCategory; file: string | null; bytes?: number;
  source: string; licence: string; attribution?: string; purpose?: string;
  height?: number; forward?: "+z" | "-z" | "+x" | "-x"; foreground?: boolean;
  clips?: Record<string, string>;
}
export interface Resolved { id: string; entry: AssetEntry | null; file: string | null; ok: boolean; problem?: string }

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../../..");
let cache: Record<string, AssetEntry> | null = null;

export function loadAssetRegistry(file = path.join(ROOT, "config/assets3d.json")): Record<string, AssetEntry> {
  if (cache && file === path.join(ROOT, "config/assets3d.json")) return cache;
  const reg = JSON.parse(readFileSync(file, "utf8")).assets as Record<string, AssetEntry>;
  if (file === path.join(ROOT, "config/assets3d.json")) cache = reg;
  return reg;
}

/** Resolves an id to its entry and file, with a diagnostic instead of an exception when anything is missing. */
export function resolveAsset(id: string, reg = loadAssetRegistry(), root = ROOT): Resolved {
  const entry = reg[id];
  if (!entry) return { id, entry: null, file: null, ok: false, problem: `unknown asset id "${id}"` };
  if (entry.file === null) return { id, entry, file: null, ok: true }; // procedural
  const file = path.resolve(root, entry.file);
  if (!existsSync(file)) return { id, entry, file: null, ok: false, problem: `asset "${id}": file missing at ${entry.file} (download it from ${entry.source})` };
  if (entry.bytes !== undefined && statSync(file).size !== entry.bytes) return { id, entry, file, ok: true, problem: `asset "${id}": size ${statSync(file).size} differs from the registry (${entry.bytes}); re-check the licence of the new file` };
  return { id, entry, file, ok: true };
}

/** Every registry problem at once (for a pre-render check and the report). */
export function auditAssets(reg = loadAssetRegistry(), root = ROOT): string[] {
  const out: string[] = [];
  for (const id of Object.keys(reg)) {
    const r = resolveAsset(id, reg, root), e = reg[id]!;
    if (r.problem) out.push(r.problem);
    if (!e.licence) out.push(`asset "${id}": no licence recorded`);
    if (!e.source) out.push(`asset "${id}": no source recorded`);
  }
  return out;
}
