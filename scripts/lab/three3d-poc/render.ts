// Three.js proof of concept: renders ONE 10 s vertical shot of a rigged GLB character to an MP4.
//   npx tsx scripts/lab/three3d-poc/render.ts [--out ~/Desktop/three3d-poc.mp4] [--frames 0,60,150] (frames: PNG stills only)
// Pipeline: esbuild bundles apps/server/src/anim/three3d/scene.ts -> headless Google Chrome (WebGL via Metal, temporary profile)
// renders frame i -> PNG -> piped into the SAME FFmpeg post chain as the 2D renderer (grade, bloom, vignette, grain).
// Character: assets/3d/characters/test-character/character.glb (git-ignored; see THREE3D_POC_REPORT.md).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { animPostGraph } from "../../../apps/server/src/anim/video";
import { loadConfig } from "../../../apps/server/src/config";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const OUT = flag("out") ?? path.join(os.homedir(), "Desktop", "three3d-poc.mp4");
const STILLS = flag("frames")?.split(",").map(Number);
const GLB = path.join(ROOT, "assets/3d/characters/test-character/character.glb");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1080, H = 1920, FPS = 30, DURATION = 10;
if (!fs.existsSync(GLB)) { console.error(`No character at ${GLB}. Put a rigged .glb with Idle and Walk clips there (see THREE3D_POC_REPORT.md).`); process.exit(1); }

const t0 = Date.now();
const bundle = await build({
  stdin: { contents: `import { createPoc } from "./apps/server/src/anim/three3d/scene.ts"; (window as any).createPoc = createPoc;`, resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", platform: "browser", write: false, minify: true, logLevel: "error",
});
const js = bundle.outputFiles[0]!.text;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "three3d-chrome-"));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile,
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--no-first-run", "--no-default-browser-check", `--window-size=${W},${H}`],
});
const memSamples: number[] = [];
const sampleMem = (): void => {
  try {
    const out = execFileSync("ps", ["-axo", "rss=,command="], { encoding: "utf8" });
    let kb = 0;
    for (const line of out.split("\n")) if (line.includes(profile) || line.includes("Google Chrome Helper") && line.includes(path.basename(profile))) kb += Number(line.trim().split(/\s+/)[0]) || 0;
    memSamples.push(kb / 1024 + process.memoryUsage().rss / 1048576);
  } catch { /* ignore */ }
};
const memTimer = setInterval(sampleMem, 1000);
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warn") console.log("[page]", m.text()); });
  page.on("pageerror", (e) => console.log("[page error]", e));
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#000"><script>${js}</script></body></html>`);
  const glb = fs.readFileSync(GLB).toString("base64");
  const tLoad = Date.now();
  const info = await page.evaluate(async (o) => { const poc = await (window as any).createPoc(o); (window as any).poc = poc; return { frames: poc.frames }; }, { width: W, height: H, fps: FPS, duration: DURATION, glbBase64: glb });
  console.log(`scene ready in ${((Date.now() - tLoad) / 1000).toFixed(1)} s, ${info.frames} frames`);

  const grab = (i: number): Promise<string> => page.evaluate((k) => { const poc = (window as any).poc; poc.renderFrame(k); return poc.canvas.toDataURL("image/png").slice(22); }, i);
  if (STILLS) {
    const want = new Set(STILLS);
    for (let i = 0; i <= Math.max(...STILLS); i++) {
      const png = await grab(i);
      if (want.has(i)) { fs.writeFileSync(`/tmp/three3d-f${i}.png`, Buffer.from(png, "base64")); console.log(`/tmp/three3d-f${i}.png`); }
    }
  } else {
    const cfg = loadConfig({}, ROOT);
    const post = animPostGraph(W, H, DURATION, FPS, { ffmpeg: cfg.ffmpeg.ffmpeg, encoder: "h264_videotoolbox", bitrateKbps: 14000, fadeIn: 0.3, fadeOut: 0.4, grade: { contrast: 1.06, saturation: 1.0, bloom: 0.22, grain: 5, vignette: 1 } });
    const ff = spawn(cfg.ffmpeg.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-", ...post.inputs,
      "-filter_complex", post.filter, "-map", "[vout]", "-c:v", "h264_videotoolbox", "-b:v", "14000k", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS), "-frames:v", String(info.frames), "-an", "-movflags", "+faststart", `${OUT}.video.mp4`], { stdio: ["pipe", "ignore", "inherit"] });
    const done = new Promise<void>((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`)))));
    const tR = Date.now();
    const per: number[] = [];
    for (let i = 0; i < info.frames; i++) {
      const s = Date.now();
      const png = Buffer.from(await grab(i), "base64");
      per.push(Date.now() - s);
      if (!ff.stdin!.write(png)) await new Promise<void>((r) => ff.stdin!.once("drain", () => r()));
      if (i % 60 === 0) console.log(`frame ${i}/${info.frames}  ${per[per.length - 1]} ms`);
    }
    ff.stdin!.end();
    await done;
    const renderS = (Date.now() - tR) / 1000;
    // a simple soundtrack so the clip is reviewable with sound: rain ambience + footsteps on the walk + a hit on the reaction
    const { mixTracks, toWav } = await import("../../../apps/server/src/audio/mixer");
    const { ambientNight, footsteps } = await import("../../../apps/server/src/audio/synth");
    const { sfxSamples } = await import("../../../apps/server/src/audio/soundtrack");
    const { encodeWav } = await import("../../../apps/server/src/lib/wav");
    const step = footsteps(1, 0.5, 5);
    const tracks = [{ type: "ambient" as const, samples: ambientNight(DURATION), startTime: 0, volume: 0.5 }];
    for (let k = 0; k < 6; k++) tracks.push({ type: "ambient" as const, samples: step, startTime: 2.45 + k * 0.52, volume: 0.45 });
    tracks.push({ type: "ambient" as const, samples: sfxSamples("impact"), startTime: 7.0, volume: 0.6 });
    fs.writeFileSync(`${OUT}.wav`, encodeWav(toWav(mixTracks(tracks as never, { totalSec: DURATION }))));
    execFileSync(cfg.ffmpeg.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", `${OUT}.video.mp4`, "-i", `${OUT}.wav`, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", OUT]);
    fs.rmSync(`${OUT}.video.mp4`); fs.rmSync(`${OUT}.wav`);
    const sorted = [...per].sort((a, b) => a - b);
    const stats = {
      out: OUT, frames: info.frames, width: W, height: H, fps: FPS, sizeMB: +(fs.statSync(OUT).size / 1e6).toFixed(1),
      totalSeconds: +((Date.now() - t0) / 1000).toFixed(1), renderSeconds: +renderS.toFixed(1),
      msPerFrame: { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1] },
      effectiveFps: +(info.frames / renderS).toFixed(1), peakMemoryMB: Math.round(Math.max(...memSamples, 0)),
      scene: await page.evaluate(() => (window as any).poc.info()),
    };
    console.log(JSON.stringify(stats, null, 1));
    fs.writeFileSync(path.join(ROOT, "scripts/lab/three3d-poc/last-run.json"), JSON.stringify(stats, null, 1));
  }
} finally {
  clearInterval(memTimer);
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
