import path from "node:path";
import { ID_PATTERN } from "@studio/shared";
import { HttpError } from "../errors";

/** Validates a kebab-case identifier that will become a directory name. */
export function assertSafeId(id: unknown, kind = "id"): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 64 || !ID_PATTERN.test(id)) {
    throw new HttpError(400, "invalid_id", `Invalid ${kind}`);
  }
  return id;
}

/**
 * Joins path segments under `root` and refuses anything that resolves outside it
 * (`..`, absolute segments, ...). Every filesystem access derived from an id or
 * file name must go through this.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new HttpError(400, "path_traversal", "Path escapes the allowed directory");
  }
  return target;
}
