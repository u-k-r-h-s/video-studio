import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PiperError, PiperVoiceNotFoundError } from "../src/errors";
import type { CommandRunner, RunResult } from "../src/lib/command";
import { setLogQuiet } from "../src/lib/logger";
import { durationSec, encodeWav, mixTimeline, parseWav, trimSilence, type Wav } from "../src/lib/wav";
import { PiperProvider } from "../src/providers/tts/PiperProvider";
import { loadVoiceCatalog, resolveVoiceId } from "../src/providers/tts/voices";
import { motionComic } from "../src/profiles/motionComic";

beforeAll(() => setLogQuiet(true));

const SR = 22050;
/** silence | tone | silence, like a Piper clip with leading/trailing quiet. */
function clip(leadSec: number, toneSec: number, tailSec: number): Wav {
  const n = Math.round((leadSec + toneSec + tailSec) * SR);
  const s = new Int16Array(n);
  for (let i = Math.round(leadSec * SR); i < Math.round((leadSec + toneSec) * SR); i++) s[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / SR));
  return { sampleRate: SR, samples: s };
}

describe("wav toolkit", () => {
  it("round-trips encode/parse and reports duration", () => {
    const w = clip(0, 1, 0);
    const back = parseWav(encodeWav(w));
    expect(back.sampleRate).toBe(SR);
    expect(back.samples).toEqual(w.samples);
    expect(durationSec(back)).toBeCloseTo(1, 3);
  });
  it("rejects non-wav and unsupported formats", () => {
    expect(() => parseWav(Buffer.from("not a wav file at all, definitely not riff............"))).toThrow(/RIFF/);
    const stereo = encodeWav(clip(0, 0.1, 0)); stereo.writeUInt16LE(2, 22);
    expect(() => parseWav(stereo)).toThrow(/PCM16 mono/);
  });
  it("trims leading/trailing silence but keeps a short pad", () => {
    const { wav, leadTrimmedSec, tailTrimmedSec } = trimSilence(clip(0.3, 1.0, 0.25), { padMs: 50 });
    expect(durationSec(wav)).toBeCloseTo(1.0 + 0.1, 1); // tone + 2 pads
    expect(leadTrimmedSec).toBeCloseTo(0.25, 1);
    expect(tailTrimmedSec).toBeCloseTo(0.2, 1);
  });
  it("leaves an all-silent clip untouched instead of returning nothing", () => {
    const silent = clip(0.5, 0, 0);
    expect(trimSilence(silent).wav.samples.length).toBe(silent.samples.length);
  });
  it("mixes clips onto a timeline at exact sample offsets", () => {
    const a = clip(0, 0.5, 0), b = clip(0, 0.5, 0);
    const mixed = mixTimeline([{ wav: a, startSec: 0.4 }, { wav: b, startSec: 2.0 }], SR, 3);
    expect(durationSec(mixed)).toBe(3);
    expect(mixed.samples[Math.round(0.2 * SR)]).toBe(0);
    expect(Math.abs(mixed.samples[Math.round(0.4 * SR) + 100]!)).toBeGreaterThan(0);
    expect(mixed.samples[Math.round(1.5 * SR)]).toBe(0);
    expect(Math.abs(mixed.samples[Math.round(2.0 * SR) + 100]!)).toBeGreaterThan(0);
  });
});

describe("PiperProvider (fake process runner)", () => {
  let dir: string;
  let voicesDir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-piper-"));
    voicesDir = path.join(dir, "voices");
    await fs.mkdir(voicesDir);
    await fs.writeFile(path.join(voicesDir, "en.onnx"), "x");
    await fs.writeFile(path.join(voicesDir, "en.onnx.json"), "{}");
  });
  afterEach(async () => fs.rm(dir, { recursive: true, force: true }));

  const catalog = [{ id: "en-a", language: "en" as const, model: "en.onnx", speaker: 7 }, { id: "hi-x", language: "hi" as const, model: "hi.onnx" }];
  function runner(behaviour: (args: readonly string[]) => Partial<RunResult> & { wav?: Wav }) {
    const calls: { file: string; args: readonly string[] }[] = [];
    const r: CommandRunner = {
      async run(file, args) {
        calls.push({ file, args });
        const out = behaviour(args);
        const outPath = args[args.indexOf("-f") + 1]!;
        if (out.wav) await fs.writeFile(outPath, encodeWav(out.wav));
        return { stdout: "", stderr: out.stderr ?? "", code: out.code ?? 0 };
      },
      spawn() { throw new Error("not used"); },
    };
    return { r, calls };
  }
  const provider = (r: CommandRunner) => new PiperProvider(r, { python: "/py", voicesDir, timeoutMs: 1000 }, catalog);

  it("calls Piper with literal arguments and returns the real duration", async () => {
    const { r, calls } = runner(() => ({ wav: clip(0, 1.5, 0) }));
    const evil = 'Hello; rm -rf / $(whoami) "quoted"\nsecond line';
    const res = await provider(r).synthesize({ text: evil, voiceId: "en-a", outPath: path.join(dir, "out", "a.wav") });
    expect(res.durationSec).toBeCloseTo(1.5, 2);
    const args = calls[0]!.args;
    expect(args.slice(0, 2)).toEqual(["-m", "piper"]);
    expect(args).toContain("-s"); expect(args[args.indexOf("-s") + 1]).toBe("7");
    const sep = args.indexOf("--");
    expect(args.slice(sep + 1)).toEqual(['Hello; rm -rf / $(whoami) "quoted" second line']); // one literal argument, control chars flattened
  });

  it("reports a missing voice model with the required message", async () => {
    const err = await provider(runner(() => ({})).r).synthesize({ text: "namaste", voiceId: "hi-x", outPath: path.join(dir, "h.wav") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PiperVoiceNotFoundError);
    expect((err as PiperVoiceNotFoundError).userMessage).toBe("Piper voice model was not found.");
  });

  it("fails clearly on unknown voices, empty text, non-zero exit and unreadable output", async () => {
    const ok = runner(() => ({ wav: clip(0, 0.2, 0) })).r;
    await expect(provider(ok).synthesize({ text: "hi", voiceId: "nope", outPath: path.join(dir, "x.wav") })).rejects.toBeInstanceOf(PiperError);
    await expect(provider(ok).synthesize({ text: "  \n ", voiceId: "en-a", outPath: path.join(dir, "x.wav") })).rejects.toThrow(PiperError);
    await expect(provider(runner(() => ({ code: 1, stderr: "onnx boom" })).r).synthesize({ text: "hi", voiceId: "en-a", outPath: path.join(dir, "x.wav") })).rejects.toMatchObject({ userMessage: "Piper could not generate the voice audio.", details: expect.stringContaining("exited with code 1") });
    await expect(provider(runner(() => ({})).r).synthesize({ text: "hi", voiceId: "en-a", outPath: path.join(dir, "missing.wav") })).rejects.toMatchObject({ details: expect.stringContaining("unreadable WAV") });
  });

  it("reports health from the installed voice files", async () => {
    await fs.writeFile("/tmp/fake-python-for-test", "");
    const h = await new PiperProvider(runner(() => ({})).r, { python: "/tmp/fake-python-for-test", voicesDir, timeoutMs: 1 }, catalog).health();
    expect(h.status).toBe("ready");
    expect((await new PiperProvider(runner(() => ({})).r, { python: "/nonexistent/python", voicesDir, timeoutMs: 1 }, catalog).health()).status).toBe("unavailable");
  });
});

describe("voice catalog + assignment", () => {
  const chars = [
    { id: "raghu", name: "R", description: "d d d", appearance: "a a a" },
    { id: "mintu", name: "M", description: "d d d", appearance: "a a a" },
    { id: "third", name: "T", description: "d d d", appearance: "a a a", voiceId: "custom" },
  ];
  it("loads the shipped catalog (names only, no weights)", () => {
    const voices = loadVoiceCatalog(path.resolve(__dirname, "../../../config/voices.json"));
    expect(voices.find((v) => v.id === "hi-rohan")?.language).toBe("hi");
    expect(voices.every((v) => v.model.endsWith(".onnx"))).toBe(true);
  });
  it("assigns narrator/profile voices deterministically and honours explicit voiceId", () => {
    expect(resolveVoiceId("narrator", chars, "en", motionComic)).toBe("en-narrator");
    expect(resolveVoiceId("raghu", chars, "en", motionComic)).toBe("en-a");
    expect(resolveVoiceId("mintu", chars, "en", motionComic)).toBe("en-b");
    expect(resolveVoiceId("third", chars, "en", motionComic)).toBe("custom");
    expect(resolveVoiceId("raghu", chars, "hi", motionComic)).toBe("hi-rohan");
    expect(resolveVoiceId("raghu", chars, "en", motionComic)).toBe(resolveVoiceId("raghu", chars, "en", motionComic));
  });
});
