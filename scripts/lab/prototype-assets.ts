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
const reqs: ImageRequest[] = [
  img("k1-phone", "close-up of a hand holding a glowing smartphone in the dark, cold screen light on the fingers, blurred night street background, no text", 11),
  img("k2-alley-wide", `${ALLEY}, wide establishing shot, a lone delivery rider standing small in the distance next to a parked scooter, long shadows`, 22),
  img("k3-building", "abandoned concrete apartment building at night, low angle looking up, dark broken windows, one flickering warm light in the lobby doorway, wet street in front, ominous", 33),
  img("k4-rider-uneasy", `close-up portrait of a ${HERO}, uneasy worried expression, looking up, blurred night alley background with warm lantern bokeh`, 44),
  img("k6-lobby-elevator", "dim abandoned lobby, dusty marble floor, a single old elevator with metal doors sliding open by themselves, warm yellow light spilling out onto the floor, low angle, ominous, no people", 66),
  img("k7-elevator-inside", `inside a small old elevator with warm yellow light, a man in an orange jacket with black stripes standing with his back to the camera, medium shot, unsettling`, 77),
];
// reaction + double: img2img from the hero portrait so the identity carries over
reqs.push(
  { ...img("k5-rider-shock", `close-up portrait of a ${HERO}, eyes wide open, shocked terrified expression, mouth slightly open, blurred night alley background, cold light`, 55), initImage: { path: `${OUT}/k4-rider-uneasy.png`, denoise: 0.55 } },
  { ...img("k8-double-smile", `close-up portrait of a ${HERO}, an eerie calm smile, cold unblinking eyes, inside an old elevator with warm yellow light, ominous`, 88), initImage: { path: `${OUT}/k4-rider-uneasy.png`, denoise: 0.6 } },
);
const t0 = Date.now();
const out = await provider.generateBatch(reqs, { logFile: "/tmp/lab2/comfy-proto.log" });
console.log(`generated ${out.length} images in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const r of out) console.log(r.id.padEnd(22), `${(r.durationMs / 1000).toFixed(1)} s`);
