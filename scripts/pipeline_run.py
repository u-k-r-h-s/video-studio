#!/usr/bin/env python3
"""Test 4: run the intended sequential pipeline once, one heavy model resident at a time.
Writes stage labels to results/stage.txt (read by memmon.py) and per-stage wall times to results/t4_stages.json.
Run with any python3 (stdlib only), from the feasibility folder.
"""
import json, os, signal, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
STAGE = "results/stage.txt"
timings = []


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def stage(name):
    open(STAGE, "w").write(name)
    return time.time()


def done(name, t0, **extra):
    d = {"stage": name, "wall_s": round(time.time() - t0, 1), **extra}
    timings.append(d)
    print(json.dumps(d, ensure_ascii=False), flush=True)


def http(url, data=None, timeout=600):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def ollama_loaded():
    return [m["name"] for m in http("http://127.0.0.1:11434/api/ps", timeout=10)["models"]]


# ---- 1. Ollama: a real structured scene-plan call -------------------------------------------------------------
t = stage("t4-1-ollama")
prompt = ("Plan a 3-scene, 15-second comic short: an old detective catches a thief stealing food from a village shop. "
          'Return JSON {"title": str, "scenes": [{"location": str, "action": str, "dialogue": [{"character": str, "text": str}]}]}')
r = http("http://127.0.0.1:11434/api/chat", {"model": "llama3.2", "stream": False, "format": "json",
                                             "messages": [{"role": "user", "content": prompt}], "options": {"temperature": 0.7}})
plan = json.loads(r["message"]["content"])
done("1 ollama scene-plan call", t, scenes=len(plan.get("scenes", [])), eval_tokens=r.get("eval_count"),
     load_s=round(r.get("load_duration", 0) / 1e9, 1), gen_s=round(r.get("eval_duration", 0) / 1e9, 1), loaded_after=ollama_loaded())

# ---- 2. Unload Ollama and verify ------------------------------------------------------------------------------
t = stage("t4-2-ollama-unload")
http("http://127.0.0.1:11434/api/generate", {"model": "llama3.2", "keep_alive": 0}, timeout=30)
time.sleep(3)
left = sh(["pgrep", "-f", "llama-server"]).stdout.split()
done("2 ollama unload", t, models_loaded=ollama_loaded(), llama_server_processes=len(left))

# ---- 3. ComfyUI: start, generate one image (LCM), stop ------------------------------------------------------
t = stage("t4-3a-comfy-start")
log = open("results/t4_comfy_server.log", "w")
env = dict(os.environ, PYTORCH_ENABLE_MPS_FALLBACK="1")
srv = subprocess.Popen(["venv-comfy/bin/python", "comfyui/main.py", "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch", "--offline"],
                       stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
while True:
    try:
        http("http://127.0.0.1:8188/system_stats", timeout=2)
        break
    except Exception:
        time.sleep(0.5)
done("3a comfyui start", t)

t = stage("t4-3b-comfy-generate")
POS = ("flat colour comic book illustration, bold black ink outlines, cozy village grocery shop interior at night, wooden shelves "
       "with fruit baskets and glass jars, warm lamp light, simple clean background, vertical composition, no people")
NEG = "photo, photorealistic, blurry, text, watermark, signature, deformed, people, person, ugly"
out = sh(["venv-comfy/bin/python", "scripts/comfy_run.py", "t4-gen", "lcm", "512", "896", "t4_bg", POS, NEG, "99"]).stdout.strip().splitlines()[-1]
res = json.loads(out)
done("3b comfyui generate (LCM 5 steps, 512x896, cold model load included)", t, server_exec_s=res["server_exec_s"], status=res["status"])

t = stage("t4-3c-comfy-stop")
try:
    http("http://127.0.0.1:8188/free", {"unload_models": True, "free_memory": True}, timeout=30)  # ComfyUI's own free-memory endpoint
except Exception as e:
    print("free endpoint:", e)
os.killpg(srv.pid, signal.SIGTERM)
srv.wait(timeout=30)
time.sleep(2)
alive = bool(sh(["pgrep", "-f", "comfyui/main.py"]).stdout.strip())
done("3c comfyui free + stop", t, process_still_running=alive)

# ---- 4. Piper: three clips through the CLI -------------------------------------------------------------------
t = stage("t4-4-piper")
clips = [("en_US-libritts_r-medium", "Someone has been sneaking into the shop every night."),
         ("en_US-libritts_r-medium", "Tonight, the old detective will finally catch the thief."),
         ("hi_IN-rohan-medium", "कोई हर रात चुपके से दुकान में घुस रहा है।")]
per = []
for i, (voice, text) in enumerate(clips):
    t1 = time.time()
    sh(["venv-piper/bin/python", "-m", "piper", "-m", f"piper-voices/{voice}.onnx", "-f", f"results/audio/t4_clip{i}.wav", "--", text])
    per.append(round(time.time() - t1, 2))
done("4 piper (3 clips, separate CLI process each)", t, per_clip_s=per)

# ---- 5. FFmpeg render (VideoToolbox) --------------------------------------------------------------------------
t = stage("t4-5-ffmpeg")
r = sh(["bash", "scripts/render.sh", "vt", "results/video/t4_final.mp4"])
done("5 ffmpeg 1080x1920 render (h264_videotoolbox)", t, ok=os.path.exists("results/video/t4_final.mp4") and r.returncode == 0)

stage("t4-6-idle")
json.dump(timings, open("results/t4_stages.json", "w"), ensure_ascii=False, indent=1)
print("total pipeline wall time: %.0f s" % sum(x["wall_s"] for x in timings))
