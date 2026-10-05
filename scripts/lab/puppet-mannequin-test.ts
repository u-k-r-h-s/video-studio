// Experiment: img2img from a procedural A-pose mannequin -> does the character keep the pose (arms clear of the body)?
import fs from "node:fs";
import { loadConfig } from "../../apps/server/src/config";
import { createContainer } from "../../apps/server/src/container";
import { ComfyUIProvider } from "../../apps/server/src/providers/image/ComfyUIProvider";
import { ComfyProcess } from "../../apps/server/src/providers/image/ComfyProcess";
import { setLogQuiet } from "../../apps/server/src/lib/logger";
import { mannequinPng } from "../../apps/server/src/anim/mannequin";
import type { ImageRequest } from "../../apps/server/src/providers/image/ImageProvider";

setLogQuiet(true);
const cfg = loadConfig({}, "/Users/apple/Desktop/ai-studio-feasibility");
const c = createContainer(cfg);
const provider = new ComfyUIProvider(new ComfyProcess(c.runner, cfg.comfy), c.gate, {
  baseUrl: `http://${cfg.comfy.host}:${cfg.comfy.port}`, imageTimeoutMs: 600_000, defaultModel: "ds8", matteModel: cfg.comfy.matteModel,
  models: { ds8: { id: "ds8", unet: "dreamshaper8_unet_fp16.safetensors", clip: "dreamshaper8_clip_fp16.safetensors", vae: "dreamshaper8_vae_fp16.safetensors", lora: cfg.comfy.lora } },
});
const OUT = "/Users/apple/Desktop/ai-studio-feasibility/projects/anim-lab/puppet";
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/mannequin.png`, mannequinPng());
const STYLE = "stylized 3D animated film character design, soft cinematic lighting, rich colours, clean shapes, highly detailed";
const NEG = "photo, blurry, low quality, text, watermark, deformed, ugly, extra limbs, cropped, cut off, multiple people, hands in pockets, holding anything, mannequin, statue, grey skin";
const ID = process.argv[2] ?? "a young man with a round face, kind eyes and tousled brown hair, red jacket, white lighthouse keeper's cap, dark trousers, brown boots";
const tag = process.argv[3] ?? "keeper";
const GREY = "plain flat light grey studio background, nothing else in the picture";
const reqs: ImageRequest[] = [];
for (const d of [0.68, 0.78, 0.86]) for (const s of [701, 702]) {
  const id = `mq-${tag}-d${d}-s${s}`;
  reqs.push({ id, prompt: `${STYLE}, full body shot of ${ID}, three-quarter view, standing with arms held away from the body, legs apart, ${GREY}`, negativePrompt: NEG, width: 512, height: 896, seed: s, outPath: `${OUT}/${id}.png`, maxAttempts: 1, steps: 8, cfg: 2.6, initImage: { path: `${OUT}/mannequin.png`, denoise: d } });
}
for (const r of [...reqs]) reqs.push({ id: `${r.id}~m`, task: "matte", prompt: "", negativePrompt: "", width: 0, height: 0, seed: 0, outPath: `${OUT}/${r.id}-matte.png`, initImage: { path: r.outPath, denoise: 1 } });
const t0 = Date.now();
const out = await provider.generateBatch(reqs, { logFile: "/tmp/lab3/comfy.log" });
console.log(`generated ${out.length} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
