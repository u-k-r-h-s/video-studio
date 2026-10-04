import fs from "node:fs/promises";

/** Writes via a temp file + rename so a crash never leaves a half-written JSON file. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

/** Returns undefined when the file does not exist; throws on unreadable / malformed JSON. */
export async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Corrupt JSON file: ${file}`);
  }
}
