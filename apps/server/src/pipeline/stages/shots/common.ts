import { NARRATOR_ID, sceneId, voiceAudioId, type Character, type FormatProfile, type Project, type Scene, type Shot, type Story } from "@studio/shared";
import { StageOrderError } from "../../../errors";
import { findAudio } from "../../assets";
import { planTimeline, type Timeline } from "../../../shots/timeline";
import type { MediaTools, PipelineServices, Scope } from "../../types";

export function storyOf(p: Project): Story {
  if (!p.story) throw new StageOrderError("This project has no shot list yet. Plan the story first.");
  return p.story;
}

export function cinematicOf(profile: FormatProfile): NonNullable<FormatProfile["cinematic"]> {
  if (!profile.cinematic) throw new StageOrderError(`Format profile "${profile.id}" has no cinematic settings.`);
  return profile.cinematic;
}

export function mediaOf(svc: PipelineServices): MediaTools {
  if (!svc.media) throw new StageOrderError("The shot pipeline needs the media tools (ffmpeg, caption helper), which are not configured.");
  return svc.media;
}

/** Shots of the scenes in scope (a scene is a run of shots in one location). */
export const shotsInScope = (story: Story, scope: Scope): Shot[] => story.shots.filter((s) => !scope.sceneIds || scope.sceneIds.includes(s.sceneId));

/**
 * The scene list the rest of the app (review screen, scene regeneration, status) works with, derived from the story:
 * one scene per run of shots in one location. Scene ids come from the story so `regenerateScene` addresses them.
 */
export function scenesFromStory(story: Story, characters: Character[]): Scene[] {
  const known = new Set(characters.map((c) => c.id));
  return story.scenes.map((sc, i) => {
    const shots = story.shots.filter((s) => s.sceneId === sc.id);
    const loc = story.locations.find((l) => l.id === sc.locationId);
    const dialogue = shots.flatMap((s) => s.dialogue.map((d) => ({ id: d.id, characterId: d.characterId, text: d.text })));
    const chars = [...new Set([...shots.flatMap((s) => s.subjectIds), ...dialogue.map((d) => d.characterId)])].filter((c) => c !== NARRATOR_ID && known.has(c)).slice(0, 4);
    return {
      id: sceneId(i + 1), order: i + 1, duration: Math.max(1, Math.min(60, Math.round(shots.reduce((s, x) => s + x.duration, 0) * 10) / 10)),
      location: loc?.name ?? sc.locationId, visualDescription: shots.map((s) => s.action).join(" ").slice(0, 500) || sc.summary,
      dialogue: dialogue.slice(0, 8), characters: chars, props: [], camera: { movement: "static" as const, shot: "medium" as const }, motion: { entrance: "none" as const, emphasis: "none" as const },
      generatedAssets: [], status: "planned" as const,
    };
  });
}

/** The edit timeline from the real voice durations. Throws when a voice is missing. */
export function timelineOf(p: Project, story: Story): Timeline {
  const durations: Record<string, number> = {};
  for (const s of story.shots) for (const d of s.dialogue) {
    const a = findAudio(p, voiceAudioId(d.id));
    if (!a) throw new StageOrderError(`The voice for ${s.id} is missing. Generate voices first.`);
    durations[d.id] = a.durationSec;
  }
  return planTimeline(story.shots, durations);
}
