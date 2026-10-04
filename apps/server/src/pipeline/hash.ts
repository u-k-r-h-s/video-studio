import { createHash } from "node:crypto";

/** Stable JSON (sorted keys) so equal inputs always hash equally. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Short content hash of everything that determines an asset. A changed hash means the asset is stale. */
export const stableHash = (v: unknown): string => createHash("sha256").update(canonical(v)).digest("hex").slice(0, 16);

/** Deterministic seed in the range ComfyUI accepts, from project + asset + regeneration attempt. */
export function seedFor(projectId: string, assetId: string, attempt: number): number {
  return parseInt(createHash("sha256").update(`${projectId}:${assetId}:${attempt}`).digest("hex").slice(0, 10), 16) % 2_000_000_000;
}
