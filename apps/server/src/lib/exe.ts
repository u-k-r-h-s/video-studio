import fs from "node:fs";
import path from "node:path";

const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/usr/sbin", "/bin", "/sbin"];

/** Resolves an executable without a shell: explicit path first, then PATH + common install dirs. */
export function findExecutable(name: string, explicit?: string): string | undefined {
  const candidates = explicit
    ? [explicit]
    : [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...EXTRA_BIN_DIRS].map((d) => path.join(d, name));
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* next */
    }
  }
  return undefined;
}
