#!/usr/bin/env python3
"""Measures what can be measured about a finished short's audio (nobody here can LISTEN; these are proxies, not a verdict):
loudness / true peak / clipping, silence, per-line intelligibility (Whisper transcribes the final mix at each line's slot and is
compared with the script), whether a voice starts where the timeline says, and whether each implied sound cue (footstep, door,
glow ping, impact) has an audible transient at its time.   TEST-ONLY tooling: run with venv-asr-testonly.
  python3 scripts/audio_check.py <video.mp4> <audio-plan.json>
"""
import difflib, json, re, subprocess, sys, unicodedata
import numpy as np

video, plan_file = sys.argv[1], sys.argv[2]
plan = json.load(open(plan_file))
SR = 16000
pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-ar", str(SR), "-ac", "1", "-f", "s16le", "-"], capture_output=True).stdout
x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
dur = len(x) / SR
out = {"video": video, "audio_seconds": round(dur, 2), "plan_seconds": round(plan["totalSec"], 2)}

# 1. loudness, peak, clipping
r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", video, "-af", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True).stderr
tail = r[r.rfind("Summary:"):]
g = lambda pat: (re.search(pat, tail) or [None, None])[1]
out["loudness_LUFS"] = float(g(r"I:\s+(-?[\d.]+) LUFS") or "nan")
out["loudness_range_LU"] = float(g(r"LRA:\s+([\d.]+) LU") or "nan")
out["true_peak_dBTP"] = float(g(r"Peak:\s+(-?[\d.]+) dBFS") or "nan")
out["clipped_samples"] = int((np.abs(x) > 0.999).sum())

# 2. silence: stretches under -50 dB longer than 0.4 s
win = int(0.05 * SR)
rms = np.sqrt(np.convolve(x * x, np.ones(win) / win, mode="same"))
quiet = rms < 10 ** (-50 / 20)
runs, start = [], None
for i, q in enumerate(quiet):
    if q and start is None: start = i
    if (not q or i == len(quiet) - 1) and start is not None:
        if (i - start) / SR > 0.4: runs.append([round(start / SR, 2), round(i / SR, 2)])
        start = None
out["silent_stretches_over_0.4s"] = runs
out["silent_fraction"] = round(float(quiet.mean()), 3)

# 3. per-line intelligibility + start alignment (Whisper on the final mix, only the slot of each line)
from faster_whisper import WhisperModel
model = WhisperModel("small", device="cpu", compute_type="int8", download_root="models-asr-testonly")
ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
def words(n):
    if n < 20: return ONES[n]
    if n < 100: return TENS[n // 10] + (" " + ONES[n % 10] if n % 10 else "")
    if n < 1000: return ONES[n // 100] + " hundred" + (" " + words(n % 100) if n % 100 else "")
    return words(n // 1000) + " thousand" + (" " + words(n % 1000) if n % 1000 else "")
norm = lambda s: re.sub(r"[^\w\s]", "", re.sub(r"\d{1,6}", lambda m: words(int(m.group())), unicodedata.normalize("NFC", s)).lower().replace("-", " ")).split()
lines = []
for l in plan["lines"]:
    a, b = max(0, l["start"] - 0.25), min(dur, l["end"] + 0.35)
    seg = x[int(a * SR): int(b * SR)]
    segs, _ = model.transcribe(seg, language="en", beam_size=5, word_timestamps=True)
    segs = list(segs)
    heard = " ".join(s.text.strip() for s in segs)
    ws = [w for s in segs for w in (s.words or [])]
    e, h = norm(l["spoken"]), norm(heard)
    mism = 1 - difflib.SequenceMatcher(None, e, h).ratio()
    # onset by energy (Whisper's word times are quantised and not precise): first 20 ms window above 40 % of the line's own peak, within -0.3..+0.6 s of the plan
    lo, hi = int(max(0, l["start"] - 0.3) * SR), int(min(dur, l["start"] + 0.6) * SR)
    w20 = int(0.02 * SR)
    env20 = np.array([np.sqrt((x[i:i + w20] ** 2).mean()) for i in range(lo, max(lo + 1, hi - w20), w20)])
    first = None
    if len(env20) and env20.max() > 0.01:
        k = int(np.argmax(env20 > 0.4 * env20.max()))
        first = (lo + k * w20) / SR
    lines.append({"shot": l["shot"], "expected": l["text"], "heard": heard, "word_mismatch": round(mism, 2),
                  "planned_start": round(l["start"], 2), "heard_start": round(first, 2) if first is not None else None,
                  "start_error_s": round(first - l["start"], 2) if first is not None else None})
out["voice_lines"] = lines
out["voice_mean_word_mismatch"] = round(float(np.mean([l["word_mismatch"] for l in lines])), 3) if lines else None

# 4. sound cues: is there a transient at the planned time? (energy in 80 ms after vs 250 ms before, ignoring the voice by high-pass)
env = np.abs(x)  # full band: a footstep is a low thud, a high-passed envelope would miss it
cues = []
for c in plan["cues"]:
    t = c["at"]
    i0 = int(t * SR)
    after = env[i0: i0 + int(0.08 * SR)]
    before = env[max(0, i0 - int(0.25 * SR)): max(1, i0 - int(0.03 * SR))]
    if len(after) == 0 or len(before) == 0: continue
    # best onset within +-60 ms of the planned time
    best, best_dt = 0.0, 0.0
    for dt in np.arange(-0.06, 0.0601, 0.01):
        j = int((t + dt) * SR)
        if j < 0 or j + int(0.05 * SR) > len(env): continue
        r_ = env[j: j + int(0.05 * SR)].mean() / (env[max(0, j - int(0.15 * SR)): max(1, j - int(0.02 * SR))].mean() + 1e-6)
        if r_ > best: best, best_dt = r_, dt
    cues.append({"kind": c["kind"], "at": round(t, 2), "onset_ratio": round(float(best), 2), "offset_ms": round(float(best_dt * 1000)), "audible": bool(best > 1.6)})
out["cues"] = cues
out["cues_audible_fraction"] = round(float(np.mean([c["audible"] for c in cues])), 2) if cues else None
print(json.dumps(out, indent=1, ensure_ascii=False))
