import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { animPostGraph } from "../../video";
import type { ClipOptions, RenderResult, ShotRenderer } from "../types";
import type { Shot3DSpec } from "./spec";

/**
 * The Three.js shot renderer. The runtime (./runtime, bundled once with esbuild) runs in a headless Google Chrome page
 * (WebGL2 on Metal; a throwaway profile, none of the user's browser data), draws each frame, and the frames stream as PNG
 * into the SAME FFmpeg post chain as the 2D renderer. One browser serves all the shots of a film; close() quits it.
 */
export interface Three3DOptions {
  /** Chrome / Chromium executable (default: the installed Google Chrome). */
  chrome?: string;
  /** Resolves a 3D character asset key to its .glb file. */
  characterFile: (asset: string) => string;
  /** Resolves an image key (backdrop plate, wall texture) to a file. */
  imageFile?: (key: string) => string | null;
}

export const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let bundleCache: string | null = null;
export async function runtimeBundle(): Promise<string> {
  if (bundleCache) return bundleCache;
  const { build } = await import("esbuild");
  const r = await build({ entryPoints: [path.join(path.dirname(new URL(import.meta.url).pathname), "runtime", "entry.ts")], bundle: true, format: "iife", platform: "browser", write: false, minify: true, logLevel: "error" });
  bundleCache = r.outputFiles[0]!.text;
  return bundleCache;
}

type Browser = Awaited<ReturnType<typeof import("puppeteer-core")["default"]["launch"]>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

export class Three3DRenderer implements ShotRenderer<Shot3DSpec> {
  readonly id = "three3d" as const;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private profile: string | null = null;
  private loaded = new Set<string>();
  constructor(private readonly o: Three3DOptions) {}

  static available(chrome = DEFAULT_CHROME): boolean { return existsSync(chrome); }

  private async open(w: number, h: number): Promise<Page> {
    if (this.page) { await this.page.setViewport({ width: w, height: h, deviceScaleFactor: 1 }); return this.page; }
    const chrome = this.o.chrome ?? DEFAULT_CHROME;
    if (!existsSync(chrome)) throw new Error(`The 3D renderer needs Google Chrome (or set CHROME_PATH): not found at ${chrome}`);
    const puppeteer = (await import("puppeteer-core")).default;
    this.profile = mkdtempSync(path.join(os.tmpdir(), "studio3d-chrome-"));
    this.browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: this.profile, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--no-first-run", "--no-default-browser-check", "--disable-extensions"] });
    const page = await this.browser.newPage();
    page.on("pageerror", (e) => console.error("[three3d]", e));
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#000"><script>${await runtimeBundle()}</script></body></html>`);
    this.page = page;
    return page;
  }

  /** Files the shot needs, as base64 / data URLs (a model is sent once per browser session). */
  private async assets(spec: Shot3DSpec): Promise<{ characters: Record<string, string>; images: Record<string, string> }> {
    const characters: Record<string, string> = {};
    for (const c of spec.characters) {
      if (this.loaded.has(c.asset) || characters[c.asset]) { characters[c.asset] ??= ""; continue; }
      const file = this.o.characterFile(c.asset);
      if (!existsSync(file)) throw new Error(`3D character "${c.asset}" not found at ${file}`);
      characters[c.asset] = (await fs.readFile(file)).toString("base64");
    }
    const images: Record<string, string> = {};
    for (const key of [spec.environment.backdrop, spec.environment.wallTexture, spec.environment.groundTexture]) {
      if (!key) continue;
      const file = this.o.imageFile?.(key) ?? key;
      if (!file || !existsSync(file)) continue;
      const ext = path.extname(file).slice(1).toLowerCase() === "jpg" ? "jpeg" : path.extname(file).slice(1).toLowerCase() || "png";
      images[key] = `data:image/${ext};base64,${(await fs.readFile(file)).toString("base64")}`;
    }
    return { characters, images };
  }

  /** Renders the shot in the browser without encoding: PNG frames for inspection / tests. */
  async stills(spec: Shot3DSpec, frames: number[]): Promise<{ frames: Map<number, Buffer>; info: Record<string, unknown>; cues: RenderResult["cues"] }> {
    const page = await this.prepare(spec);
    const want = new Set(frames), out = new Map<number, Buffer>();
    for (let i = 0; i <= Math.max(...frames); i++) {
      const png = await page.evaluate((k, keep) => { const s = (window as unknown as { shot: { renderFrame(i: number): void; canvas: HTMLCanvasElement } }).shot; s.renderFrame(k); return keep ? s.canvas.toDataURL("image/png").slice(22) : ""; }, i, want.has(i));
      if (want.has(i)) out.set(i, Buffer.from(png, "base64"));
    }
    return { frames: out, ...(await this.finish(page)) };
  }

  private async prepare(spec: Shot3DSpec): Promise<Page> {
    const page = await this.open(spec.width, spec.height);
    const assets = await this.assets(spec);
    // models already sent in this session are cached in the page (empty string = reuse)
    for (const [k, v] of Object.entries(assets.characters)) if (!v) delete assets.characters[k];
    await page.evaluate(async (s: unknown, a: { characters: Record<string, string>; images: Record<string, string> }) => {
      const w = window as unknown as { studio3d: { createShot: (s: unknown, a: unknown) => Promise<unknown> }; shot?: { dispose(): void }; models?: Record<string, string> };
      w.models = { ...(w.models ?? {}), ...a.characters };
      w.shot?.dispose();
      w.shot = (await w.studio3d.createShot(s, { characters: w.models, images: a.images })) as { dispose(): void };
    }, spec as unknown, assets);
    for (const c of spec.characters) this.loaded.add(c.asset);
    return page;
  }

  private async finish(page: Page): Promise<{ info: Record<string, unknown>; cues: RenderResult["cues"] }> {
    return page.evaluate(() => { const s = (window as unknown as { shot: { info(): Record<string, unknown>; cues(): RenderResult["cues"] } }).shot; return { info: s.info(), cues: s.cues() }; });
  }

  async render(spec: Shot3DSpec, outPath: string, o: ClipOptions): Promise<RenderResult> {
    const t0 = Date.now();
    const page = await this.prepare(spec);
    const setupMs = Date.now() - t0;
    const W = spec.width, H = spec.height, fps = spec.fps, total = Math.round(spec.duration * fps);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const post = animPostGraph(W, H, spec.duration, fps, o);
    await fs.writeFile(`${outPath}.filtergraph.txt`, `${post.filter}\n`);
    const venc = o.encoder === "h264_videotoolbox"
      ? ["-c:v", "h264_videotoolbox", "-b:v", `${o.bitrateKbps}k`, "-maxrate", `${Math.round(o.bitrateKbps * 1.25)}k`, "-profile:v", "high", "-allow_sw", "0"]
      : ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-profile:v", "high"];
    const ff = spawn(o.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-", ...post.inputs,
      "-filter_complex", post.filter, "-map", "[vout]", ...venc, "-pix_fmt", "yuv420p", "-r", String(fps), "-frames:v", String(total), "-an", "-movflags", "+faststart", outPath], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    ff.stderr!.on("data", (d) => { err += String(d); });
    ff.stdin!.on("error", () => {});
    const done = new Promise<void>((res, rej) => { ff.on("error", rej); ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}: ${err.slice(-600)}`)))); });
    for (let i = 0; i < total; i++) {
      const b64 = await page.evaluate((k) => { const s = (window as unknown as { shot: { renderFrame(i: number): void; canvas: HTMLCanvasElement } }).shot; s.renderFrame(k); return s.canvas.toDataURL("image/png").slice(22); }, i);
      if (!ff.stdin!.write(Buffer.from(b64, "base64"))) await new Promise<void>((r) => ff.stdin!.once("drain", () => r()));
      o.onProgress?.(i + 1, total);
    }
    ff.stdin!.end();
    await done;
    const { info, cues } = await this.finish(page);
    return { frames: total, renderMs: Date.now() - t0, cues, info: { ...info, hostSetupMs: setupMs } };
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null; this.page = null; this.loaded.clear();
    if (b) await b.close().catch(() => {});
    if (this.profile) rmSync(this.profile, { recursive: true, force: true });
    this.profile = null;
  }
}
