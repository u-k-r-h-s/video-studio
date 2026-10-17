// Converts a Microsoft Rocketbox avatar (MIT) to one GLB for the 3D library, with three.js in headless Chrome (no other tools):
//   npx tsx scripts/lab/three3d/rocketbox/convert.ts inspect <avatar-dir> [clip.fbx]
//   npx tsx scripts/lab/three3d/rocketbox/convert.ts convert <avatar-dir> <out-key> <m|f> [--lod hipoly|midpoly|lowpoly]
// Sources: assets/3d/sources/rocketbox (git-ignored). Output: assets/3d/characters/<out-key>/character.glb (git-ignored).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CHROME } from "../../../../apps/server/src/anim/renderers/three3d";

const ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const [cmd, avatarDir, ...rest] = process.argv.slice(2);

/** Textures as 1024 px PNG data URLs keyed by lower-case file name (FFmpeg reads the TGA). */
function textures(dir: string, max = 1024): Record<string, string> {
  const out: Record<string, string> = {};
  const tdir = path.join(dir, "Textures");
  for (const f of fs.existsSync(tdir) ? fs.readdirSync(tdir) : []) {
    if (!/\.(tga|png|jpg)$/i.test(f)) continue;
    const png = path.join(os.tmpdir(), `rb-${f}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path.join(tdir, f), "-vf", `scale='min(${max},iw)':-1`, png]);
    out[f.replace(/\.\w+$/, "").toLowerCase()] = `data:image/png;base64,${fs.readFileSync(png).toString("base64")}`;
  }
  return out;
}

async function main(): Promise<void> {
  const { build } = await import("esbuild");
  const bundle = (await build({ entryPoints: [path.join(path.dirname(new URL(import.meta.url).pathname), "page.ts")], bundle: true, format: "iife", platform: "browser", write: false, logLevel: "error" })).outputFiles[0]!.text;
  const puppeteer = (await import("puppeteer-core")).default;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rb-chrome-"));
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? DEFAULT_CHROME, headless: true, userDataDir: profile, protocolTimeout: 600_000, args: ["--use-angle=metal", "--no-first-run"] });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.type() === "warn" || m.type() === "error") console.error("[page]", m.text().slice(0, 200)); });
    page.on("pageerror", (e) => console.error("[page error]", e));
    await page.setContent(`<!doctype html><html><body><script>${bundle}</script></body></html>`);
    const fbx = fs.readdirSync(path.join(avatarDir!, "Export")).find((f) => f.endsWith("_facial.fbx"))!;
    const files = { fbx: fs.readFileSync(path.join(avatarDir!, "Export", fbx)).toString("base64"), textures: textures(avatarDir!) };
    if (cmd === "convert") {
      const [key, sex] = rest as [string, "m" | "f"];
      const A = path.join(ROOT, "assets/3d/sources/rocketbox/Animations");
      const clips = fs.readdirSync(A).flatMap((d) => fs.readdirSync(path.join(A, d)).filter((f) => f.startsWith(`${sex}_`)).map((f) => ({ file: f, fbx: fs.readFileSync(path.join(A, d, f)).toString("base64"), locomotion: d.endsWith("_xy") || d.endsWith("_xyz") })));
      const r = await page.evaluate((f, c) => (window as any).rb.convert(f, c), files, clips) as { glb: string; report: Record<string, unknown> };
      const dir = path.join(ROOT, "assets/3d/characters", key!);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "character.glb"), Buffer.from(r.glb, "base64"));
      const { blendShapeNames, ...short } = r.report;
      console.log(JSON.stringify({ key, source: path.relative(ROOT, avatarDir!), ...short, blendShapeSample: (blendShapeNames as string[]).slice(0, 6) }, null, 1));
    }
    if (cmd === "inspect") {
      console.log(JSON.stringify(await page.evaluate((f) => (window as any).rb.inspect(f), files), null, 1));
      if (rest[0]) console.log(JSON.stringify(await page.evaluate((f) => (window as any).rb.inspect(f), { fbx: fs.readFileSync(rest[0]).toString("base64"), textures: {} }), null, 1).slice(0, 3000));
    }
  } finally { await browser.close(); fs.rmSync(profile, { recursive: true, force: true }); }
}
await main();
void ROOT;
