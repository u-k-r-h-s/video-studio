/**
 * ComfyUI graphs. This file is the ONLY place that knows node ids / class names; swapping the workflow never touches
 * the rest of the app. Supported recipes: txt2img and img2img, one-file checkpoints or split components
 * (UNet / text encoder / VAE exported separately), with or without an LCM-LoRA.
 *
 * Output goes through PreviewImage (ComfyUI's temp dir, fetched via /view) so ComfyUI's output folder never fills up.
 */
export interface ModelSpec {
  id: string;
  /** one-file checkpoint (models/checkpoints) ... */
  checkpoint?: string;
  /** ... or split components (models/diffusion_models, text_encoders, vae). */
  unet?: string;
  clip?: string;
  vae?: string;
  /** LCM-LoRA (models/loras). Presence switches the sampler to LCM defaults. */
  lora?: string;
}

export interface WorkflowParams {
  model: ModelSpec;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  seed: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  /** img2img: an image already uploaded to ComfyUI's input folder. Output size = the init image size. */
  init?: { imageName: string; denoise: number };
}

export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
type Ref = [string, number];

export const OUTPUT_NODE_ID = "9";

export function buildWorkflow(p: WorkflowParams): ComfyGraph {
  const g: ComfyGraph = {};
  const lcm = !!p.model.lora;
  let model: Ref;
  let clip: Ref;
  let vae: Ref;

  if (p.model.checkpoint) {
    g["1"] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.model.checkpoint } };
    model = ["1", 0];
    clip = ["1", 1];
    vae = ["1", 2];
    if (lcm) {
      g["2"] = { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["1", 1], lora_name: p.model.lora, strength_model: 1.0, strength_clip: 1.0 } };
      model = ["2", 0];
      clip = ["2", 1];
    }
  } else {
    if (!p.model.unet || !p.model.clip || !p.model.vae) throw new Error(`model "${p.model.id}" needs a checkpoint or unet+clip+vae`);
    g["1"] = { class_type: "UNETLoader", inputs: { unet_name: p.model.unet, weight_dtype: "default" } };
    g["12"] = { class_type: "CLIPLoader", inputs: { clip_name: p.model.clip, type: "stable_diffusion" } };
    g["13"] = { class_type: "VAELoader", inputs: { vae_name: p.model.vae } };
    model = ["1", 0];
    clip = ["12", 0];
    vae = ["13", 0];
    if (lcm) {
      g["2"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: p.model.lora, strength_model: 1.0 } };
      model = ["2", 0];
    }
  }
  if (lcm) {
    g["3"] = { class_type: "ModelSamplingDiscrete", inputs: { model, sampling: "lcm", zsnr: false } };
    model = ["3", 0];
  }

  g["4"] = { class_type: "CLIPTextEncode", inputs: { text: p.prompt, clip } };
  g["5"] = { class_type: "CLIPTextEncode", inputs: { text: p.negativePrompt, clip } };
  let latent: Ref;
  if (p.init) {
    g["10"] = { class_type: "LoadImage", inputs: { image: p.init.imageName } };
    g["11"] = { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae } };
    latent = ["11", 0];
  } else {
    g["6"] = { class_type: "EmptyLatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } };
    latent = ["6", 0];
  }
  g["7"] = {
    class_type: "KSampler",
    inputs: {
      model, positive: ["4", 0], negative: ["5", 0], latent_image: latent, seed: p.seed,
      steps: p.steps ?? (lcm ? 5 : 20), cfg: p.cfg ?? (lcm ? 1.5 : 7), sampler_name: p.sampler ?? (lcm ? "lcm" : "euler"),
      scheduler: p.scheduler ?? (lcm ? "sgm_uniform" : "normal"), denoise: p.init?.denoise ?? 1.0,
    },
  };
  g["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae } };
  g[OUTPUT_NODE_ID] = { class_type: "PreviewImage", inputs: { images: ["8", 0] } };
  return g;
}

/** Back-compat helper: the original SD 1.5 + LCM-LoRA recipe measured in the feasibility test. */
export function buildLcmWorkflow(p: { checkpoint: string; lora: string; prompt: string; negativePrompt: string; width: number; height: number; seed: number; steps?: number; cfg?: number }): ComfyGraph {
  return buildWorkflow({ model: { id: "sd15", checkpoint: p.checkpoint, lora: p.lora }, ...p });
}

/**
 * Foreground matte with ComfyUI's built-in BiRefNet "Remove Background" node. The graph returns the mask as a grey image
 * (white = foreground) through the same PreviewImage output, so the provider fetches it like any other result.
 */
export function buildMatteWorkflow(p: { imageName: string; modelFile: string }): ComfyGraph {
  return {
    "1": { class_type: "LoadImage", inputs: { image: p.imageName } },
    "2": { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: p.modelFile } },
    "3": { class_type: "RemoveBackground", inputs: { bg_removal_model: ["2", 0], image: ["1", 0] } },
    "4": { class_type: "MaskToImage", inputs: { mask: ["3", 0] } },
    [OUTPUT_NODE_ID]: { class_type: "PreviewImage", inputs: { images: ["4", 0] } },
  };
}
