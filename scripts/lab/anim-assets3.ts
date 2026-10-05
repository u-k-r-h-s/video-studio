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
const HERO3 = "young delivery rider with short dark hair, red jacket with white stripes, navy blue trousers, tan brown boots";
const reqs: ImageRequest[] = [
  ...[301, 302, 303, 304].map((s) => img(`char-rider-n${s}`, `${ISO}, full body shot of a ${HERO3}, standing, legs apart, arms relaxed, facing slightly to the left, no bags, ${GREY}`, s)),
  img("prop-hand-phone-n", `${ISO}, a hand holding a smartphone with a bright glowing screen, close view, ${GREY}`, 311),
  img("prop-car-n", `${ISO}, side view of a dark blue sedan car with glowing headlights, ${GREY}`, 321, { width: 768, height: 512 }),
  img("prop-lamp-n", `${ISO}, a single tall old black iron street lamp post with a glowing lantern on top, full height, ${GREY}`, 331),
  img("prop-door-n", `${ISO}, front view of a heavy dark wooden apartment door in a stone frame, full height, ${GREY}`, 341),
];
const t0 = Date.now();
const out = await provider.generateBatch(reqs, { logFile: "/tmp/lab2/comfy-anim.log" });
console.log(`generated ${out.length} images in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const r of out) console.log(r.id.padEnd(22), `${(r.durationMs / 1000).toFixed(1)} s`);
