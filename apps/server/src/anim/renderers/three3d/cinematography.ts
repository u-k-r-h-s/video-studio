import type { Shot } from "@studio/shared";

/**
 * Scene-level coverage: what each shot is FOR, decided from the story (beats, dialogue, who speaks, emotion, action),
 * then a camera that serves it. Replaces the per-shot mapping "close-up -> push-in, medium -> follow" (a 2D-era rule that
 * made every close-up creep in and every medium drift) for the Three.js renderer. Pure and deterministic.
 *
 * Grammar, per scene (consecutive shots in one place):
 *  - the scene opens on the PLACE (establishing: a raised wide on the set, characters small) unless it opens mid-action;
 *  - a conversation is introduced with a TWO-SHOT (who, where, how they stand to each other);
 *  - lines are then covered by the size the author asked for: close-ups as SINGLES on the speaker's face; mediums over
 *    the listener's shoulder (OTS) when the line answers someone (shot / reverse shot), else a medium single; a speaker who keeps talking keeps their framing (no cut-for-cut variety);
 *  - a listener's strong reaction (shock, awe, sadness, anger...) gets a REACTION close-up;
 *  - after a run of tight shots the coverage returns to the two-shot (re-establish the geography);
 *  - walking / running: TRACKING from the side; a story-critical object (pump, tap, bucket, letter...): an INSERT;
 *  - push-ins only for a realisation (a strong emotion on a line, a payoff close-up); otherwise the camera holds;
 *  - transitions: a change of size on the SAME subject from about the same side (the place -> the people in it, a wide of
 *    the action -> closer on the hands, a two-shot -> the one who keeps talking) is a camera MOVE: cut, it reads as a jump.
 *    A new speaker, a reaction, an insert, a shock and a new scene are CUTS, on purpose.
 * One side of the line of action per scene (the set's open front); lenses and heights follow the purpose.
 */
export type Purpose = "establishing" | "master" | "two-shot" | "ots" | "single" | "reaction" | "insert" | "tracking";
export interface Coverage {
  purpose: Purpose;
  /** The Director's shot size this was planned from (a shot edited afterwards no longer matches its plan). */
  from: Shot["shotType"];
  shot: "wide" | "medium" | "closeup" | "over_shoulder" | "insert";
  move: "static" | "follow" | "tracking" | "push_in" | "pull_out" | "pan";
  /** Who / what the camera frames: a character id; "stage" (the set); for an insert, the object keyword. */
  target: "lead" | "speaker" | "listener" | "stage" | "object";
  /** OTS: the speaker framed past the listener's shoulder (camera behind `listener`). */
  heightOffset: number;
  fovScale: number;
  /** Angle around the subject from its facing (rad). */
  angle: number;
  /** For an insert: what to look at (pump, tap, bucket, letter, phone...). */
  object?: string;
  reason: string;
  /** How the shot begins: a hard CUT to its own composition, or a MOVE that opens on the previous shot's composition and
   *  travels to its own (the cut between the two shots is invisible: one continuous camera). */
  transition: "cut" | "move";
  transitionReason: string;
}

const STRONG = new Set(["shock", "awe", "anger", "fear", "sad", "tense"]);
const OBJECTS: [RegExp, string][] = [
  [/\b(hand ?pump|pump(s|ing|ed)?|handpump|nal)\b/i, "pump"], [/\b(tap|faucet|standpipe)\b/i, "tap"], [/\b(bucket|balti)\b/i, "bucket"],
  [/\b(letter|chitthi|note)\b/i, "letter"], [/\b(phone|mobile)\b/i, "phone"],
];
const TIGHT = new Set<Shot["shotType"]>(["close-up", "extreme-close-up", "medium-close"]);
const WIDE = new Set<Shot["shotType"]>(["wide", "medium-wide", "establishing", "high-angle", "low-angle"]);
// a close shot about a face (a smile, tears, a look) is a reaction even with the pump in the sentence
const FACE = /\b(smiles?|smiling|laughs?|cries|crying|tears|frowns?|looks?|glances?|face|eyes|stares?)\b/i;
const sceneOf = (s: Shot): string => s.sceneId || s.locationId;
const speakerOf = (s: Shot): string | undefined => s.dialogue.find((d) => d.characterId && d.characterId !== "narrator")?.characterId;
const moves = (s: Shot): boolean => (s.animation?.actions ?? []).some((a) => a.character === s.subjectIds[0] && /^(walk|run|enter|exit)$/.test(a.action));
export const objectOf = (s: Shot): string | undefined => { const t = `${s.action} ${(s.animation?.objects ?? []).map((o) => o.object).join(" ")}`; return OBJECTS.find(([re]) => re.test(t))?.[1]; };

export function planCoverage(shots: Shot[]): Coverage[] {
  const out: Coverage[] = [];
  let sceneNo = -1;
  let scene = "", convo = 0, tight = 0, prevSpeaker: string | undefined, prev: Coverage | undefined, prevEmotion = "";
  const spoken = new Set<string>();
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i]!, first = sceneOf(s) !== scene;
    if (first) { sceneNo++; scene = sceneOf(s); convo = 0; tight = 0; prevSpeaker = undefined; prev = undefined; spoken.clear(); prevEmotion = ""; }
    const sp = speakerOf(s), lead = s.subjectIds[0], two = s.subjectIds.length > 1, obj = objectOf(s);
    const strong = STRONG.has(s.emotion) && s.emotion !== prevEmotion;
    let c: Coverage;
    const mk = (purpose: Purpose, extra: Partial<Coverage> & { reason: string }): Coverage => ({ purpose, from: s.shotType, ...BASE[purpose], ...extra } as Coverage);
    const tightAsked = TIGHT.has(s.shotType), wideAsked = WIDE.has(s.shotType);
    if (!lead || (first && s.shotType === "establishing" && !sp)) {
      // the place first: a raised wide on the set; the opening of the film reveals (pull back), later scenes hold
      // the film opens with a reveal (pull back) and ends on one; between, the place is shown and held
      const end = i === shots.length - 1;
      // each scene sees the place from its own side; the last shot rises higher and wider than the opening
      c = mk("establishing", { move: i === 0 || s.beat === "hook" || end ? "pull_out" : "static", angle: end ? -0.55 : EST_ANGLES[sceneNo % EST_ANGLES.length]!, ...(end ? { heightOffset: 2.6, fovScale: 1.2 } : {}), reason: end ? "the film ends on the place" : first ? "scene opens on the place" : "a shot of the place" });
    } else if (moves(s)) {
      // a close shot of a walk tracks closer (medium), otherwise a wide keeps the way ahead in the frame
      c = mk("tracking", { ...(tightAsked ? { shot: "medium" as const, heightOffset: 0 } : {}), reason: "the character travels: tracked from the side" });
    } else if (obj && tightAsked && !sp && !FACE.test(s.action)) {
      c = mk("insert", { object: obj, reason: `the ${obj} carries the beat: an insert` });
    } else if (first && two && sp) {
      c = mk("master", { reason: "scene opens mid-conversation: a master wide with everyone" });
    } else if (sp && two) {
      const firstLine = convo === 0;
      convo++;
      // (re-establishing waits for a line the author did not ask to be close)
      if (firstLine || (tight >= 4 && !tightAsked) || wideAsked) {
        c = mk("two-shot", { reason: firstLine ? "a conversation starts: both in frame" : tight >= 4 ? "re-establish after a run of singles" : "the author asked for a wider shot" });
      } else if (sp === prevSpeaker && prev && (prev.purpose === "single" || prev.purpose === "ots")) {
        c = { ...prev, from: s.shotType, reason: "the same speaker continues: same framing (no cut-for-cut variety)" };
      } else if (tightAsked) {
        c = mk("single", { reason: "a close line: the speaker's face carries it" });
      } else if (sp !== prevSpeaker || !spoken.has(sp) || s.shotType === "over-shoulder") {
        c = mk("ots", { reason: "a new voice: over the listener's shoulder (keeps both in the geography)" });
      } else {
        c = mk("single", { shot: "medium", fovScale: 0.95, angle: 0.55, reason: "a medium single: the speaker with room around them" });
      }
      if (strong && (c.purpose === "single" || c.purpose === "ots")) c = { ...c, purpose: "single", ...BASE.single, move: "push_in", reason: `a ${s.emotion} line: a slow push-in on the speaker` };
      spoken.add(sp);
    } else if (!sp && two && strong) {
      c = mk("reaction", { reason: `the listener's ${s.emotion}: a reaction close-up` });
    } else if (sp) {
      // alone and speaking: the author's size (a medium keeps the place around them), a push-in only on a strong turn
      c = mk("single", { ...(tightAsked ? {} : { shot: "medium" as const, fovScale: 0.95, angle: 0.55 }), move: strong ? "push_in" : "static", reason: tightAsked ? "a close line, alone" : "alone and speaking: a medium single" });
    } else {
      // silent: a close-up is a look; a medium shows what the hands do; a wide shows the character in the place
      c = tightAsked ? mk("reaction", { reason: "a silent close-up: a look" })
        : wideAsked ? mk("master", { reason: "silent action in the place" })
        : mk("single", { shot: "medium", target: "lead", fovScale: 0.95, angle: 0.75, reason: "silent action: a medium on what the character does" });
    }
    // the author's explicit angle choices stay (low / high angle), and emotion tilts the camera a little
    if (s.shotType === "low-angle" || s.emotion === "anger" || s.emotion === "awe") c.heightOffset = Math.min(c.heightOffset, -0.45);
    if (s.shotType === "high-angle" || (s.emotion === "sad" && c.purpose !== "insert")) c.heightOffset = Math.max(c.heightOffset, 0.55);
    tight = c.purpose === "single" || c.purpose === "ots" || c.purpose === "reaction" ? tight + 1 : 0;
    Object.assign(c, transitionOf(c, prev, first ? undefined : shots[i - 1], s, sp, prevSpeaker));
    prevSpeaker = sp ?? prevSpeaker; prev = c; prevEmotion = s.emotion;
    out.push(c);
  }
  return out;
}

const SUDDEN = new Set(["shock", "fear", "anger"]);
const WIDER = new Set<Purpose>(["establishing", "master", "two-shot"]);
/** Cut or move into shot `s` (coverage `c`) from the previous shot of the same scene (`p`, covered by `pc`). */
function transitionOf(c: Coverage, pc: Coverage | undefined, p: Shot | undefined, s: Shot, sp: string | undefined, prevSpeaker: string | undefined): Pick<Coverage, "transition" | "transitionReason"> {
  const cut = (why: string) => ({ transition: "cut" as const, transitionReason: why });
  if (!pc || !p) return cut("a new scene");
  if (SUDDEN.has(s.emotion) && s.emotion !== p.emotion) return cut(`a ${s.emotion} beat: an instant cut`);
  if (c.purpose === "insert" || pc.purpose === "insert") return cut("into / out of a detail");
  if (c.purpose === "reaction") return cut("a reaction");
  if (c.purpose === "tracking" || pc.purpose === "tracking") return cut("travel: tracked shots are cut, not drifted into");
  if (sp && prevSpeaker && sp !== prevSpeaker) return cut("a new speaker");
  // the same composition continuing (the same speaker keeps talking): one camera, no visible cut
  if (c.purpose === pc.purpose && c.shot === pc.shot && c.target === pc.target) return { transition: "move", transitionReason: "the same framing continues" };
  // closer on the same subject: the place -> the people, a wide -> closer on what the lead does, the two -> the speaker
  const lead = s.subjectIds[0], sameSubject = !!lead && (pc.purpose === "establishing" || p.subjectIds.includes(c.target === "speaker" && sp ? sp : lead));
  if (WIDER.has(pc.purpose) && (c.purpose === "two-shot" || c.purpose === "master" || c.purpose === "single") && sameSubject && pc.purpose !== c.purpose)
    return { transition: "move", transitionReason: pc.purpose === "establishing" ? "from the place down into the scene" : `closer on the same ${c.target === "speaker" ? "speaker" : "action"}: a move, not a jump cut` };
  return cut("a new composition");
}

const EST_ANGLES = [0.35, -0.4, 0.75, -0.15];
const BASE: Record<Purpose, Omit<Coverage, "purpose" | "reason" | "from" | "transition" | "transitionReason">> = {
  establishing: { shot: "wide", move: "static", target: "stage", heightOffset: 1.5, fovScale: 1.14, angle: 0.35 },
  master: { shot: "wide", move: "static", target: "lead", heightOffset: 0.55, fovScale: 1.02, angle: 0.9 },
  "two-shot": { shot: "medium", move: "static", target: "lead", heightOffset: 0.1, fovScale: 0.95, angle: 1.05 },
  ots: { shot: "over_shoulder", move: "static", target: "listener", heightOffset: 0, fovScale: 1.0, angle: 0 },
  // singles sit off the line between the two (a frontal camera would stand behind the other character's shoulder)
  single: { shot: "closeup", move: "static", target: "speaker", heightOffset: 0, fovScale: 0.86, angle: 0.62 },
  reaction: { shot: "closeup", move: "static", target: "lead", heightOffset: -0.08, fovScale: 0.82, angle: 0.55 },
  insert: { shot: "insert", move: "static", target: "object", heightOffset: 0, fovScale: 0.9, angle: 0.55 },
  tracking: { shot: "wide", move: "follow", target: "lead", heightOffset: 0.15, fovScale: 1.0, angle: 1.6 },
};
