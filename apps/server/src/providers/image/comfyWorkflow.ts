/**
 * The exact ComfyUI graph proven in the hardware feasibility test (scripts/comfy_run.py, mode "lcm"):
 * SD 1.5 fp16 + LCM-LoRA, 5 steps, cfg 1.5, lcm sampler, sgm_uniform scheduler.
 * Output goes through PreviewImage (ComfyUI's temp dir, fetched via /view) so ComfyUI's output folder never fills up.
 * This is the ONLY place that knows node ids/class names; replacing the workflow does not touch the rest of the app.
 */
export interface WorkflowParams {
  checkpoint: string;
  lora: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  seed: number;
  steps?: number;
  cfg?: number;
}

export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export const OUTPUT_NODE_ID = "9";

export function buildLcmWorkflow(p: WorkflowParams): ComfyGraph {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.checkpoint } },
    "2": { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["1", 1], lora_name: p.lora, strength_model: 1.0, strength_clip: 1.0 } },
    "3": { class_type: "ModelSamplingDiscrete", inputs: { model: ["2", 0], sampling: "lcm", zsnr: false } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: p.prompt, clip: ["2", 1] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: p.negativePrompt, clip: ["2", 1] } },
    "6": { class_type: "EmptyLatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } },
    "7": {
      class_type: "KSampler",
      inputs: {
        model: ["3", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], seed: p.seed,
        steps: p.steps ?? 5, cfg: p.cfg ?? 1.5, sampler_name: "lcm", scheduler: "sgm_uniform", denoise: 1.0,
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["1", 2] } },
    [OUTPUT_NODE_ID]: { class_type: "PreviewImage", inputs: { images: ["8", 0] } },
  };
}
