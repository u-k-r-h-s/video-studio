// Resolves a 3D character asset key the way the renderer will (library model, derived POC asset, or a provider export
// folder) and prints the file, or a clear reason it cannot be used. Exit code 1 when it cannot. Changes nothing.
//   npx tsx scripts/check-3d-asset.ts <key>      (casual-man, tripo, meshy, ...)
import fs from "node:fs";
import os from "node:os";
import { characterFile } from "../apps/server/src/anim/renderers/three3d/library";

const key = process.argv[2];
if (!key) { console.error("usage: check-3d-asset.ts <asset-key>"); process.exit(2); }
try {
  const file = characterFile(key);
  if (!fs.existsSync(file)) throw new Error(`3D character "${key}" not found (no ${file.replace(os.homedir(), "~")})`);
  console.log(file);
} catch (e) { console.error((e as Error).message); process.exit(1); }
