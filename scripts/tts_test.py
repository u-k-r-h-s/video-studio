import json, sys, time, wave
t_proc = time.time()
from piper import PiperVoice, SynthesisConfig
t_import = time.time() - t_proc
model, text, out = sys.argv[1], sys.argv[2], sys.argv[3]
speaker = int(sys.argv[4]) if len(sys.argv) > 4 else None
t = time.time(); voice = PiperVoice.load(model); t_load = time.time() - t
cfg = SynthesisConfig(speaker_id=speaker) if speaker is not None else None
times = []
for i in range(2):  # run twice: first = cold (ONNX session warm-up), second = steady state
    t = time.time()
    with wave.open(out, "wb") as wf:
        voice.synthesize_wav(text, wf, syn_config=cfg)
    times.append(time.time() - t)
with wave.open(out, "rb") as wf:
    audio_s = wf.getnframes() / wf.getframerate()
print(json.dumps({"voice": model.split("/")[-1], "import_s": round(t_import, 2), "load_s": round(t_load, 2),
                  "synth_first_s": round(times[0], 2), "synth_second_s": round(times[1], 2), "audio_s": round(audio_s, 2),
                  "rtf_second": round(times[1] / audio_s, 3), "out": out}, ensure_ascii=False))
