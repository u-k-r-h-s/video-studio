// AI-painted plates for the 3D test set (hybrid 2.5D): a far background and a wall texture, generated locally with ComfyUI.
import { loadConfig } from "../../../apps/server/src/config";
import { createContainer } from "../../../apps/server/src/container";
import { ComfyUIProvider } from "../../../apps/server/src/providers/image/ComfyUIProvider";
import { ComfyProcess } from "../../../apps/server/src/providers/image/ComfyProcess";
import { setLogQuiet } from "../../../apps/server/src/lib/logger";
setLogQuiet(true);
const ROOT = "/Users/apple/Desktop/ai-studio-feasibility", OUT = `${ROOT}/assets/3d/plates`;
const cfg = loadConfig({}, ROOT);
const c = createContainer(cfg);
const p = new ComfyUIProvider(new ComfyProcess(c.runner, cfg.comfy), c.gate, {
  baseUrl: `http://${cfg.comfy.host}:${cfg.comfy.port}`, imageTimeoutMs: 600_000, defaultModel: "ds8",
  models: { ds8: { id: "ds8", unet: "dreamshaper8_unet_fp16.safetensors", clip: "dreamshaper8_clip_fp16.safetensors", vae: "dreamshaper8_vae_fp16.safetensors", lora: cfg.comfy.lora } },
});
const NEG = "people, person, figure, animal, car, text, sign, watermark, blurry, low quality";
await p.generateBatch([
  { id: "plate", prompt: "cinematic matte painting, wide panorama of an abandoned industrial district at night, distant warehouses, cranes and chimneys as dark silhouettes against a stormy sky, moonlit clouds, faint orange city glow on the horizon, rain haze, moody, highly detailed", negativePrompt: NEG, width: 1024, height: 448, seed: 31, outPath: `${OUT}/warehouse-night.png`, maxAttempts: 1, steps: 8, cfg: 2.2 },
  { id: "wall", prompt: "texture photo of a weathered corrugated metal warehouse wall, vertical ribs, rust streaks and grime, front view, flat even lighting, seamless", negativePrompt: `${NEG}, door, window, perspective`, width: 512, height: 512, seed: 32, outPath: `${OUT}/corrugated-wall.png`, maxAttempts: 1, steps: 8, cfg: 2.2 },
], { logFile: "/tmp/plates.log" });
console.log("plates done");
