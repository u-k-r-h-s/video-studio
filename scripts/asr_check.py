# TEST-ONLY intelligibility proxy: transcribe a TTS sample with Whisper-small and compare to the input text.
import difflib, json, subprocess, sys, time, unicodedata, re
import numpy as np
from faster_whisper import WhisperModel
wav, lang, expected = sys.argv[1], sys.argv[2], sys.argv[3]
t = time.time(); m = WhisperModel("small", device="cpu", compute_type="int8", download_root="models-asr-testonly"); load_s = time.time() - t
pcm = subprocess.run(["ffmpeg","-v","error","-i",wav,"-ar","16000","-ac","1","-f","s16le","-"],capture_output=True).stdout
audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
t = time.time(); segs, info = m.transcribe(audio, language=lang, beam_size=5); text = " ".join(s.text.strip() for s in segs); asr_s = time.time() - t
norm = lambda s: re.sub(r"[^\w\s]", "", unicodedata.normalize("NFC", s).lower()).split()
e, h = norm(expected), norm(text)
sm = difflib.SequenceMatcher(None, e, h); wer_proxy = 1 - sm.ratio()
csim = difflib.SequenceMatcher(None, " ".join(e), " ".join(h)).ratio()
print(json.dumps({"wav": wav, "lang": lang, "asr_model_load_s": round(load_s, 1), "asr_s": round(asr_s, 1), "expected": expected, "heard": text,
                  "word_level_mismatch": round(wer_proxy, 2), "char_similarity": round(csim, 2)}, ensure_ascii=False, indent=1))
