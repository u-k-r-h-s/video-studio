import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ServiceDetail } from "@studio/shared";
import { PiperError, PiperVoiceNotFoundError } from "../../errors";
import type { CommandRunner } from "../../lib/command";
import { createLogger } from "../../lib/logger";
import { durationSec, parseWav } from "../../lib/wav";
import type { SpeechRequest, SpeechResult, TTSProvider, VoiceInfo } from "./TTSProvider";

const log = createLogger("piper");

export interface PiperOptions {
  /** Python interpreter of the venv that has piper-tts installed. */
  python: string;
  voicesDir: string;
  timeoutMs: number;
}

/**
 * Piper TTS as a SEPARATE process (Piper is GPL-3.0; we only run it and use its audio output).
 * Text is passed as a literal argument after `--` (never through a shell).
 */
export class PiperProvider implements TTSProvider {
  readonly name = "piper";
  private readonly voices: Map<string, VoiceInfo>;

  constructor(
    private readonly runner: CommandRunner,
    private readonly opts: PiperOptions,
    catalog: VoiceInfo[],
  ) {
    this.voices = new Map(catalog.map((v) => [v.id, v]));
  }

  listVoices(): VoiceInfo[] {
    return [...this.voices.values()];
  }

  getVoice(voiceId: string): VoiceInfo {
    const v = this.voices.get(voiceId);
    if (!v) throw new PiperError(`voice "${voiceId}" is not in the voice catalog (config/voices.json)`);
    return v;
  }

  private modelPath(voice: VoiceInfo): string {
    const model = path.join(this.opts.voicesDir, voice.model);
    if (!existsSync(model) || !existsSync(`${model}.json`)) throw new PiperVoiceNotFoundError(voice.id, voice.model);
    return model;
  }

  async synthesize(req: SpeechRequest): Promise<SpeechResult> {
    const voice = this.getVoice(req.voiceId);
    const model = this.modelPath(voice);
    // eslint-disable-next-line no-control-regex
    const text = req.text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!text) throw new PiperError("there is no text to speak");
    await fs.mkdir(path.dirname(req.outPath), { recursive: true });

    const args = ["-m", "piper", "-m", model, "-f", req.outPath, ...(voice.speaker !== undefined ? ["-s", String(voice.speaker)] : []), "--", text];
    const t0 = Date.now();
    let result;
    try {
      result = await this.runner.run(this.opts.python, args, { timeoutMs: this.opts.timeoutMs, signal: req.signal });
    } catch (err) {
      throw new PiperError(`could not run Piper: ${(err as Error).message}`, err);
    }
    if (result.code !== 0) throw new PiperError(`piper exited with code ${result.code}: ${result.stderr.slice(-400)}`);
    let durationSecs: number;
    try {
      durationSecs = durationSec(parseWav(await fs.readFile(req.outPath)));
    } catch (err) {
      throw new PiperError(`Piper produced an unreadable WAV: ${(err as Error).message}`, err);
    }
    log.info("synthesized", { voice: voice.id, ms: Date.now() - t0, audioSec: Math.round(durationSecs * 100) / 100 });
    return { path: req.outPath, durationSec: durationSecs };
  }

  async health(): Promise<ServiceDetail> {
    if (!existsSync(this.opts.python)) {
      return { status: "unavailable", message: `Piper Python not found at ${this.opts.python}`, hint: "See README -> Installation (uv venv venv-piper && uv pip install piper-tts) or set PIPER_PYTHON." };
    }
    const missing = this.listVoices().filter((v) => !existsSync(path.join(this.opts.voicesDir, v.model)));
    const models = new Set(this.listVoices().map((v) => v.model));
    if (missing.length === models.size) {
      return { status: "unavailable", message: "No Piper voice models found", hint: `Download voices into ${this.opts.voicesDir} (README -> Model installation).` };
    }
    return { status: "ready", message: `Piper ready (${models.size - new Set(missing.map((v) => v.model)).size}/${models.size} voice models installed)` };
  }
}
