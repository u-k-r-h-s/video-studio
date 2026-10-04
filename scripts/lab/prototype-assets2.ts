// Prototype key visuals for "The Last Delivery" (hand-authored prompts; the director will later write these).
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
const OUT = "/Users/apple/Desktop/ai-studio-feasibility/projects/proto-last-delivery/images";
const STYLE = "cinematic still from a stylized 3D animated film, dramatic lighting, volumetric haze, rich colour grading, shallow depth of field, highly detailed";
const NEG = "photo, blurry, low quality, text, watermark, deformed, ugly, extra limbs, cartoon flat, clip art, cropped";
const HERO = "young delivery rider with short dark hair, orange jacket with black stripes, delivery backpack";
const ALLEY = "narrow old city alley at night, wet pavement reflecting warm lantern light, cool blue ambient haze, aged brick walls";
const img = (id: string, prompt: string, seed: number, extra: Partial<ImageRequest> = {}): ImageRequest =>
  ({ id, prompt: `${STYLE}, ${prompt}`, negativePrompt: NEG, width: 512, height: 896, seed, outPath: `${OUT}/${id}.png`, maxAttempts: 1, steps: 6, cfg: 1.8, ...extra });
// Second pass: the first pass drew a corridor instead of the building exterior and hands without a visible phone.
const alt = (id: string, prompt: string, seed: number): ImageRequest => img(`${id}-v${seed}`, prompt, seed);
const reqs: ImageRequest[] = [
  alt("k3-building", "exterior of a tall dark apartment block seen from the street at night, rows of dark windows, one yellow lit window high up, mist, wet street, ominous, wide shot", 34),
  alt("k3-building", "exterior of a tall dark apartment block seen from the street at night, rows of dark windows, one yellow lit window high up, mist, wet street, ominous, wide shot", 35),
  alt("k1-phone", "close-up of hands holding a smartphone with a bright glowing screen, cold blue light on the fingers, dark background", 12),
  alt("k1-phone", "close-up of hands holding a smartphone with a bright glowing screen, cold blue light on the fingers, dark background", 13),
];
const t0 = Date.now();
const out = await provider.generateBatch(reqs, { logFile: "/tmp/lab2/comfy-proto2.log" });
console.log(`generated ${out.length} images in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
