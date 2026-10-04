import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ServiceDetail } from "@studio/shared";
import { SubtitleRenderError } from "../../errors";
import type { CommandRunner } from "../../lib/command";
import { createLogger } from "../../lib/logger";
import type { SubtitleImage, SubtitleImageRequest, SubtitleRenderer } from "./SubtitleRenderer";

const log = createLogger("subtitles");

/**
 * Renders subtitle cues to transparent PNGs with macOS CoreText via the small Swift helper (scripts/subpng.swift,
 * built to bin/subpng). CoreText does real complex-script shaping, so Hindi conjuncts and vowel signs are correct:
 * the feasibility test measured Pillow-without-raqm mangling them. Works with ANY FFmpeg build (no libass needed).
 */
export class CoreTextSubtitleRenderer implements SubtitleRenderer {
  readonly name = "coretext";

  constructor(
    private readonly runner: CommandRunner,
    private readonly helper: string,
  ) {}

  async render(req: SubtitleImageRequest): Promise<SubtitleImage> {
    if (!existsSync(this.helper)) throw new SubtitleRenderError(`helper not found at ${this.helper}`);
    await fs.mkdir(path.dirname(req.outPath), { recursive: true });
    const args = [req.text, req.fontFamily, String(req.fontSizePx), String(req.widthPx), req.outPath, String(req.strokePercent), String(req.boxAlpha)];
    let result;
    try {
      result = await this.runner.run(this.helper, args, { timeoutMs: 20_000 });
    } catch (err) {
      throw new SubtitleRenderError(`could not run the helper: ${(err as Error).message}`, err);
    }
    const m = result.stdout.match(/(\d+)x(\d+) font=(\S+)/);
    if (result.code !== 0 || !m || !existsSync(req.outPath)) throw new SubtitleRenderError(`helper exited with code ${result.code}: ${result.stderr.slice(-300)}`);
    const usedFont = m[3]!;
    if (!usedFont.toLowerCase().includes(req.fontFamily.split(/\s+/)[0]!.toLowerCase())) {
      log.warn("requested font not found; macOS fell back to another font", { requested: req.fontFamily, used: usedFont });
    }
    return { path: req.outPath, width: Number(m[1]), height: Number(m[2]) };
  }

  async health(): Promise<ServiceDetail> {
    if (!existsSync(this.helper)) {
      return { status: "unavailable", message: "CoreText subtitle helper is not built", hint: "Run `npm run build:native` (needs the Xcode command line tools: xcode-select --install)." };
    }
    return { status: "ready", message: "CoreText subtitle helper ready (Latin and Devanagari shaping)" };
  }
}
