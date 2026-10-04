import sys, time
sys.path.insert(0, ".")
t0 = time.time()
import torch, comfy.sd, comfy.model_management as mm
t_import = time.time() - t0
t1 = time.time()
out = comfy.sd.load_checkpoint_guess_config("models/checkpoints/v1-5-pruned-emaonly-fp16.safetensors", output_vae=True, output_clip=True, embedding_directory=None)
t_load = time.time() - t1
print(f"python+comfy import: {t_import:.1f}s | checkpoint load (disk -> CPU weights, page-cache warm): {t_load:.2f}s")
