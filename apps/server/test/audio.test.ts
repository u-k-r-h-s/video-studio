import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Shot } from "@studio/shared";
import { activity, mixTracks, toFloat44k, type MixTrack } from "../src/audio/mixer";
import { mixSoundtrack, planSoundtrack, sfxSamples } from "../src/audio/soundtrack";
import * as synth from "../src/audio/synth";
import { encodeWav, parseWav } from "../src/lib/wav";
import { planCamera } from "../src/shots/cameraLanguage";
import { planTimeline } from "../src/shots/timeline";

const rms = (x: Float32Array, a = 0, b = x.length): number => { let s = 0; for (let i = a; i < b; i++) s += x[i]! * x[i]!; return Math.sqrt(s / Math.max(1, b - a)); };
const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const secs = (x: Float32Array): number => x.length / synth.SR;

describe("procedural sound synthesis", () => {
  const kinds = ["whoosh", "whoosh-rise", "impact", "ping", "ding", "door", "footsteps", "heartbeat", "riser", "glitch"] as const;
  it("is deterministic: the same inputs give bit-identical audio, a different seed differs", () => {
    expect(synth.whoosh(0.5, true, 7)).toEqual(synth.whoosh(0.5, true, 7));
    expect(synth.whoosh(0.5, true, 7)).not.toEqual(synth.whoosh(0.5, true, 8));
    expect(synth.tensionBed(2)).toEqual(synth.tensionBed(2));
  });
  it.each(kinds)("%s: finite, non-silent, never clips, sensible length", (k) => {
    const x = sfxSamples(k);
    expect(x.every(Number.isFinite)).toBe(true);
    expect(peak(x)).toBeGreaterThan(0.1);
    expect(peak(x)).toBeLessThanOrEqual(1);
    expect(secs(x)).toBeGreaterThan(0.2);
    expect(secs(x)).toBeLessThan(5);
  });
  it("whoosh fades in and out (starts and ends near silence)", () => {
    const x = synth.whoosh(0.6, true);
    expect(rms(x, 0, 500)).toBeLessThan(rms(x, Math.floor(x.length * 0.4), Math.floor(x.length * 0.6)) * 0.3);
    expect(rms(x, x.length - 300)).toBeLessThan(0.05);
  });
  it("impact is loud at the start and decays; the rising riser gets louder", () => {
    const i = synth.impact(1.2);
    expect(rms(i, 0, 4000)).toBeGreaterThan(rms(i, i.length - 4000) * 5);
    const r = synth.riser(2);
    expect(rms(r, r.length - 8000)).toBeGreaterThan(rms(r, 0, 8000) * 3);
  });
  it("tension bed follows its intensity curve and has the requested length", () => {
    const calm = synth.tensionBed(3, () => 0.05), tense = synth.tensionBed(3, () => 1);
    expect(secs(calm)).toBeCloseTo(3, 2);
    expect(rms(tense, 20000, 100000)).toBeGreaterThan(0);
    expect(peak(synth.ambientNight(2))).toBeGreaterThan(0.05);
  });
});

describe("mixer", () => {
  const tone = (sec: number, a = 0.5): Float32Array => Float32Array.from({ length: Math.round(sec * synth.SR) }, (_, i) => a * Math.sin((2 * Math.PI * 220 * i) / synth.SR));
  it("places clips at their start time (sample accurate)", () => {
    const out = mixTracks([{ type: "sfx", samples: tone(0.5), startTime: 1.0, volume: 1 }], { totalSec: 2 });
    expect(rms(out, 0, synth.SR - 100)).toBe(0);
    expect(rms(out, synth.SR + 200, synth.SR + 4000)).toBeGreaterThan(0.2);
    expect(rms(out, Math.round(1.6 * synth.SR))).toBe(0);
  });
  it("ducks music under speech and lets it back up afterwards; sfx are not ducked", () => {
    const tracks: MixTrack[] = [
      { type: "voice", samples: tone(1, 0.6), startTime: 1, volume: 1 },
      { type: "music", samples: tone(4, 0.3), startTime: 0, volume: 1 },
    ];
    const withVoice = mixTracks(tracks, { totalSec: 4, duck: 0.6, peak: 5 });
    const musicOnly = mixTracks([tracks[1]!], { totalSec: 4, peak: 5 });
    // the same music level (before/after speech) vs. during speech where the sum includes the voice
    const before = rms(withVoice, 0, synth.SR * 0.8), after = rms(withVoice, synth.SR * 3.2, synth.SR * 3.9);
    expect(before).toBeCloseTo(rms(musicOnly, 0, synth.SR * 0.8), 2);
    expect(after).toBeGreaterThan(rms(musicOnly, 0, synth.SR) * 0.9); // recovered
    const duringMusicPart = withVoice.map((v, i) => v - (tracks[0]!.samples[i - synth.SR] ?? 0) * (i >= synth.SR ? 1 : 0)) as Float32Array;
    expect(rms(duringMusicPart, synth.SR * 1.3, synth.SR * 1.8)).toBeLessThan(rms(musicOnly, synth.SR * 1.3, synth.SR * 1.8) * 0.7);
    const sfx = mixTracks([{ type: "voice", samples: tone(1, 0.6), startTime: 0, volume: 1 }, { type: "sfx", samples: tone(1, 0.2), startTime: 0, volume: 1 }], { totalSec: 1, peak: 5 });
    expect(rms(sfx, 8000, 30000)).toBeGreaterThan(0.38); // 0.6 voice + 0.2 sfx in phase: nothing was attenuated
  });
  it("only ever attenuates to the peak target and resamples 22.05 kHz voices to 44.1 kHz", () => {
    const loud = mixTracks([{ type: "sfx", samples: tone(1, 2), startTime: 0, volume: 1 }], { totalSec: 1, peak: 0.8 });
    expect(peak(loud)).toBeCloseTo(0.8, 2);
    const quiet = mixTracks([{ type: "sfx", samples: tone(1, 0.1), startTime: 0, volume: 1 }], { totalSec: 1, peak: 0.8 });
    expect(peak(quiet)).toBeCloseTo(0.1, 2);
    const w = { sampleRate: 22050, samples: Int16Array.from({ length: 22050 }, (_, i) => Math.round(8000 * Math.sin(i / 10))) };
    expect(Math.abs(toFloat44k(w).length - 44100)).toBeLessThanOrEqual(2);
  });
  it("measures speech activity per 20 ms window", () => {
    const x = new Float32Array(synth.SR * 2);
    x.set(tone(0.5, 0.5), synth.SR);
    const a = activity(x, 2);
    expect(a[10]).toBe(0);
    expect(a[60]).toBeGreaterThan(0.5);
  });
});

describe("soundtrack timeline", () => {
  let dir = "";
  beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "snd-")); });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const shot = (n: number, over: Partial<Shot> = {}): Shot => {
    const c = planCamera({ shotType: "close-up", beat: "setup", emotion: "uneasy", duration: 2, order: n });
    return { id: `shot-0${n}`, sceneId: "s", order: n, beat: "setup", duration: 2, shotType: "close-up", subjectIds: [], locationId: "l", emotion: "uneasy", action: "something", visualPrompt: "x", visualKey: "k", camera: c.camera, motion: c.motion, transition: { type: "cut" }, characterMotion: [], dialogue: [], sfx: [], ...over };
  };
  it("puts each voice line, SFX cue and automatic effect at the right absolute time, and the mix has the video's length", async () => {
    const voice = path.join(dir, "d1.wav");
    await fs.writeFile(voice, encodeWav({ sampleRate: 22050, samples: Int16Array.from({ length: 22050 }, (_, i) => Math.round(9000 * Math.sin(i / 7))) }));
    const shots = [
      shot(1, { duration: 2 }),
      shot(2, { duration: 2, dialogue: [{ id: "d1", characterId: "kai", text: "hello" }], sfx: [{ kind: "ping", at: 0.5 }], transition: { type: "zoom" } }),
      shot(3, { duration: 2, effects: { impact: true } }),
    ];
    const tl = planTimeline(shots, { d1: 1 });
    const tracks = await planSoundtrack({ shots, timeline: tl, voicePaths: { d1: voice }, dir: path.join(dir, "synth") });
    const v = tracks.filter((t) => t.type === "voice");
    expect(v).toHaveLength(1);
    expect(v[0]!.startTime).toBeCloseTo(tl.shots[1]!.start + 0.3, 6);
    const ping = tracks.find((t) => t.path.endsWith("sfx-ping.wav"))!;
    expect(ping.startTime).toBeCloseTo(tl.shots[1]!.start + 0.5, 6);
    const whoosh = tracks.find((t) => t.path.endsWith("sfx-whoosh-rise.wav"))!;
    expect(whoosh.startTime).toBeCloseTo(tl.shots[1]!.end - 0.5, 6); // zoom transition gets an automatic whoosh
    const impact = tracks.find((t) => t.path.endsWith("sfx-impact.wav"))!;
    expect(impact.startTime).toBeCloseTo(tl.shots[2]!.start, 6); // impact frame gets an automatic hit
    expect(tracks.some((t) => t.type === "music" && t.duration === tl.totalSec)).toBe(true);
    expect(tracks.some((t) => t.type === "ambient")).toBe(true);
    const out = await mixSoundtrack(tracks, tl.totalSec, path.join(dir, "mix.wav"));
    const w = parseWav(await fs.readFile(out.path));
    expect(w.samples.length / w.sampleRate).toBeCloseTo(tl.totalSec, 2);
    expect(out.peak).toBeLessThanOrEqual(0.9);
    expect(out.peak).toBeGreaterThan(0.1);
  });
  it("does not add an automatic whoosh when the director already placed one", async () => {
    const shots = [shot(1, { transition: { type: "zoom" }, sfx: [{ kind: "whoosh", at: 1 }] }), shot(2)];
    const tracks = await planSoundtrack({ shots, timeline: planTimeline(shots, {}), voicePaths: {}, dir: path.join(dir, "synth2") });
    expect(tracks.filter((t) => t.path.includes("whoosh"))).toHaveLength(1);
  });
});
