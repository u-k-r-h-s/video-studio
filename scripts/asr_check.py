# TEST-ONLY intelligibility proxy: transcribe a TTS sample with Whisper-small and compare to the input text.
import difflib, json, subprocess, sys, time, unicodedata, re
import numpy as np
from faster_whisper import WhisperModel
wav, lang, expected = sys.argv[1], sys.argv[2], sys.argv[3]
t = time.time(); m = WhisperModel("small", device="cpu", compute_type="int8", download_root="models-asr-testonly"); load_s = time.time() - t
pcm = subprocess.run(["ffmpeg","-v","error","-i",wav,"-ar","16000","-ac","1","-f","s16le","-"],capture_output=True).stdout
audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
t = time.time(); segs, info = m.transcribe(audio, language=lang, beam_size=5); text = " ".join(s.text.strip() for s in segs); asr_s = time.time() - t
ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
def words(n):
    if n < 20: return ONES[n]
    if n < 100: return TENS[n // 10] + (" " + ONES[n % 10] if n % 10 else "")
    if n < 1000: return ONES[n // 100] + " hundred" + (" " + words(n % 100) if n % 100 else "")
    return words(n // 1000) + " thousand" + (" " + words(n % 1000) if n % 1000 else "")
# numbers are compared as words on both sides ("13" == "thirteen"): Whisper writes digits, the script says words
spell = lambda s: re.sub(r"\d{1,6}", lambda m: words(int(m.group())), s)
norm = lambda s: re.sub(r"[^\w\s]", "", spell(unicodedata.normalize("NFC", s)).lower().replace("-", " ")).split()
e, h = norm(expected), norm(text)
sm = difflib.SequenceMatcher(None, e, h); wer_proxy = 1 - sm.ratio()
csim = difflib.SequenceMatcher(None, " ".join(e), " ".join(h)).ratio()
print(json.dumps({"wav": wav, "lang": lang, "asr_model_load_s": round(load_s, 1), "asr_s": round(asr_s, 1), "expected": expected, "heard": text,
                  "word_level_mismatch": round(wer_proxy, 2), "char_similarity": round(csim, 2)}, ensure_ascii=False, indent=1))
