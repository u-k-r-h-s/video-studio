// Draws expression / look variants of a character's head with img2img on the head crop (high detail: the head fills a 512 canvas).
//   npx tsx scripts/lab/anim-heads.ts <character-id>
import fs from "node:fs";
import { loadConfig } from "../../apps/server/src/config";
import { createContainer } from "../../apps/server/src/container";
import { ComfyUIProvider } from "../../apps/server/src/providers/image/ComfyUIProvider";
import { ComfyProcess } from "../../apps/server/src/providers/image/ComfyProcess";
import { setLogQuiet } from "../../apps/server/src/lib/logger";
import type { ImageRequest } from "../../apps/server/src/providers/image/ImageProvider";

setLogQuiet(true);
const cfg = loadConfig({}, "/Users/apple/Desktop/ai-studio-feasibility");
const c = createContainer(cfg);
const provider = new ComfyUIProvider(new ComfyProcess(c.runner, cfg.comfy), c.gate, {
  baseUrl: `http://${cfg.comfy.host}:${cfg.comfy.port}`, imageTimeoutMs: 600_000, defaultModel: "ds8",
  models: { ds8: { id: "ds8", unet: "dreamshaper8_unet_fp16.safetensors", clip: "dreamshaper8_clip_fp16.safetensors", vae: "dreamshaper8_vae_fp16.safetensors", lora: cfg.comfy.lora } },
});
const A = "/Users/apple/Desktop/ai-studio-feasibility/projects/anim-lab";
const id = process.argv[2]!;
const who = process.argv[3] ?? "young woman with short black bob hair, dark navy denim jacket";
fs.mkdirSync(`${A}/heads`, { recursive: true });
const NEG = "photo, blurry, low quality, text, watermark, deformed, ugly, extra limbs, cropped";
const base = `stylized 3D animated film render, close portrait of a ${who}, plain flat light grey studio background, soft even lighting, highly detailed`;
const V: [string, string, number][] = [
  ["front", "looking straight into the camera, calm neutral expression", 0.5],
  ["lookL", "head turned to the left, eyes looking to the left", 0.62],
  ["lookR", "head turned to the right, eyes looking to the right", 0.62],
  ["surprised", "shocked wide open eyes, mouth open in surprise, raised eyebrows", 0.55],
  ["smile", "a gentle knowing smile, relaxed eyes", 0.5],
  ["worried", "frightened worried eyes, eyebrows raised and drawn together", 0.55],
  ["angry", "angry frowning eyebrows, tense jaw", 0.55],
];
const reqs: ImageRequest[] = V.map(([name, look, denoise], i) => ({
  id: `head-${name}`, prompt: `${base}, ${look}`, negativePrompt: NEG, width: 512, height: 512, seed: 700 + i, outPath: `${A}/heads/${id}-${name}.png`,
  maxAttempts: 1, steps: 6, cfg: 1.8, initImage: { path: `${A}/cutouts/${id}.headcrop.png`, denoise },
}));
const t0 = Date.now();
const out = await provider.generateBatch(reqs, { logFile: "/tmp/lab2/comfy-heads.log" });
console.log(`generated ${out.length} head variants in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
