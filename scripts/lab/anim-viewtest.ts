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
const OUT = "/Users/apple/Desktop/ai-studio-feasibility/projects/anim-lab/assets";
const STYLE = "cinematic still from a stylized 3D animated film, dramatic lighting, volumetric haze, rich colour grading, shallow depth of field, highly detailed";
const NEG = "photo, blurry, low quality, text, watermark, deformed, ugly, extra limbs, cartoon flat, clip art, cropped";
const HERO = "young delivery rider with short dark hair, orange jacket with black stripes, delivery backpack";
const ALLEY = "narrow old city alley at night, wet pavement reflecting warm lantern light, cool blue ambient haze, aged brick walls";
const img = (id: string, prompt: string, seed: number, extra: Partial<ImageRequest> = {}): ImageRequest =>
  ({ id, prompt, negativePrompt: NEG, width: 512, height: 896, seed, outPath: `${OUT}/${id}.png`, maxAttempts: 1, steps: 6, cfg: 1.8, ...extra });
// Assets for the animation engine: CUT-OUT characters/props on a flat background (keyed later) and people-free wide backgrounds.
const ISO = "stylized 3D animated film render, soft even lighting, highly detailed";
const PLAIN = "standing on a plain flat light grey background, nothing else in the picture";
const HERO2 = "young delivery rider with short dark hair, red jacket with white stripes, dark trousers, black boots, orange delivery backpack";
const GREY = "plain flat light grey studio background, nothing else in the picture";
const ID = "young woman with short black bob hair, dark navy denim jacket over a grey t-shirt, dark blue jeans, dark red boots";
const VIEW: Record<string, string> = {
  "three-quarter": "in three-quarter view turned toward the left, standing, legs apart, arms relaxed",
  side: "seen exactly from the side in profile facing left, walking, mid-stride, legs well apart",
  back: "seen from behind with the back to the camera, standing, legs apart, arms relaxed",
};
const reqs: ImageRequest[] = [];
for (const [v, words] of Object.entries(VIEW)) {
  for (const d of [0.7, 0.85]) reqs.push({ ...img(`viewtest-${v}-i${d}`, `${ISO}, full body shot of ${ID}, ${words}, ${GREY}`, 77), steps: 8, cfg: 2.2, initImage: { path: `${OUT}/char-rider-d402.png`, denoise: d } });
}
const t0 = Date.now();
const out = await provider.generateBatch(reqs, { logFile: "/tmp/lab2/comfy-anim.log" });
console.log(`generated ${out.length} images in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const r of out) console.log(r.id.padEnd(22), `${(r.durationMs / 1000).toFixed(1)} s`);
