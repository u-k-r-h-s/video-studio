import fs from "node:fs/promises";
import path from "node:path";
import type { AudioTrack, Shot } from "@studio/shared";
import { encodeWav, parseWav } from "../lib/wav";
import { intensity } from "../shots/cameraLanguage";
import type { Timeline } from "../shots/timeline";
import { mixTracks, toFloat44k, toWav, type MixTrack } from "./mixer";
import * as synth from "./synth";

export type SfxKindName = Shot["sfx"][number]["kind"];
/** A sound implied by the animation, at a global time. */
export interface ExtraCue { kind: SfxKindName | "footsteps"; at: number; volume?: number }

/** Procedural sound effect for a kind (deterministic, no sample files). */
export function sfxSamples(kind: SfxKindName, seed = 1): synth.Buf {
  switch (kind) {
    case "whoosh": return synth.whoosh(0.55, false, seed + 7);
    case "whoosh-rise": return synth.whoosh(0.5, true, seed + 5);
    case "impact": return synth.impact(1.3, seed + 11);
    case "ping": return synth.ping(seed);
    case "ding": return synth.elevatorDing();
    case "door": return synth.doorSlide(1.7, seed + 21);
    case "footsteps": return synth.footsteps(5, 0.46, seed + 5);
    case "heartbeat": return synth.heartbeat(5, 78);
    case "riser": return synth.riser(2.2, seed + 9);
    case "glitch": return synth.glitch(0.4, seed + 13);
  }
}

const DEFAULT_VOLUME: Record<SfxKindName, number> = { whoosh: 0.5, "whoosh-rise": 0.5, impact: 0.85, ping: 0.55, ding: 0.5, door: 0.5, footsteps: 0.5, heartbeat: 0.6, riser: 0.55, glitch: 0.45 };

export interface SoundtrackPlan {
  tracks: AudioTrack[];
  /** Absolute paths of the WAVs written for synthesized elements, keyed by track path. */
  files: Map<string, synth.Buf>;
}

/**
 * Builds the audio timeline: voice lines (already synthesised files), SFX from each shot's cues plus automatic ones
 * (whoosh into a zoom transition, impact on flash/impact frames), a looping ambience, and a tension bed whose
 * intensity follows the story (derived from each shot's beat/emotion/action).
 */
export async function planSoundtrack(opts: { shots: Shot[]; timeline: Timeline; voicePaths: Record<string, string>; dir: string; musicVolume?: number; ambientVolume?: number; extraCues?: ExtraCue[]; rain?: boolean }): Promise<AudioTrack[]> {
  const { shots, timeline, dir } = opts;
  await fs.mkdir(dir, { recursive: true });
  const tracks: AudioTrack[] = [];
  const writeSynth = async (name: string, buf: synth.Buf): Promise<string> => {
    const p = path.join(dir, `${name}.wav`);
    await fs.writeFile(p, encodeWav(toWav(buf)));
    return p;
  };

  for (const st of timeline.shots) for (const l of st.lines) {
    const p = opts.voicePaths[l.dialogueId];
    if (!p) throw new Error(`no voice file for ${l.dialogueId}`);
    tracks.push({ type: "voice", path: p, startTime: l.start, volume: 1 });
  }

  // intensity curve over time: piecewise-linear through each shot's mid-point
  const pts = shots.map((s, i) => ({ t: timeline.shots[i]!.start + timeline.shots[i]!.duration / 2, v: intensity(s.emotion, s.beat, s.action) }));
  const I = (t: number): number => {
    if (t <= pts[0]!.t) return pts[0]!.v;
    for (let k = 1; k < pts.length; k++) if (t <= pts[k]!.t) { const a = pts[k - 1]!, b = pts[k]!; return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t); }
    return pts[pts.length - 1]!.v;
  };
  const total = timeline.totalSec;
  tracks.push({ type: "music", path: await writeSynth("music-tension", synth.tensionBed(total, (t) => Math.min(1, 0.15 + I(t) * 1.1))), startTime: 0, duration: total, volume: opts.musicVolume ?? 0.42 });
  tracks.push({ type: "ambient", path: await writeSynth("ambient-night", synth.ambientNight(total)), startTime: 0, duration: total, volume: opts.ambientVolume ?? 0.3 });

  const seen = new Set<string>();
  const addSfx = async (kind: SfxKindName, at: number, volume?: number): Promise<void> => {
    const key = `sfx-${kind}`;
    const p = path.join(dir, `${key}.wav`);
    if (!seen.has(key)) { await fs.writeFile(p, encodeWav(toWav(sfxSamples(kind)))); seen.add(key); }
    tracks.push({ type: "sfx", path: p, startTime: Math.max(0, at), volume: volume ?? DEFAULT_VOLUME[kind] });
  };
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i]!, st = timeline.shots[i]!;
    const explicit = new Set(s.sfx.map((x) => x.kind));
    for (const x of s.sfx) await addSfx(x.kind, st.start + x.at, x.volume);
    if (s.transition.type === "zoom" && i < shots.length - 1 && !explicit.has("whoosh") && !explicit.has("whoosh-rise")) await addSfx("whoosh-rise", st.end - 0.5);
    if ((s.effects?.impact || s.effects?.flash) && !explicit.has("impact")) await addSfx("impact", st.start);
  }
  // sounds implied by the animation itself: footsteps on foot contacts, doors, impacts (global times)
  for (const q of opts.extraCues ?? []) {
    if (q.kind === "footsteps") {
      const p = path.join(dir, "sfx-step.wav");
      if (!seen.has("sfx-step")) { await fs.writeFile(p, encodeWav(toWav(synth.footsteps(1, 0.5, 5)))); seen.add("sfx-step"); }
      tracks.push({ type: "sfx", path: p, startTime: Math.max(0, q.at), volume: q.volume ?? 0.32 });
    } else await addSfx(q.kind, q.at, q.volume);
  }
  if (opts.rain) tracks.push({ type: "ambient", path: await writeSynth("ambient-rain", synth.normalize(synth.bandpass(synth.whiteNoise(total, 3), 1800, 7500), 0.5)), startTime: 0, duration: total, volume: 0.16 });
  return tracks;
}

/** Reads every track file and mixes the whole timeline to one mono 44.1 kHz WAV (ducking music/ambience under speech). */
export async function mixSoundtrack(tracks: AudioTrack[], totalSec: number, outPath: string): Promise<{ path: string; peak: number }> {
  const mt: MixTrack[] = [];
  for (const t of tracks) {
    const w = parseWav(await fs.readFile(t.path));
    const samples = w.sampleRate === synth.SR ? Float32Array.from(w.samples, (v) => v / 32768) : toFloat44k(w);
    mt.push({ type: t.type, samples, startTime: t.startTime, duration: t.duration, volume: t.volume, fadeIn: t.type === "music" || t.type === "ambient" ? 0.4 : undefined, fadeOut: t.type === "music" || t.type === "ambient" ? 0.9 : undefined });
  }
  const mix = mixTracks(mt, { totalSec, duck: 0.6 });
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, encodeWav(toWav(mix)));
  let peak = 0;
  for (const v of mix) peak = Math.max(peak, Math.abs(v));
  return { path: outPath, peak };
}
