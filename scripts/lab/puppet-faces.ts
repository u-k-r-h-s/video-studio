// Face variants for a lab puppet: img2img of the head crop (low denoise, so the identity holds), then a matte.
import fs from "node:fs";
import { loadConfig } from "../../apps/server/src/config";
import { createContainer } from "../../apps/server/src/container";
import { ComfyUIProvider } from "../../apps/server/src/providers/image/ComfyUIProvider";
import { ComfyProcess } from "../../apps/server/src/providers/image/ComfyProcess";
import { setLogQuiet } from "../../apps/server/src/lib/logger";
import { makeCutout, makeHeadCrop, readRgba } from "../../apps/server/src/anim/assets";
import { buildPuppet, puppetHeadCrop } from "../../apps/server/src/anim/puppet";
import { applyMatte } from "../../apps/server/src/lib/matte";
import { encodePng } from "../../apps/server/src/lib/png";
import type { ImageRequest } from "../../apps/server/src/providers/image/ImageProvider";

setLogQuiet(true);
const CH = process.argv[2] ?? "mq-keeper-d0.78-s702";
const P = "/Users/apple/Desktop/ai-studio-feasibility/projects/anim-lab/puppet";
const cfg = loadConfig({}, "/Users/apple/Desktop/ai-studio-feasibility");
const c = createContainer(cfg);
const provider = new ComfyUIProvider(new ComfyProcess(c.runner, cfg.comfy), c.gate, {
  baseUrl: `http://${cfg.comfy.host}:${cfg.comfy.port}`, imageTimeoutMs: 600_000, defaultModel: "ds8", matteModel: cfg.comfy.matteModel,
  models: { ds8: { id: "ds8", unet: "dreamshaper8_unet_fp16.safetensors", clip: "dreamshaper8_clip_fp16.safetensors", vae: "dreamshaper8_vae_fp16.safetensors", lora: cfg.comfy.lora } },
});
const { cut, box } = makeCutout(await readRgba(`${P}/${CH}.png`), await readRgba(`${P}/${CH}-matte.png`), true);
const pup = await buildPuppet("x", cut, { box });
const { png } = await makeHeadCrop(cut, puppetHeadCrop(pup));
fs.writeFileSync(`${P}/${CH}-headcrop.png`, png);
const STYLE = "stylized 3D animated film character design, soft cinematic lighting, highly detailed";
const ID = "a young man with tousled brown hair, red cap, red jacket";
const V: Record<string, [string, number]> = {
  surprised: ["gasping in shock, mouth wide open, eyes wide open, eyebrows raised high", 0.55],
  worried: ["scared worried expression, eyebrows raised and pulled together, mouth slightly open", 0.52],
  smile: ["warm smile, happy eyes", 0.48],
};
const reqs: ImageRequest[] = [];
for (const [k, [w, d]] of Object.entries(V)) {
  reqs.push({ id: `face-${k}`, prompt: `${STYLE}, close portrait of ${ID}, ${w}, plain light grey background`, negativePrompt: "blurry, deformed, text", width: 512, height: 512, seed: 811, outPath: `${P}/${CH}-faceraw-${k}.png`, maxAttempts: 1, steps: 8, cfg: 3.2, initImage: { path: `${P}/${CH}-headcrop.png`, denoise: d } });
}
await provider.generateBatch(reqs, { logFile: "/tmp/lab3/comfy-faces.log" });
// the face ellipse is drawn over the head, so no matte is needed: keep the full square (opaque) and let the ellipse cut it
for (const k of Object.keys(V)) fs.copyFileSync(`${P}/${CH}-faceraw-${k}.png`, `${P}/${CH}-face-${k}.png`);
void applyMatte; void encodePng;
console.log("faces done");
