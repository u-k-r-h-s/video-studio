import type { Shot, ShotAnimAction, ShotObjectAction } from "@studio/shared";

/**
 * The director's sentence ("Kai walks toward the building, the door creaks open") already says what moves. A small model often
 * writes the sentence and forgets to fill the structured `actions`/`objects`, so the physical verbs are also read from the
 * sentence, with fixed rules. Everything here is semantic ("walk", "toward the door"): no pixels, seconds or coordinates.
 */
const LOCOMOTION = new Set(["walk", "run", "enter", "exit"]);

const VERBS: [RegExp, ShotAnimAction["action"]][] = [
  [/\b(raises?|raising|lifts?|holds? up|shines?|shining|aims?|aiming|points?|pointing|sweeps?|switch(?:es)? on|turns? on) (?:up )?(?:the |his |her |their |a )?(?:flashlight|torch|lantern|lamp|light beam|beam)\b/i, "raise-object"],
  [/\b(lowers?|lowering|drops?) (?:the |his |her |their )?(?:flashlight|torch|lantern)\b/i, "lower-object"],
  [/\b(raises?|lifts?|throws? up) (?:a |his |her |their |both )?(?:hand|hands|arm|arms)\b/i, "raise-hand"],
  [/\b(waves?|waving)\b/i, "wave"],
  [/\b(reach(?:es|ing)? (?:for|toward|towards|out)|grabs?|picks? up)\b/i, "reach"],
  [/\b(push(?:es|ing)?|shoves?|forces?) (?:open )?(?:the |a )?(?:heavy |old |wooden |metal |iron )?(?:door|gate|hatch)\b/i, "push"],
  [/\b(pulls?|pulling|yanks?) (?:open )?(?:the |a )?(?:heavy |old |wooden |metal |iron )?(?:door|gate|hatch)\b/i, "pull"],
  [/\b(checks?|checking|looks? at|stares? at|reads?|reading|glances? at) (?:his |her |their |the |a )?(?:phone|screen|message|watch)\b/i, "hold-phone"],
  [/\b(listens?|listening|stops? to listen|freezes? to listen)\b/i, "listen"],
  [/\b(press(?:es|ing)?|rings?|ringing|pushes|buzz(?:es)?) (?:the |a )?(?:door ?bell|bell|buzzer|button|intercom)\b/i, "press"],
  [/\b(adjusts?|adjusting|shifts?|hitches?|re-?grips?) (?:the |his |her |their |a )?(?:package|parcel|box|bag|grip)\b/i, "adjust"],
  [/\b(hesitates?|hesitating|pauses?|pausing|waits?|waiting|holds? (?:his|her|their) breath)\b/i, "hesitate"],
  [/\b(looks?|glances?|checks?|reads?|peers?) (?:at |up at )?(?:the |a )?(?:address|house number|number|sign|label|door number)\b/i, "head-turn"],
  [/\b(run|runs|running|sprint|sprints|sprinting|dash|dashes|rush|rushes|flee|flees|fleeing|bolts?|races|racing)\b/i, "run"],
  [/\b(walk|walks|walking|stride|strides|stroll|strolls|creep|creeps|creeping|tiptoe|tiptoes|sneak|sneaks|follows?|following|heads? (?:down|toward|towards|into|along|for)|approach(?:es|ing)?|advances?|marches|steps? (?:into|toward|towards|down|through|inside)|moves? (?:down|toward|towards|into|along|through)|makes? (?:his|her|their) way|heading)\b/i, "walk"],
  [/\b(enters?|entering|steps? in(?:side)?|comes? in)\b/i, "enter"],
  [/\b(exits?|leaves?|leaving|steps? out|storms? out)\b/i, "exit"],
  [/\b(steps?|stumbles?|jumps?|jumping|recoils?|backs?|staggers?|flinch(?:es)?) (?:back|away)\b/i, "step-back"],
  [/\b(steps? forward|leans? in|moves? closer|edges? closer)\b/i, "step-forward"],
  [/\b(turns? (?:around|back|away|to face|toward|towards)|spins?|whirls?|swings? around)\b/i, "turn"],
  [/\b(looks? (?:back|over (?:his|her|their) shoulder)|glances? back)\b/i, "head-turn"],
  [/\b(looks?|gazes?|stares?|glances?|peers?|peeks?) up\b/i, "look-up"],
  [/\b(looks?|gazes?|stares?|glances?|peers?|peeks?) down\b|\b(checks?|reads?|looks? at) (?:his|her|their|the) (?:phone|watch|screen|message)\b/i, "look-down"],
  [/\b(looks?|gazes?|glances?|peers?|peeks?) (?:to the |toward the |towards the )?left\b/i, "look-left"],
  [/\b(looks?|gazes?|glances?|peers?|peeks?) (?:to the |toward the |towards the )?right\b/i, "look-right"],
  [/\b(nods?|nodding)\b/i, "nod"],
  [/\b(shakes? (?:his|her|their) head)\b/i, "shake-head"],
  [/\b(points?|pointing)\b/i, "point"],
  [/\b(freezes?|freezing|gasps?|startled|startles?)\b/i, "surprise"],
  [/\b(smiles?|smiling|grins?)\b/i, "smile"],
  [/\b(trembles?|trembling|shivers?|cowers?)\b/i, "fear"],
];

const TARGET = /\b(?:toward|towards|into|down|along|through|to|at|for)\s+(?:the\s+|a\s+|an\s+|his\s+|her\s+|their\s+)?([a-z-]+(?:\s[a-z-]+)?)/i;

/** "walks toward the building" -> "the building"; absent -> undefined. */
function targetOf(text: string): string | undefined {
  const m = TARGET.exec(text);
  if (!m) return undefined;
  const words = m[1]!.toLowerCase().split(/\s+/).filter((w) => !/^(and|then|as|while|but|with|his|her|their|slowly|quickly|nervously|carefully)$/.test(w));
  return words.length ? `the ${words.slice(0, 2).join(" ")}` : undefined;
}

const WHEN_ORDER: ShotAnimAction["when"][] = ["start", "early", "mid", "late", "end"];

/** Verbs in the sentence, in the order they appear, as actions. */
export function actionsFromText(text: string): ShotAnimAction[] {
  const hits: { at: number; a: ShotAnimAction["action"] }[] = [];
  for (const [re, a] of VERBS) {
    const m = re.exec(text);
    if (m) hits.push({ at: m.index, a });
  }
  hits.sort((x, y) => x.at - y.at);
  const seen = new Set<string>();
  const ordered = hits.filter((h) => (seen.has(h.a) ? false : (seen.add(h.a), true))).slice(0, 3);
  return ordered.map((h, i) => {
    const after = text.slice(h.at);
    const named = /(door ?bell|buzzer|button|intercom)/i.test(after) && h.a === "press" ? "the doorbell" : /(address|house number|door number|sign|label)/i.test(after) && h.a === "head-turn" ? "the address" : undefined;
    const toward = named ?? (LOCOMOTION.has(h.a) || h.a === "turn" || h.a === "look-up" || h.a === "point" ? targetOf(after) : undefined);
    return { character: "", action: h.a, when: WHEN_ORDER[Math.min(4, Math.round((i * 4) / Math.max(1, ordered.length)))]!, ...(toward ? { toward } : {}) };
  });
}

const OBJECTS: { noun: RegExp; name: string; verbs: [RegExp, ShotObjectAction["action"][]][] }[] = [
  { noun: /\b(door|doors|doorway|gate|hatch)\b/i, name: "door", verbs: [[/\b(opens?|opened|opening|ajar|swings? open|creaks? open|pushes? open|slides? open|unlocks?|cracks? open|flung open)\b/i, ["open"]], [/\b(slams?|closes?|closed behind|shuts?|slammed|locks?)\b/i, ["close"]]] },
  { noun: /\b(phone|smartphone|screen|message|notification)\b/i, name: "phone", verbs: [[/\b(buzz(?:es|ing)?|rings?|ringing|vibrat\w+)\b/i, ["shake", "glow"]], [/\b(lights? up|glow(?:s|ing)?|flashes|shows?|displays?|flickers?)\b/i, ["glow"]]] },
  { noun: /\b(flashlight|torch)\b/i, name: "flashlight", verbs: [[/\b(raises?|lifts?|shines?|aims?|points?|sweeps?|switch(?:es)? on|turns? on|flickers?|glows?|beam)\b/i, ["glow"]], [/\b(holds?|holding|carries|carrying|grips?)\b/i, ["hold"]]] },
  { noun: /\b(lamp|light|lantern|bulb|candle)\b/i, name: "light", verbs: [[/\b(flicker(?:s|ing)?|buzz(?:es|ing)?|dims?|flashes)\b/i, ["flicker"]]] },
];

/** Objects that move according to the sentence ("the door creaks open" -> door: open). */
export function objectsFromText(text: string): ShotObjectAction[] {
  const out: ShotObjectAction[] = [];
  for (const o of OBJECTS) {
    if (!o.noun.test(text)) continue;
    for (const [re, acts] of o.verbs) {
      if (!re.test(text)) continue;
      acts.forEach((action, i) => out.push({ object: o.name, action, when: action === "close" ? "late" : i === 0 && action === "shake" ? "start" : "early" }));
      break;
    }
  }
  return out;
}

const WIDE_PREF: Partial<Record<Shot["shotType"], number>> = { wide: 3, establishing: 3, tracking: 3, action: 3, medium: 3, "over-shoulder": 2, "medium-close": 2, "low-angle": 2, "high-angle": 2, pov: 1, "close-up": 1, "extreme-close-up": 0 };

/**
 * Fills the animation of every shot with a character: model actions first, then verbs from the sentence; then makes sure a
 * film is not a row of people standing still: at least a quarter of the character shots travel (walk/run/enter/exit), picked from
 * the shots best able to show it (wide and medium, not a shocked close-up), always in the same screen direction so the
 * character is visibly going somewhere.
 */
export function enrichAnimation(shots: Shot[]): Shot[] {
  const out = shots.map((s) => {
    if (!s.subjectIds.length) {
      const objs = mergeObjects(s.animation?.objects ?? [], objectsFromText(s.action));
      return objs.length ? { ...s, animation: { actions: [], objects: objs.slice(0, 3) } } : s;
    }
    const who = s.subjectIds[0]!;
    const model = (s.animation?.actions ?? []).map((a) => ({ ...a, character: who }));
    const fromText = actionsFromText(s.action).map((a) => ({ ...a, character: who }));
    const have = new Set(model.map((a) => a.action));
    const classOf = (a: string): string => (LOCOMOTION.has(a) ? "move" : a);
    const haveClass = new Set(model.map((a) => classOf(a.action)));
    const added = fromText.filter((a) => !have.has(a.action) && !haveClass.has(classOf(a.action)));
    const actions = [...model, ...added].slice(0, 3);
    const objects = mergeObjects(s.animation?.objects ?? [], objectsFromText(s.action)).slice(0, 3);
    return actions.length || objects.length ? { ...s, animation: { actions, objects } } : s;
  });

  const withChar = out.filter((s) => s.subjectIds.length);
  const travels = (s: Shot): boolean => !!s.animation?.actions.some((a) => LOCOMOTION.has(a.action));
  const need = Math.max(2, Math.ceil(withChar.length * 0.25));
  let have = withChar.filter(travels).length;
  if (have >= need) return out;
  const score = (s: Shot): number => (WIDE_PREF[s.shotType] ?? 1) * 2 + (s.beat === "setup" || s.beat === "curiosity" || s.beat === "conflict" ? 1 : 0) - (s.emotion === "shock" || s.emotion === "fear" ? 2 : 0) - (s.animation?.actions.some((a) => a.action === "step-back") ? 2 : 0);
  const candidates = withChar.filter((s) => !travels(s)).sort((a, b) => score(b) - score(a) || a.order - b.order);
  const picked = new Set<string>();
  for (const c of candidates) {
    if (have >= need) break;
    if (score(c) < 2) continue; // never turn an extreme close-up or a startled reaction into a walk
    picked.add(c.id);
    have++;
  }
  return out.map((s) => {
    if (!picked.has(s.id)) return s;
    const who = s.subjectIds[0]!;
    const rest = (s.animation?.actions ?? []).filter((a) => a.action !== "idle");
    const walk: ShotAnimAction = { character: who, action: "walk", when: "start", toward: "right" };
    return { ...s, animation: { actions: [walk, ...rest].slice(0, 3), objects: s.animation?.objects ?? [] } };
  });
}

function mergeObjects(a: ShotObjectAction[], b: ShotObjectAction[]): ShotObjectAction[] {
  const out = [...a];
  for (const o of b) if (!out.some((x) => x.object === o.object && x.action === o.action)) out.push(o);
  return out;
}

/**
 * The director's action-first slots, each a few plain words: what the character does to travel ("walk to the door"), what the hands
 * do ("raise the flashlight", "push the door open", "check the phone") and how they react ("stop and listen", "step back in fear").
 * Turned into semantic actions/objects with the same verb rules; slots are timed in order: travel early, hands in the middle, reaction late.
 */
export function slotsToAnimation(slots: { move?: string; gesture?: string; reaction?: string }): { actions: ShotAnimAction[]; objects: ShotObjectAction[] } {
  const actions: ShotAnimAction[] = [], objects: ShotObjectAction[] = [];
  const none = (t?: string): boolean => !t || /^(none|no|nothing|n\/a|-|stands? still|idle)$/i.test(t.trim());
  const take = (text: string | undefined, when: ShotAnimAction["when"]): void => {
    if (none(text)) return;
    for (const a of actionsFromText(text!).slice(0, 2)) if (!actions.some((x) => x.action === a.action)) actions.push({ ...a, when: actions.length && when === "start" ? "early" : when });
    for (const o of objectsFromText(text!)) if (!objects.some((x) => x.object === o.object && x.action === o.action)) objects.push({ ...o, when: when === "start" ? "early" : when });
  };
  take(slots.move, "start");
  take(slots.gesture, "mid");
  take(slots.reaction, "late");
  return { actions: actions.slice(0, 3), objects: objects.slice(0, 3) };
}
