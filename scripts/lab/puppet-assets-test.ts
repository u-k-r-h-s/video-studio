// Experiment: which character asset can be cut into a puppet reliably? A-pose single figures vs a two-view character sheet.
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
  baseUrl: `http://${cfg.comfy.host}:${cfg.comfy.port}`, imageTimeoutMs: 600_000, defaultModel: "ds8", matteModel: cfg.comfy.matteModel,
  models: { ds8: { id: "ds8", unet: "dreamshaper8_unet_fp16.safetensors", clip: "dreamshaper8_clip_fp16.safetensors", vae: "dreamshaper8_vae_fp16.safetensors", lora: cfg.comfy.lora } },
});
const OUT = "/Users/apple/Desktop/ai-studio-feasibility/projects/anim-lab/puppet";
const STYLE = "stylized 3D animated film character design, soft cinematic lighting, rich colours, clean shapes, highly detailed";
const NEG = "photo, blurry, low quality, text, watermark, deformed, ugly, extra limbs, cropped, cut off, multiple people, hands in pockets, arms crossed, holding anything";
const ID = "a young man with a round face, kind eyes and tousled brown hair, red jacket, white lighthouse keeper's cap, dark trousers, brown boots";
const GREY = "plain flat light grey studio background, nothing else in the picture";
const req = (id: string, prompt: string, seed: number, w = 512, h = 896): ImageRequest => ({ id, prompt, negativePrompt: NEG, width: w, height: h, seed, outPath: `${OUT}/${id}.png`, maxAttempts: 1, steps: 8, cfg: 2.6 });
const reqs: ImageRequest[] = [];
for (const s of [501, 502]) reqs.push(req(`apose34-${s}`, `${STYLE}, full body shot of ${ID}, three-quarter view turned toward the left, standing in a relaxed A-pose, arms held slightly away from the body, open hands, legs slightly apart, ${GREY}`, s));
for (const s of [501, 502]) reqs.push(req(`apose-front-${s}`, `${STYLE}, full body shot of ${ID}, front view, standing in a relaxed A-pose, arms held slightly away from the body, open hands, legs slightly apart, ${GREY}`, s));
for (const s of [601, 602, 603]) reqs.push(req(`sheet-${s}`, `${STYLE}, character turnaround reference sheet of the same character shown twice side by side, left: front view, right: side view in profile, full body, both standing in a relaxed A-pose, ${ID}, ${GREY}`, s, 768, 896));
for (const r of [...reqs]) reqs.push({ id: `${r.id}~m`, task: "matte", prompt: "", negativePrompt: "", width: 0, height: 0, seed: 0, outPath: `${OUT}/${r.id}-matte.png`, initImage: { path: r.outPath, denoise: 1 } });
const t0 = Date.now();
const out = await provider.generateBatch(reqs, { logFile: "/tmp/lab3/comfy.log" });
console.log(`generated ${out.length} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
