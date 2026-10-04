// Visual lab: compare image models/recipes on cinematic prompts through the real ComfyUIProvider.
// Run: node_modules/.bin/tsx scripts/lab/checkpoint-compare.ts   (needs Ollama unloaded; starts/stops ComfyUI itself)
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
  baseUrl: `http://${cfg.comfy.host}:${cfg.comfy.port}`, imageTimeoutMs: 600_000,
  models: {
    sd15: { id: "sd15", checkpoint: cfg.comfy.checkpoint, lora: cfg.comfy.lora },
    ds8: { id: "ds8", unet: "dreamshaper8_unet_fp16.safetensors", clip: "dreamshaper8_clip_fp16.safetensors", vae: "dreamshaper8_vae_fp16.safetensors", lora: cfg.comfy.lora },
    ds8plain: { id: "ds8plain", unet: "dreamshaper8_unet_fp16.safetensors", clip: "dreamshaper8_clip_fp16.safetensors", vae: "dreamshaper8_vae_fp16.safetensors" },
  },
});

const STYLE = "cinematic still from a stylized 3D animated film, dramatic lighting, volumetric haze, rich colour grading, shallow depth of field, highly detailed";
const NEG = "photo, blurry, low quality, text, watermark, deformed, ugly, extra limbs, cartoon flat, clip art";
const prompts: Record<string, string> = {
  env: `${STYLE}, narrow old city alley at night, wet pavement reflecting warm shop lights, cool blue ambient light, aged brick buildings, small shop signs, no people, wide shot`,
  hero: `${STYLE}, young delivery rider with short dark hair, orange jacket with reflective stripes, delivery backpack, standing in a narrow alley at night, shocked expression, medium shot`,
  eyes: `${STYLE}, extreme close-up of a young man's eyes widening in fear, reflection of a phone screen glow in his eyes, dark background`,
};
const variants: Record<string, Partial<ImageRequest> & { only?: string[] }> = {
  A_sd15_lcm5: { model: "sd15", steps: 5, cfg: 1.5 },
  B_ds8_lcm6: { model: "ds8", steps: 6, cfg: 1.8 },
  C_ds8_classic20: { model: "ds8plain", steps: 20, cfg: 6.5, sampler: "dpmpp_2m", scheduler: "karras", only: ["hero"] },
};
const reqs: ImageRequest[] = [];
for (const [vn, v] of Object.entries(variants)) for (const [pn, pr] of Object.entries(prompts)) {
  if (v.only && !v.only.includes(pn)) continue;
  const { only: _o, ...rest } = v;
  reqs.push({ id: `${vn}-${pn}`, prompt: pr, negativePrompt: NEG, width: 512, height: 896, seed: 777, outPath: `/tmp/lab2/${vn}-${pn}.png`, maxAttempts: 1, ...rest });
}
const t0 = Date.now();
const out = await provider.generateBatch(reqs, { logFile: "/tmp/lab2/comfy.log" });
console.log(`generated ${out.length} images in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const r of out) console.log(r.id.padEnd(22), `${(r.durationMs / 1000).toFixed(1)} s`);
