// Measures the pitch (autocorrelation F0) of several libritts_r speaker ids on one sentence, so distinct voices can be chosen without listening.
import { loadConfig } from "../../apps/server/src/config";
import { createContainer } from "../../apps/server/src/container";
import { setLogQuiet } from "../../apps/server/src/lib/logger";
import { parseWav } from "../../apps/server/src/lib/wav";
import fs from "node:fs";
setLogQuiet(true);
const cfg = loadConfig({}, "/Users/apple/Desktop/ai-studio-feasibility");
const c = createContainer(cfg);
const ids = (process.argv[2] ?? "0,10,25,40,60,80,120,200,300,400,500,650,800,900").split(",").map(Number);
fs.mkdirSync("/tmp/lab2/aud", { recursive: true });
function f0(samples: Int16Array, sr: number): number {
  const est: number[] = [];
  const win = Math.round(sr * 0.04), hop = Math.round(sr * 0.02);
  for (let a = 0; a + win * 2 < samples.length; a += hop) {
    let e = 0; for (let i = 0; i < win; i++) e += samples[a + i]! ** 2;
    if (e / win < 1e6) continue; // unvoiced/silence
    let best = 0, bl = 0;
    for (let lag = Math.round(sr / 400); lag <= Math.round(sr / 70); lag++) {
      let s = 0; for (let i = 0; i < win; i++) s += samples[a + i]! * samples[a + i + lag]!;
      if (s > best) { best = s; bl = lag; }
    }
    if (bl && best / e > 0.5) est.push(sr / bl);
  }
  est.sort((x, y) => x - y);
  return est.length ? est[Math.floor(est.length / 2)]! : 0;
}
for (const id of ids) {
  const out = `/tmp/lab2/aud/s${id}.wav`;
  // direct Piper call through the runner by registering a throwaway voice
  const tts = Object.values(c.svc.providers.tts)[0] as any;
  tts.voices.set(`aud${id}`, { id: `aud${id}`, language: "en", model: "en_US-libritts_r-medium.onnx", speaker: id });
  const r = await tts.synthesize({ text: "The address was an empty building. Nobody has lived here for years.", voiceId: `aud${id}`, outPath: out });
  const w = parseWav(fs.readFileSync(out));
  console.log(`speaker ${String(id).padStart(3)}  f0=${f0(w.samples, w.sampleRate).toFixed(0).padStart(4)} Hz  dur=${r.durationSec.toFixed(2)}s`);
}
