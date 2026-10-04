// Renders the prototype "The Last Delivery" from the hand-authored story and the 8 key visuals.
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../apps/server/src/config";
import { createContainer } from "../../apps/server/src/container";
import { setLogQuiet } from "../../apps/server/src/lib/logger";
import { encodeWav, durationSec, parseWav, trimSilence } from "../../apps/server/src/lib/wav";
import { defaultFocus } from "../../apps/server/src/shots/cameraLanguage";
import { captionCenterY, chunkLine, renderCaptionStates } from "../../apps/server/src/shots/captions";
import { renderShot, type ShotRenderSpec } from "../../apps/server/src/shots/shotRenderer";
import { planTimeline } from "../../apps/server/src/shots/timeline";
import { mixSoundtrack, planSoundtrack } from "../../apps/server/src/audio/soundtrack";
import { PROTO_STORY, VOICE_OF } from "./prototype-story";

setLogQuiet(true);
const ROOT = "/Users/apple/Desktop/ai-studio-feasibility";
const cfg = loadConfig({}, ROOT);
const c = createContainer(cfg);
const tts = Object.values(c.svc.providers.tts)[0]!;
const P = `${ROOT}/projects/proto-last-delivery`;
const only = process.argv[2]; // optional: render a single shot id for quick iteration
const story = PROTO_STORY;
const t00 = Date.now();
const lap = (m: string): void => console.log(`[${((Date.now() - t00) / 1000).toFixed(1).padStart(6)} s] ${m}`);

// 1. voices
const lineDur: Record<string, number> = {}, voicePaths: Record<string, string> = {};
for (const s of story.shots) for (const d of s.dialogue) {
  const raw = `${P}/audio/${d.id}.raw.wav`, out = `${P}/audio/${d.id}.wav`;
  await fs.mkdir(`${P}/audio`, { recursive: true });
  await tts.synthesize({ text: d.text.replace(/\.\.\./g, ","), voiceId: VOICE_OF[d.characterId] ?? "en-narrator", outPath: raw, lengthScale: 1.35 });
  const t = trimSilence(parseWav(await fs.readFile(raw)));
  await fs.writeFile(out, encodeWav(t.wav));
  lineDur[d.id] = durationSec(t.wav);
  voicePaths[d.id] = out;
}
lap(`voices: ${Object.entries(lineDur).map(([k, v]) => `${k}=${v.toFixed(2)}s`).join(" ")}`);

// 2. timeline + soundtrack
const tl = planTimeline(story.shots, lineDur);
const tracks = await planSoundtrack({ shots: story.shots, timeline: tl, voicePaths, dir: `${P}/audio/synth` });
const mix = await mixSoundtrack(tracks, tl.totalSec, `${P}/audio/mix.wav`);
lap(`timeline ${tl.totalSec.toFixed(2)} s, ${tracks.length} audio tracks, mix peak ${mix.peak.toFixed(2)}`);
await fs.writeFile(`${P}/timeline.json`, JSON.stringify({ tl, tracks }, null, 1));

// 3. shots
const clips: string[] = [];
const enc = { ffmpeg: cfg.ffmpeg.ffmpeg, ffprobe: cfg.ffmpeg.ffprobe, encoder: "h264_videotoolbox" as const, bitrateKbps: 14000, timeoutMs: 600_000 };
for (let i = 0; i < story.shots.length; i++) {
  const shot = story.shots[i]!, st = tl.shots[i]!;
  const clip = `${P}/shots/${shot.id}.mp4`;
  clips.push(clip);
  if (only && only !== shot.id) continue;
  const focus = shot.focus ?? defaultFocus(shot.shotType);
  const chunks = st.lines.flatMap((l) => chunkLine(l.text, l.localStart, l.localEnd, l.emphasis));
  const caps = await renderCaptionStates(c.runner, cfg.subtitles.helper, chunks, `${P}/captions`);
  let insert: ShotRenderSpec["insert"];
  if (shot.insert) {
    const png = `${P}/captions/insert-${shot.id}.png`;
    const isTitle = shot.insert.kind === "title";
    await c.runner.run(cfg.subtitles.helper, [shot.insert.text, "Impact", isTitle ? "136" : "92", isTitle ? "960" : "900", png, "5", isTitle ? "0" : "0.55", "-1"], { timeoutMs: 20_000 });
    const b = await fs.readFile(png);
    insert = { png, start: isTitle ? 0.5 : 0.05, end: st.duration, width: b.readUInt32BE(16), height: b.readUInt32BE(20), centerY: isTitle ? 0.44 : shot.id === "shot-01" ? 0.27 : 0.42 };
  }
  const spec: ShotRenderSpec = {
    shot, imagePath: `${P}/images/${shot.visualKey}.png`, duration: st.duration, width: 1080, height: 1920, fps: 30,
    transitionIn: i === 0 ? "cut" : story.shots[i - 1]!.transition.type, isFirst: i === 0, isLast: i === story.shots.length - 1,
    captions: caps, captionCenterY: captionCenterY(focus), insert,
    flashAt: shot.effects?.flash && shot.id !== "shot-09" ? [0.0] : [],
  };
  const r = await renderShot(c.runner, spec, clip, enc);
  lap(`${shot.id} ${shot.shotType.padEnd(17)} ${st.duration.toFixed(2)} s -> render ${(r.renderMs / 1000).toFixed(1)} s`);
}
if (only) process.exit(0);

// 4. assemble + audio
const list = `${P}/final.concat.txt`;
await fs.writeFile(list, clips.map((p) => `file '${p}'`).join("\n") + "\n");
const out = `${P}/final.mp4`;
const r = await c.runner.run(cfg.ffmpeg.ffmpeg, [
  "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-i", mix.path, "-map", "0:v", "-map", "1:a",
  "-c:v", "copy", "-af", "loudnorm=I=-14:TP=-1.5:LRA=9,aresample=48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", out,
], { timeoutMs: 300_000 });
if (r.code !== 0) throw new Error(r.stderr);
lap(`final -> ${out}`);
