#!/usr/bin/env python3
"""Minimal ComfyUI API client for the feasibility test (stdlib only).

Usage: comfy_run.py <label> <mode> <width> <height> <prefix> "<positive>" ["<negative>"] [seed]
  mode: "std"  -> Euler, 20 steps, cfg 7
        "lcm"  -> LCM-LoRA, 5 steps, cfg 1.5, lcm sampler
Prints one JSON line with timings (from the server's own execution timestamps) and the output path.
"""
import json, sys, time, urllib.request

BASE = "http://127.0.0.1:8188"
CKPT = "v1-5-pruned-emaonly-fp16.safetensors"
LORA = "lcm-lora-sdv1-5.safetensors"


def http(path, data=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(data).encode() if data is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def workflow(mode, w, h, prefix, pos, neg, seed):
    g = {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}}}
    model = ["1", 0]
    if mode == "lcm":
        g["2"] = {"class_type": "LoraLoader", "inputs": {"model": ["1", 0], "clip": ["1", 1], "lora_name": LORA,
                                                         "strength_model": 1.0, "strength_clip": 1.0}}
        g["3"] = {"class_type": "ModelSamplingDiscrete", "inputs": {"model": ["2", 0], "sampling": "lcm", "zsnr": False}}
        model, clip = ["3", 0], ["2", 1]
        steps, cfg, sampler, sched = 5, 1.5, "lcm", "sgm_uniform"
    else:
        clip = ["1", 1]
        steps, cfg, sampler, sched = 20, 7.0, "euler", "normal"
    g["4"] = {"class_type": "CLIPTextEncode", "inputs": {"text": pos, "clip": clip}}
    g["5"] = {"class_type": "CLIPTextEncode", "inputs": {"text": neg, "clip": clip}}
    g["6"] = {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}}
    g["7"] = {"class_type": "KSampler", "inputs": {"model": model, "positive": ["4", 0], "negative": ["5", 0],
                                                  "latent_image": ["6", 0], "seed": seed, "steps": steps, "cfg": cfg,
                                                  "sampler_name": sampler, "scheduler": sched, "denoise": 1.0}}
    g["8"] = {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["1", 2]}}
    g["9"] = {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": prefix}}
    return g, steps


def main():
    label, mode, w, h, prefix, pos = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6]
    neg = sys.argv[7] if len(sys.argv) > 7 else ""
    seed = int(sys.argv[8]) if len(sys.argv) > 8 else 12345
    g, steps = workflow(mode, w, h, prefix, pos, neg, seed)
    t_submit = time.time()
    pid = http("/prompt", {"prompt": g})["prompt_id"]
    while True:
        hist = http(f"/history/{pid}")
        if pid in hist and hist[pid].get("status", {}).get("completed") is not None:
            break
        if time.time() - t_submit > 1800:
            raise SystemExit("timeout waiting for ComfyUI")
        time.sleep(0.25)
    t_done = time.time()
    st = hist[pid]["status"]
    ts = {m[0]: m[1].get("timestamp") for m in st["messages"]}
    exec_s = (ts["execution_success"] - ts["execution_start"]) / 1000 if "execution_success" in ts and "execution_start" in ts else None
    outs = [f"{i['subfolder']}/{i['filename']}".lstrip("/") for n in hist[pid]["outputs"].values() for i in n.get("images", [])]
    print(json.dumps({"label": label, "mode": mode, "size": f"{w}x{h}", "steps": steps, "status": st["status_str"],
                      "server_exec_s": exec_s, "wall_s": round(t_done - t_submit, 2), "outputs": outs}))


main()
