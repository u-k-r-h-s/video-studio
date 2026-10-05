// BiRefNet matte on assorted generated images (white, grey, black, denim, glossy), in one ComfyUI session.
import fs from "node:fs";
import { loadConfig } from "../../apps/server/src/config";
import { createContainer } from "../../apps/server/src/container";
import { ComfyProcess } from "../../apps/server/src/providers/image/ComfyProcess";
import { ComfyUIProvider } from "../../apps/server/src/providers/image/ComfyUIProvider";
import { setLogQuiet } from "../../apps/server/src/lib/logger";
import { applyMatte, assessMatte } from "../../apps/server/src/lib/matte";
import { cropToContent, decodePng, encodePng } from "../../apps/server/src/lib/png";

setLogQuiet(true);
const cfg = loadConfig({}, "/Users/apple/Desktop/ai-studio-feasibility");
const c = createContainer(cfg);
const provider = new ComfyUIProvider(new ComfyProcess(c.runner, cfg.comfy), c.gate, { baseUrl: `http://${cfg.comfy.host}:${cfg.comfy.port}`, imageTimeoutMs: 600_000, matteModel: cfg.comfy.matteModel });
const A = "/Users/apple/Desktop/ai-studio-feasibility/projects/anim-lab";
const ids = process.argv.slice(2);
fs.mkdirSync(`${A}/mattes`, { recursive: true });
const t0 = Date.now();
const out = await provider.generateBatch(ids.map((id) => ({ id, task: "matte" as const, prompt: "", negativePrompt: "", width: 0, height: 0, seed: 0, outPath: `${A}/mattes/${id}.matte.png`, initImage: { path: `${A}/assets/${id}.png`, denoise: 1 } })));
console.log(`matted ${out.length} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const r of out) {
  const img = decodePng(fs.readFileSync(`${A}/assets/${r.id}.png`)), m = decodePng(fs.readFileSync(r.path));
  const cut = applyMatte(img, m);
  const rep = assessMatte(cut, r.id.startsWith("char") ? "character" : "prop");
  fs.writeFileSync(`${A}/mattes/${r.id}.cut.png`, encodePng(cropToContent(cut, 20, 2)));
  console.log(r.id.padEnd(22), `${(r.durationMs / 1000).toFixed(1)} s`, JSON.stringify(rep));
}
