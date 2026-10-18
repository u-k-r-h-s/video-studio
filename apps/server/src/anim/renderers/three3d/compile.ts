import type { Character, Location, Shot, ShotAnimAction, Story } from "@studio/shared";
import { DEFAULT_DURATION, placeAction } from "../../actions";
import { classifyProp, impliedActions } from "../../semantics";
import type { ArtStyle } from "./artStyle";
import type { SceneDirection, ShotDirection } from "./visualPlan";
import { objectOf } from "./cinematography";
import type { Action3D, CameraSpec3D, CharacterEvent3D, CharacterSpec3D, Expression, InteractionSpec3D, LightingPreset, PropSpec3D, SetObject3D, Shot3DSpec, SpeechSpec3D } from "./spec";

/**
 * The 3D animation compiler: the Director's shot (semantic actions, objects, shot size, camera motion, emotion) -> a
 * Shot3DSpec. The same shot JSON drives the 2D compiler (anim/compose.ts); only HOW it is shown differs. Fixed rules, no
 * model output is trusted for numbers: where the character starts, how far a walk goes, when each action happens
 * (`when` -> seconds via the shared placeAction), which prop goes in which hand, how the camera frames it.
 */
export interface Cast3D {
  /** 3D character asset key for a story character (assets/3d/characters/<key>/character.glb). */
  asset: string;
  wardrobe?: Record<string, string>;
  /** Props the character always carries (a courier bag). */
  props?: PropSpec3D[];
}
export interface Compile3DInput {
  shot: Shot;
  story: Pick<Story, "locations">;
  characters: Character[];
  duration: number;
  width: number;
  height: number;
  fps: number;
  seed: number;
  cast: (c: Character) => Cast3D;
  /** AI-painted plate for the location (image key resolved by the renderer host), if any. */
  backdrop?: (l: Location) => string | undefined;
  wallTexture?: (l: Location) => string | undefined;
  /** Shot index in its scene (continuity: the second shot of a scene starts where the action left off). */
  indexInScene?: number;
  /** Scene blocking: the characters of this scene in order of first appearance. Each keeps ONE mark for the whole scene
   *  (whoever speaks), so a cut never moves anyone; bodies face the group, heads turn to the speaker. */
  scene?: { order: string[]; before?: string[]; carry?: Record<string, { x: number; z: number; heading: number }> };
  /** Lip-sync per character id: the lines spoken in this shot (shot-local times). */
  speech?: Record<string, SpeechSpec3D[]>;
  /** The previous shot's camera when it is in the same scene: a planned MOVE opens on it (an invisible cut). */
  prevCamera?: CameraSpec3D;
  /** The story's visual plan for this shot's location and this shot (visualPlan.ts); without it the place's words decide. */
  direction?: { location: SceneDirection; shot?: ShotDirection; style: ArtStyle };
}

/** The face that goes with a story emotion. */
export function expressionOf(e: Shot["emotion"]): Expression {
  return ({ joy: "happy", sad: "sad", anger: "angry", fear: "fear", shock: "surprised", awe: "surprised", tense: "worried", uneasy: "worried", eerie: "worried" } as Partial<Record<Shot["emotion"], Expression>>)[e] ?? "neutral";
}

const NOMINAL_WALK = 1.3; // m/s, close to typical walk clips; the runtime calibrates the real speed and arrives anyway
const DOOR = { x: 0, z: -8 };

/** Lighting from the Director's timeOfDay/weather when present, else from the place's words. Never "dark story -> night". */
export function lightingFor(l: Pick<Location, "visualIdentity" | "lighting" | "description"> & Partial<Pick<Location, "timeOfDay" | "weather">>): LightingPreset {
  const t = `${l.visualIdentity} ${l.lighting} ${l.description}`.toLowerCase();
  const interior = /(interior|inside a|room|kitchen|office|lobby|corridor|hallway|bedroom|living room|shop interior)/.test(t);
  const tod = l.timeOfDay ?? (/(midnight|night|moonlight|moonlit|after dark)/.test(t) ? "night" : /(sunset|dusk)/.test(t) ? "sunset" : /(golden hour|golden light|late afternoon)/.test(t) ? "golden_hour" : /(morning|dawn|sunrise)/.test(t) ? "morning" : /(dark|neon)/.test(t) ? "night" : "day");
  const wx = l.weather ?? (/(rain|storm|wet|drizzle)/.test(t) ? "rain" : /(overcast|grey sky|gray sky)/.test(t) ? "overcast" : /(cloud)/.test(t) ? "cloudy" : /(fog|mist)/.test(t) ? "fog" : "sunny");
  if (interior) return tod === "night" || tod === "sunset" ? (/(cold|blue|fluorescent|neon)/.test(t) ? "cold-interior" : "warm-interior") : "indoor-daylight";
  if (tod === "night") return wx === "rain" ? "rainy-night" : /(horror|eerie|creepy|ghost|abandoned|warehouse|alley)/.test(t) ? "cinematic-night" : "night";
  if (tod === "sunset") return "sunset";
  if (tod === "golden_hour" || tod === "morning") return wx === "rain" ? "rainy-day" : "golden-hour";
  if (wx === "rain") return "rainy-day";
  if (wx === "overcast" || wx === "fog") return "overcast";
  if (wx === "cloudy") return "cloudy-day";
  return "sunny-day";
}

/** Which set kit fits the place. */
export function kitFor(l: Pick<Location, "visualIdentity" | "description" | "name">): "warehouse-exterior" | "neighborhood" {
  const t = `${l.name} ${l.visualIdentity} ${l.description}`.toLowerCase();
  if (/(warehouse|factory|industrial|dock|depot|hangar|plant|loading bay|garage)/.test(t)) return "warehouse-exterior";
  return "neighborhood";
}

/** Conversation marks around the meeting point (metres, x along the set, z toward the camera): a shallow arc open to the
 *  camera. Index = order of first appearance in the scene. */
export const SCENE_MARKS: [number, number][] = [[-1.15, 0], [0, 0.45], [1.1, 0.3], [2.1, -0.1], [3.0, -0.5]];

const CAMERA_SHOT: Record<Shot["shotType"], CameraSpec3D["shot"]> = {
  establishing: "wide", wide: "wide", "medium-wide": "wide", "low-angle": "wide", "high-angle": "wide", tracking: "wide", action: "medium",
  medium: "medium", "medium-close": "closeup", "close-up": "closeup", "extreme-close-up": "closeup", "over-shoulder": "over_shoulder", pov: "over_shoulder",
};
const CAMERA_MOVE: Record<Shot["motion"]["type"], CameraSpec3D["move"]> = {
  static: "static", "push-in": "push_in", "pull-out": "pull_out", pan: "pan", tilt: "tilt", tracking: "tracking", shake: "handheld", parallax: "follow", action: "handheld",
};

/** Where an action is directed: a named point of the set kit (door, door-front, doorway, doorbell, address, approach, camera) or a position. */
function targetOf(a: Pick<ShotAnimAction, "toward" | "to" | "action">, here: { x: number; z: number }): CharacterEvent3D["target"] {
  const t = (a.toward ?? "").toLowerCase();
  if (a.to === "camera" || /(camera|viewer|us\b)/.test(t)) return "camera";
  if (/(bell|buzzer|button|intercom)/.test(t)) return "doorbell";
  if (/(address|number|sign|label|plate)/.test(t)) return "address";
  if (/(door|entrance|gate|building|warehouse|house|home|porch|inside|in there)/.test(t)) return a.action === "walk" || a.action === "run" || a.action === "enter" ? "door-front" : /(inside|in there|interior)/.test(t) ? "doorway" : "door";
  if (a.to === "left" || /\bleft\b/.test(t)) return { x: here.x - 3, z: here.z - 1, y: 1.5 };
  if (a.to === "right" || /\bright\b/.test(t)) return { x: here.x + 3, z: here.z - 1, y: 1.5 };
  if (/(away|back|behind|street|road|along|lane|gali)/.test(t)) return { x: here.x + 1.5, z: here.z + 7 };
  if (/(sound|noise|voice|shadow|figure|dark)/.test(t)) return "doorway";
  // leaving with nowhere named: off along the set, not into the house (the doorway is a point behind the wall)
  if (a.action === "exit") return { x: here.x - 8, z: here.z + 0.4 };
  return a.action === "walk" || a.action === "run" ? "door-front" : "doorway";
}

const ACTION_MAP: Partial<Record<ShotAnimAction["action"], Action3D>> = {
  idle: "idle", walk: "walk", run: "run", enter: "walk", exit: "run", turn: "turn", "look-left": "look", "look-right": "look", "look-up": "look", "look-down": "look",
  "look-center": "look", "head-turn": "look", nod: "nod", "shake-head": "shake-head", "step-forward": "walk", "step-back": "step-back", "hand-gesture": "wave",
  point: "point", react: "react", surprise: "surprise", fear: "fear", smile: "idle", "raise-hand": "wave", wave: "wave", reach: "reach",
  push: "push", pull: "pull", "raise-object": "raise", "lower-object": "lower", "hold-phone": "hold", listen: "look-around", press: "press", adjust: "adjust", hesitate: "hesitate",
};

export function compileShot3D(inp: Compile3DInput): { spec: Shot3DSpec; notes: string[] } {
  const { shot, duration: D } = inp;
  const notes: string[] = [];
  const loc = inp.story.locations.find((l) => l.id === shot.locationId) ?? inp.story.locations[0]!;
  const who = shot.subjectIds[0] ? inp.characters.find((c) => c.id === shot.subjectIds[0]) : undefined;
  const actions = who ? impliedActions(shot) : [];
  const objects = shot.animation?.objects ?? [];
  const dir = inp.direction;
  const lighting = dir?.location.lighting ?? lightingFor(loc);
  const kit: SceneDirection["kit"] = dir?.location.kit ?? kitFor(loc);
  // every set except the warehouse stages like a street: a lane / sidewalk in front of a facade with a door
  const street = kit !== "warehouse-exterior";
  const text = `${loc.visualIdentity} ${loc.lighting} ${loc.description}`.toLowerCase();
  const night = /night|outage/.test(lighting) || lighting.includes("interior") && !lighting.includes("daylight");
  const rainy = dir ? dir.location.rain > 0 : loc.weather === "rain" || lighting.includes("rain") || (!loc.weather && /(rain|storm|wet|drizzle)/.test(text));
  const r = mulberry(inp.seed);

  // the set: a facade with a working door (a warehouse bay or a house front), a few props that support the shot
  const doorEvents: NonNullable<SetObject3D["events"]> = [];
  const objs: SetObject3D[] = [{ id: "door", kind: "door", x: DOOR.x, z: DOOR.z, params: { width: kit === "neighborhood" ? 1.1 : 2.6, height: kit === "neighborhood" ? 2.15 : 3.3, hinge: "left", glow: kit === "neighborhood" ? "#ffd9a6" : "#ffb46a", cold: "#6f9dff" }, events: doorEvents }];
  if (kit === "warehouse-exterior") {
    objs.push(
      { id: "lamp", kind: "lamp", x: DOOR.x, y: 4.25, z: DOOR.z + 0.55, params: { color: "#ffc98a", intensity: night ? 240 : 0, off: !night }, events: night && (/(flicker|broken|dying)/.test(text) || shot.emotion === "eerie") ? [{ at: 0, action: "flicker" }] : [] },
      { id: "crates", kind: "crate", x: 3.2 + r() * 0.6, z: DOOR.z + 1.2, rotation: r() }, { id: "crates2", kind: "crate", x: 4.1 + r() * 0.4, z: DOOR.z + 0.9, rotation: r(), scale: 0.85 },
      { id: "barrel", kind: "barrel", x: -3.0, z: DOOR.z + 1.0 }, { id: "barrel2", kind: "barrel", x: -3.6, z: DOOR.z + 1.5, params: { color: "#5a3a28" } },
      { id: "pallet", kind: "pallet", x: -2.2, z: DOOR.z + 2.6, rotation: 0.4 }, { id: "dumpster", kind: "dumpster", x: 6.5, z: DOOR.z + 2.2, rotation: -0.3 },
    );
  } else if (kit === "neighborhood") {
    objs.push(
      { id: "mailbox", kind: "mailbox", x: DOOR.x + 1.3, z: 1.7, params: { color: ["#2d4f86", "#b8312f", "#2e5a3a"][Math.floor(r() * 3)]! } },
      { id: "car", kind: "car", x: DOOR.x + 6.5, z: 6.2, params: { color: ["#b8312f", "#2d6fa8", "#e0b03a", "#e8e8e8"][Math.floor(r() * 4)]! } },
      { id: "streetlamp", kind: "streetlamp", x: DOOR.x - 7.5, z: 3.7 },
    );
  }

  const characters: CharacterSpec3D[] = [];
  // other characters on screen (a conversation): staged around the lead, see below
  const partners = shot.subjectIds.slice(1).map((id) => inp.characters.find((c) => c.id === id)).filter((c): c is Character => !!c);
  const partnerNamed = (a: Pick<ShotAnimAction, "toward">): Character | undefined => {
    const t = (a.toward ?? "").toLowerCase();
    return t ? partners.find((p) => t.includes(p.id) || t.includes(p.name.toLowerCase()) || p.name.toLowerCase().split(/\s+/).some((w) => w.length > 2 && t.includes(w))) : undefined;
  };
  // who speaks when: each visible character gets its own lines (lips) and the others' lines (listening)
  const speaking = (id: string): Pick<CharacterSpec3D, "speech" | "listen"> => {
    const own = inp.speech?.[id] ?? [];
    const others = Object.entries(inp.speech ?? {}).filter(([k]) => k !== id).flatMap(([, v]) => v.map((x) => ({ at: x.at, duration: x.duration })));
    return { ...(own.length ? { speech: own.map((x) => ({ ...x, expression: x.expression ?? expressionOf(shot.emotion) })) } : {}), ...(others.length ? { listen: others } : {}) };
  };
  if (who) {
    const cast = inp.cast(who);
    const movers = actions.filter((a) => a.action === "walk" || a.action === "run" || a.action === "enter");
    const mover = movers[0];
    const walkTime = mover ? placeAction(mover.when, 0, D) : null;
    const walkTo = movers.map(partnerNamed).find(Boolean);
    // a long spoken shot does not walk the character off the set: it arrives and the conversation plays out
    const travel = mover ? Math.min(walkTo ? 5 : 7, Math.max(2.5, (mover.action === "run" ? 3.2 : NOMINAL_WALK) * (D - (walkTime?.start ?? 0)) * 0.72)) : 0;
    // where a walked-to partner waits: on the sidewalk in front of the house (street) / in front of the bay (warehouse)
    // (left of the front path: the mailbox stands on the right)
    // (indoors: in the lit middle of the room by the furniture, not out at the open front)
    const meet = kit === "interior" ? { x: DOOR.x - 1.7, z: DOOR.z + 3.0 } : street ? { x: DOOR.x - 1.7, z: 2.6 } : { x: DOOR.x + 1.6, z: DOOR.z + 1.4 };
    const markOf = (id: string): { x: number; z: number } | null => {
      const i = inp.scene?.order.indexOf(id) ?? -1;
      return street && i >= 0 && i < SCENE_MARKS.length ? { x: meet.x + SCENE_MARKS[i]![0], z: meet.z + SCENE_MARKS[i]![1] } : null;
    };
    const carried = (id: string): { x: number; z: number; heading: number } | null => inp.scene?.carry?.[id] ?? null;
    const leadMark = markOf(who.id);
    // the whole scene's group (every mark but one's own): bodies turn to it, so they hold their pose across cuts
    const groupFacing = (id: string, from: { x: number; z: number }): number | null => {
      const others = (inp.scene?.order ?? []).filter((x) => x !== id).map(markOf).filter((m): m is { x: number; z: number } => !!m);
      if (!markOf(id) || !others.length) return null;
      const c = { x: others.reduce((a, m) => a + m.x, 0) / others.length, z: others.reduce((a, m) => a + m.z, 0) / others.length };
      return Math.atan2(c.x - from.x, c.z - from.z);
    };
    // a walk-in comes from the far side of the group, so it ends at its mark facing the others (not walking away from them)
    const others = (inp.scene?.order ?? []).filter((x) => x !== who.id).map(markOf).filter((m): m is { x: number; z: number } => !!m);
    const groupX = others.length ? others.reduce((a, m) => a + m.x, 0) / others.length : meet.x;
    const approach = leadMark && leadMark.x >= groupX ? 1 : -1;
    // already standing in this scene (an earlier shot showed them): whatever they do now starts from their mark
    const onStage = !!leadMark && (inp.scene?.before ?? []).includes(who.id);
    const toDoor = movers.some((a) => targetOf(a, { x: 0, z: 0 }) === "door-front");
    const handActs = actions.some((a) => ["press", "push", "pull", "reach"].includes(a.action));
    // a hand action at the set (a door, a bell) needs the character there; one toward a partner is done from the mark
    const handActsAtSet = actions.some((a) => ["press", "push", "pull", "reach"].includes(a.action) && !partnerNamed(a));
    // staging: where the character starts so the action reads (and stays in the set)
    let start: { x: number; z: number };
    // where the previous shot of this scene left the character comes first (continuity across the cut)
    const from = carried(who.id);
    if (from) start = { x: from.x, z: from.z };
    else if (walkTo) start = leadMark ? { x: leadMark.x + approach * travel, z: leadMark.z } : { x: meet.x - 1.15 - travel, z: meet.z };
    else if (leadMark && (onStage || (!mover && !handActsAtSet))) start = leadMark;
    // a conversation that does not move stays where the scene's walk-up ended (the meeting point)
    else if (street && partners.length && !mover && !handActs) start = { x: meet.x - 1.15, z: meet.z };
    else if (street) {
      start = mover ? (toDoor && movers.length === 1 && travel < 6 ? { x: DOOR.x - 0.2, z: Math.min(2.6, DOOR.z + 0.8 + travel) } : { x: DOOR.x - 1.2 - travel, z: 2.6 })
        : handActs ? { x: DOOR.x + 0.95, z: DOOR.z + 0.85 } : { x: DOOR.x + 1.4, z: DOOR.z + 1.5 };
    } else {
      start = mover ? { x: DOOR.x + 1.6, z: DOOR.z + 0.75 + travel } : handActs ? { x: DOOR.x + 1.2, z: DOOR.z + 1.6 } : { x: DOOR.x + 2.2, z: DOOR.z + 1.3 };
    }
    if (kit === "interior") start.x = Math.min(DOOR.x + 4.3, Math.max(start.x, DOOR.x - 4.3)); // a walk-in starts inside the side walls
    const props: PropSpec3D[] = [...(cast.props ?? [])];
    const events: CharacterEvent3D[] = [];
    const ensureProp = (kind: PropSpec3D["kind"]): string => {
      const have = props.find((p) => p.kind === kind);
      if (have) return have.id;
      const id = `${kind}-${who.id}`;
      props.push({ id, kind, socket: kind === "bag" ? "back" : kind === "box" ? "leftHand" : "rightHand" });
      events.push({ at: 0, action: "hold", prop: id });
      return id;
    };
    for (const o of objects) {
      const k = classifyProp(o.object);
      if (k === "flashlight" && objects.some((x) => x.object === o.object)) { const id = ensureProp("flashlight"); if (o.action === "glow" || o.action === "flicker" || o.action === "appear") { const { start: s } = placeAction(o.when, 0.5, D); events.push({ at: s, action: "raise", prop: id, target: "doorway" }); } }
      else if (k === "phone") ensureProp("phone");
      else if (k === "package") ensureProp("box");
      else if (k === "door" && (o.action === "open" || o.action === "close")) { const { start: s } = placeAction(o.when, 1, D); doorEvents.push({ at: s, action: o.action, duration: 1.7 }); }
    }
    let walks = 0;
    for (const a of actions) {
      const act = ACTION_MAP[a.action];
      if (!act) continue;
      const dur = a.duration ?? DEFAULT_DURATION[a.action] ?? 0.9;
      const { start: s, duration } = placeAction(a.when, dur, D);
      // a gesture or look aimed at another character on screen goes to that character
      const named = partnerNamed(a);
      let target: CharacterEvent3D["target"] = named && !(act === "walk" || act === "run") ? named.id : targetOf(a, start);
      // in a street of houses, "down the street" means along the sidewalk, not into the road
      if ((act === "walk" || act === "run") && street && typeof target !== "string" && /(street|road|sidewalk|along|down)/.test((a.toward ?? "").toLowerCase())) target = { x: DOOR.x - 1.2, z: 2.6 };
      if ((act === "walk" || act === "run") && partnerNamed(a)) {
        events.push({ at: s, action: act, target: leadMark ?? { x: meet.x - 1.15, z: meet.z } });
        // arrived: turn to the group (takes effect when the walk ends; the walk's own direction wins until then)
        if (leadMark && others.length) events.push({ at: Math.min(D - 0.2, s + travel / NOMINAL_WALK + 0.2), action: "turn", target: { x: groupX, z: others.reduce((a, m) => a + m.z, 0) / others.length } });
        continue;
      }
      if (act === "walk" || act === "run") {
        // a walk to a door goes via the approach (the path start / a point in front of the bay) when it starts far away
        walks++;
        if (target === "door-front" && street && start.z > 1.5) { events.push({ at: s, action: act, target: "approach" }); events.push({ at: s + 0.05, action: act, target: movers.length > 1 && walks === 1 ? "approach" : "door-front" }); continue; }
        if (target === "door-front" && movers.length > 1 && walks === 1) target = "approach";
        events.push({ at: s, action: act, target });
        continue;
      }
      // raise what the shot is about (a parcel, a phone, a torch the story names); with nothing named it is an open-hands reach
      if (act === "raise") {
        const named = objects.map((o) => classifyProp(o.object)).find((k) => k === "package" || k === "phone" || k === "flashlight");
        const id = named === "package" ? ensureProp("box") : named === "phone" ? ensureProp("phone") : named === "flashlight" ? ensureProp("flashlight") : props.find((p) => p.socket === "rightHand" || p.socket === "leftHand")?.id;
        if (id) events.push({ at: s, action: "raise", prop: id, ...(named === "flashlight" ? { target: "doorway" } : typeof target !== "undefined" ? { target } : {}), duration: 0.6 });
        else events.push({ at: s, action: "reach", target: partners[0]?.id ?? target, duration: 1 });
        continue;
      }
      if (act === "lower") { events.push({ at: s, action: "lower", prop: props.find((p) => p.socket === "rightHand")?.id, duration: 0.5 }); continue; }
      if (act === "adjust") { ensureProp("box"); events.push({ at: s, action: "adjust", duration: 0.6 }); continue; }
      if (a.action === "hold-phone") { const id = ensureProp("phone"); events.push({ at: s, action: "raise", prop: id, duration: 0.4 }, { at: s, action: "look", target: { x: start.x, y: 1.2, z: start.z + 0.6 }, duration: Math.max(1, D - s) }); continue; }
      if (act === "push" || act === "pull") {
        events.push({ at: Math.max(0, s - 0.1), action: act, target: "door", duration: 0.9 });
        if (!doorEvents.some((e) => e.action === "open")) doorEvents.push({ at: s + 0.35, action: "open", duration: 1.8 });
        continue;
      }
      if (act === "press") { events.push({ at: s, action: "press", target: target === "door" || target === "doorway" ? "doorbell" : target, duration: 0.55 }); continue; }
      if (act === "look" && a.action === "look-down") { events.push({ at: s, action: "look", target: { x: start.x, y: 0, z: start.z + 2 }, duration }); continue; }
      if (act === "look" && a.action === "look-up") { events.push({ at: s, action: "look", target: street ? "address" : { x: start.x, y: 6, z: DOOR.z }, duration: Math.max(duration, 1.2) }); continue; }
      events.push({ at: s, action: act, target, duration: act === "look" ? Math.max(duration, 1.2) : duration });
      // a startle steps back; a surprise in conversation does not (it read as the body sliding backward mid-line)
      if (act === "react" || act === "fear") events.push({ at: s + 0.3, action: "step-back", duration: 0.8 });
    }
    // a door that opens without anyone pushing it opens from inside: the character watches it
    for (const d of doorEvents) if (d.action === "open" && !events.some((e) => e.action === "push" || e.action === "pull")) events.push({ at: Math.max(0, d.at - 0.2), action: "look", target: "doorway", duration: Math.max(1.2, D - d.at) });
    const push = events.find((e) => e.action === "push" || e.action === "pull");
    if (push && !events.some((e) => e.action === "walk" || e.action === "run")) { start = street ? { x: DOOR.x + 0.2, z: DOOR.z + 2.0 } : { x: DOOR.x + 0.5, z: DOOR.z + 2.4 }; events.push({ at: 0.1, action: "walk", target: "door-front" }); }
    events.sort((a, b) => a.at - b.at);
    for (let i = events.length - 1; i > 0; i--) { const e = events[i]!; if (e.action === "raise" && events.slice(0, i).some((x) => x.action === "raise" && x.prop === e.prop && Math.abs(x.at - e.at) < 0.6)) events.splice(i, 1); }
    const first = events.find((e) => e.action === "walk" || e.action === "run");
    // partners: the walked-to one waits at the meeting point, the others stand in a shallow arc beside the lead, all turned
    // toward the lead; they keep looking at the lead and do their own actions (nod, wave, point, reach, react...)
    const spots: { x: number; z: number }[] = partners.map((p, i) => carried(p.id) ?? markOf(p.id) ?? (walkTo
      ? (p === walkTo ? meet : { x: meet.x + 1.05 * (i + 1), z: meet.z + 0.3 })
      : { x: start.x + [1.25, 2.35][i]!, z: start.z + [0.55, -0.1][i]! }));
    const leadAt = walkTo ? leadMark ?? { x: meet.x - 1.15, z: meet.z } : start;
    if (partners.length && !events.some((e) => e.action === "look" || e.action === "look-around")) {
      const s0 = first ? Math.min(D - 0.5, (first.at ?? 0) + Math.min(3.5, travel / NOMINAL_WALK)) : 0;
      events.push({ at: Math.max(0, s0), action: "look", target: (walkTo ?? partners[0]!).id, duration: Math.max(1, D - s0) });
      events.sort((a, b) => a.at - b.at);
    }
    const centroid = partners.length ? { x: spots.reduce((a, p) => a + p.x, 0) / spots.length, z: spots.reduce((a, p) => a + p.z, 0) / spots.length } : null;
    // standing near the door: side-on to the facade, turned toward the doorway (a camera on the street side sees the face AND the door)
    const heading = from ? from.heading : (!first || onStage) && groupFacing(who.id, start) !== null ? groupFacing(who.id, start)!
      : centroid && !first ? Math.atan2(centroid.x - start.x, centroid.z - start.z)
      : first && start.z > 1.5 && street ? Math.PI / 2 : first ? Math.atan2(DOOR.x - start.x, DOOR.z + 0.4 - start.z) : Math.atan2(DOOR.x - 0.2 - start.x, DOOR.z + 0.25 - start.z);
    characters.push({ id: who.id, asset: cast.asset, wardrobe: cast.wardrobe, start: { ...start, heading }, props, events, expression: expressionOf(shot.emotion), ...speaking(who.id) });
    notes.push(...events.map((e) => `${e.at.toFixed(2)} ${e.action}${typeof e.target === "string" ? ` -> ${e.target}` : ""}${e.prop ? ` (${e.prop})` : ""}`));
    partners.forEach((p, i) => {
      const pc = inp.cast(p), at = spots[i]!;
      const pev: CharacterEvent3D[] = [{ at: 0, action: "look", target: who.id, duration: D }];
      for (const a of (shot.animation?.actions ?? []).filter((x) => x.character === p.id)) {
        const act = ACTION_MAP[a.action];
        if (!act || act === "walk" || act === "run") continue; // partners hold their place; the lead moves
        const { start: s0, duration } = placeAction(a.when, a.duration ?? DEFAULT_DURATION[a.action] ?? 0.9, D);
        const target: CharacterEvent3D["target"] = act === "look" || act === "wave" || act === "point" || act === "reach" || act === "turn" ? (a.toward && !partnerNamed(a) && !/(lead|him|her)/.test(a.toward) ? targetOf(a, at) : who.id) : undefined;
        pev.push({ at: s0, action: act, ...(target !== undefined ? { target } : {}), duration: act === "look" ? Math.max(duration, 1.2) : duration });
        if (act === "react" || act === "fear") pev.push({ at: s0 + 0.3, action: "step-back", duration: 0.8 });
      }
      pev.sort((a, b) => a.at - b.at);
      // a listener's face: attentive, or the reaction its actions show
      const react = pev.find((e) => e.action === "surprise" || e.action === "react" || e.action === "fear");
      characters.push({ id: p.id, asset: pc.asset, wardrobe: pc.wardrobe, start: { x: at.x, z: at.z, heading: carried(p.id)?.heading ?? groupFacing(p.id, at) ?? Math.atan2(leadAt.x - at.x, leadAt.z - at.z) }, props: [...(pc.props ?? [])], events: pev, expression: "neutral", ...(react ? { expressions: [{ at: react.at, expression: react.action === "fear" ? "fear" : "surprised" }] } : {}), ...speaking(p.id) });
      notes.push(`partner ${p.id} at (${at.x.toFixed(1)}, ${at.z.toFixed(1)}): ${pev.map((e) => e.action).join(", ")}`);
    });
  }

  // the village hand pump: a shot about pumping water stages the lead at the pump and works it (handle, flow, bucket)
  let interactions: InteractionSpec3D | undefined;
  // (it replaces an implied walk: a character working the pump stands at it)
  if (kit === "village" && characters[0] && objectOf(shot) === "pump" && /(pump|fill|water|draw)/i.test(shot.action)) {
    characters[0].start = { x: PUMP_STAND.x, z: PUMP_STAND.z, heading: Math.PI / 2 };
    // a later shot of the scene cuts INTO the pumping (hand on the grip, at full stroke); the first one starts it
    // (the bucket keeps what the earlier pump shots of the scene put in it: about 2.5 l per shot)
    const later = (inp.indexInScene ?? 0) > 0;
    characters[0].events = [{ at: later ? -1.5 : 0, action: "reach", target: "pump-handle", duration: D + 2 }];
    interactions = { handpump: { from: later ? -1 : Math.min(0.6, D * 0.1), to: Math.max(D - 0.4, D * 0.8), bucketStart: Math.min(10, (inp.indexInScene ?? 0) * 2.5) } };
    notes.push(`${characters[0].id} works the hand pump`);
  }

  // camera: shot size + movement from the Director; a moving subject is tracked from a slight side angle
  const moving = characters[0]?.events.some((e) => e.action === "walk" || e.action === "run");
  let move = CAMERA_MOVE[shot.motion.type];
  if (moving && (move === "static" || move === "pan")) move = "follow";
  const camShot = CAMERA_SHOT[shot.shotType];
  const reacting = characters[0]?.events.some((e) => e.action === "react" || e.action === "surprise" || e.action === "fear");
  // on a street-like set the camera works from the open front (z+), so the facade, the door and the set dressing are
  // behind the actors; otherwise the plan's side (the warehouse decides by its own clamp)
  const lead = characters[0];
  const camAngle = camShot === "over_shoulder" ? 0 : moving && camShot === "wide" ? 2.05 : moving ? 1.6 : dir?.shot?.angle ?? (camShot === "closeup" ? 0.85 : 1.05);
  const frontSide = (h: number): number => (Math.cos(h + camAngle) >= Math.cos(h - camAngle) ? 1 : -1);
  const leadHeading = lead ? (typeof lead.start.heading === "number" ? lead.start.heading : 0) : 0;
  const camera: CameraSpec3D = {
    shot: camShot, move, target: who?.id ?? "door", side: street && lead ? frontSide(leadHeading) : dir?.shot?.side ?? (inp.seed % 2 ? 1 : -1),
    behind: camShot === "over_shoulder",
    // the plan varies the angle shot by shot; a moving subject is still tracked from the side
    ...(camShot === "over_shoulder" ? {} : moving && camShot === "wide" ? { angle: 2.05 } : moving ? { angle: 1.6 } : who ? { angle: dir?.shot?.angle ?? (camShot === "closeup" ? 0.85 : 1.05) } : {}),
    ...(dir?.shot ? { heightOffset: dir.shot.heightOffset, fovScale: dir.shot.fovScale } : {}),
    ...(street ? { front: { x: 0, z: 1 } } : {}),
    // a push toward the door / what startles the character; a close-up stays on the face instead
    ...((reacting || move === "push_in") && camShot !== "closeup" ? { toward: "doorway" } : {}),
    // a door that opens (or what the character reacts to inside) stays in the frame with the character
    ...(camShot !== "over_shoulder" && camShot !== "closeup" && !moving && who && (doorEvents.length || reacting || characters[0]?.events.some((e) => e.target === "doorbell")) ? { frameWith: "door" } : {}),
    // a conversation: the lead and the farthest partner (so everyone between them) share the 9:16 frame; a close-up stays
    // on the face of the one it is about (lips and expression must read on a phone)
    ...(camShot !== "over_shoulder" && camShot !== "closeup" && characters.length > 1 ? { frameWith: farthest(characters) } : {}),
  };
  // the coverage was planned for this shot in its scene (a direction lent from another shot keeps the per-shot mapping)
  const cov = dir?.shot?.shotId === shot.id && dir.shot.coverage?.from === shot.shotType ? dir.shot.coverage : undefined;
  const covCam = cov && (who || cov.purpose === "establishing") ? coverageCamera(cov, shot, characters, kit, !!moving, interactions, street) : null;
  if (covCam) notes.push(`camera: ${covCam.purpose} (${cov!.reason})`);
  // a planned move: open on the previous shot's composition and travel to this one (a cut there would read as a jump)
  if (covCam && cov!.transition === "move") {
    // from the place down into the scene is a long crane (~7 m): 3.2 s keeps it a glide; closer on the same action, 1.8 s
    const enter = entryFrom(inp.prevCamera, characters, inp.characters, D, inp.prevCamera?.purpose === "establishing" ? 3.2 : 1.8);
    if (enter) { covCam.enter = enter; notes.push(`camera moves in from the previous shot (${cov!.transitionReason}), ${enter.duration.toFixed(1)} s`); }
    else notes.push(`camera cuts: the previous shot's framing is not on this set (${cov!.transitionReason})`);
  }
  const spec: Shot3DSpec = {
    id: shot.id, duration: D, width: inp.width, height: inp.height, fps: inp.fps, seed: inp.seed, lighting,
    ...(dir ? { style: { id: dir.style.id, shading: dir.style.shading, exposure: dir.style.exposure } } : {}),
    environment: {
      kind: kit, backdrop: inp.backdrop?.(loc), wallTexture: inp.wallTexture?.(loc), objects: objs,
      weather: dir ? { rain: dir.location.rain, wind: dir.location.wind, ...(dir.location.fog !== undefined ? { fog: dir.location.fog } : {}) } : { rain: rainy ? 0.8 : 0, wind: night ? 0.3 : 0.7 },
      ...(dir ? { palette: dir.location.palette, lightsOut: dir.location.lightsOut } : {}),
      ...(dir?.location.world ? { world: dir.location.world } : {}),
      ...(interactions ? { interactions } : {}),
    },
    ...(dir?.location.sunAzimuth !== undefined ? { sunAzimuth: dir.location.sunAzimuth } : {}),
    characters, camera: covCam ?? camera,
  };
  return { spec, notes };
}

/** The entry move from the previous camera, or null when it cannot open on it (no camera, a fixed one, or it frames
 *  someone who is not in this shot). Duration: the planned length, at most 75 % of the shot (it must arrive and hold). */
function entryFrom(prev: CameraSpec3D | undefined, cs: CharacterSpec3D[], all: Character[], D: number, want: number): CameraSpec3D["enter"] | null {
  if (!prev || prev.fixed) return null;
  const isCharacter = (id: string | undefined) => !!id && all.some((c) => c.id === id);
  const here = (id: string | undefined) => !id || !isCharacter(id) || cs.some((c) => c.id === id);
  if (!here(prev.target) || !here(prev.frameWith) || !here(prev.toward)) return null;
  // every field the composition depends on, as the previous shot ended (a push-in / pull-out at its end point)
  const from: NonNullable<CameraSpec3D["enter"]>["from"] = {
    shot: prev.shot, move: prev.move === "follow" || prev.move === "tracking" ? "static" : prev.move, target: prev.target, toward: prev.toward ?? null, side: prev.side ?? null, behind: prev.behind ?? null,
    angle: prev.angle ?? null, frameWith: prev.frameWith ?? null, heightOffset: prev.heightOffset ?? null, fovScale: prev.fovScale ?? null, atEnd: prev.move === "push_in" || prev.move === "pull_out",
  };
  return { from, duration: +Math.min(want, D * 0.75).toFixed(2) };
}

const PUMP_STAND = { x: DOOR.x + 2.48, z: DOOR.z + 5.38 }; // village.ts "pump-stand": behind the grip, facing the pump (+x)
const POINT_OF: Record<string, (pumping: boolean) => string> = { pump: () => "pump-spout", tap: () => "tap", bucket: (p) => (p ? "pump-spout" : "tap") };

/** The camera for a planned coverage (cinematography.ts): who / what it frames, from where, how it moves. */
function coverageCamera(cov: NonNullable<ShotDirection["coverage"]>, shot: Shot, cs: CharacterSpec3D[], kit: SceneDirection["kit"], moving: boolean, interactions: InteractionSpec3D | undefined, street: boolean): CameraSpec3D {
  // the place itself: a raised wide on the set's "stage" point, with or without anyone in it
  if (cov.purpose === "establishing") return { shot: "wide", move: cov.move === "follow" ? "static" : cov.move, target: "stage", side: 1, angle: cov.angle, heightOffset: cov.heightOffset, fovScale: cov.fovScale, purpose: cov.purpose, ...(street ? { front: { x: 0, z: 1 } } : {}) };
  const lead = cs[0]!;
  const speakerId = shot.dialogue.find((d) => cs.some((c) => c.id === d.characterId))?.characterId;
  const speaker = cs.find((c) => c.id === speakerId) ?? lead;
  const listener = cs.find((c) => c.id !== speaker.id);
  const base = { heightOffset: cov.heightOffset, fovScale: cov.fovScale, purpose: cov.purpose, ...(street ? { front: { x: 0, z: 1 } } : {}) };
  const heading = (c: CharacterSpec3D): number => (typeof c.start.heading === "number" ? c.start.heading : 0);
  // the open front of a street set (z+): the side of the subject whose angle puts the camera there
  const frontSide = (h: number, a: number): number => (Math.cos(h + a) >= Math.cos(h - a) ? 1 : -1);
  const move: CameraSpec3D["move"] = moving && cov.move === "static" ? "follow" : cov.move;
  // what the character is working: a wide keeps the whole pump and bucket in frame with them (context), a medium the
  // handle in their hands (action); the insert is the water (detail)
  const workingAt = interactions?.handpump ? "pump-spout" : undefined;
  const single = (c: CharacterSpec3D, purpose = cov.purpose): CameraSpec3D => ({ ...base, purpose, shot: cov.shot === "medium" ? "medium" : "closeup", move: move === "follow" ? "static" : move, target: c.id, side: frontSide(heading(c), cov.angle), angle: cov.angle, ...(cov.shot === "medium" && workingAt ? { frameWith: "pump-handle" } : {}) });
  // an object detail: only where the set has the object (the village pump / tap); elsewhere the hands and face carry it
  if (cov.purpose === "insert") {
    const point = cov.object && kit === "village" ? POINT_OF[cov.object]?.(!!interactions?.handpump) : undefined;
    return point ? { ...base, shot: "insert", move: "static", target: point, side: 1, angle: cov.angle } : single(lead, "single");
  }
  // over the shoulder: behind the listener, on the shoulder toward the open front, looking at the speaker's face
  if (cov.purpose === "ots") {
    if (!listener || speaker === listener) return single(speaker, "single");
    const side = Math.sign(speaker.start.x - listener.start.x) || 1;
    return { ...base, shot: "over_shoulder", move: "static", target: listener.id, toward: speaker.id, behind: true, side };
  }
  if (cov.purpose === "single") return single(speaker);
  // tracking: from the side of a walk along the set; a walk INTO the set (toward the houses) is followed from behind
  // three-quarters (a side camera would run into the porches)
  if (cov.purpose === "tracking" && Math.cos(heading(lead)) < -0.5) return { ...base, shot: cov.shot === "medium" ? "medium" : "wide", move, target: lead.id, side: frontSide(heading(lead), 2.5), angle: 2.5 };
  if (cov.purpose === "reaction") return single(lead);
  // wides with people: the master, the two-shot, tracking; everyone shares the frame
  const shotSize: CameraSpec3D["shot"] = cov.shot === "medium" ? "medium" : "wide";
  return { ...base, shot: shotSize, move, target: lead.id, side: frontSide(heading(lead), cov.angle), angle: cov.angle, ...(cs.length > 1 && !moving ? { frameWith: farthest(cs) } : workingAt ? { frameWith: workingAt } : {}) };
}

function farthest(cs: CharacterSpec3D[]): string {
  const l = cs[0]!.start;
  return cs.slice(1).reduce((best, c) => (Math.hypot(c.start.x - l.x, c.start.z - l.z) > Math.hypot(best.start.x - l.x, best.start.z - l.z) ? c : best)).id;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Where each character of a compiled shot ends (static: walks arrive exactly at their targets, which the runtime
 * guarantees), so the next shot of the same scene can start them there. Named set points follow the runtime's set.
 */
export function endPositions(spec: Shot3DSpec): Record<string, { x: number; z: number; heading: number }> {
  const door = spec.environment.objects.find((o) => o.kind === "door");
  const DX = door?.x ?? 0, DZ = door?.z ?? -8, hingeLeft = (door?.params?.hinge ?? "left") === "left";
  const named: Record<string, { x: number; z: number }> = {
    "door-front": { x: DX + (hingeLeft ? 0.35 : -0.35), z: DZ + 0.8 },
    approach: spec.environment.kind === "neighborhood" ? { x: DX, z: 2.3 } : { x: DX + 1.2, z: DZ + 3.6 },
  };
  const out: Record<string, { x: number; z: number; heading: number }> = {};
  for (const c of spec.characters) {
    let x = c.start.x, z = c.start.z, heading = typeof c.start.heading === "number" ? c.start.heading : 0;
    const moves = c.events.filter((e) => e.action === "walk" || e.action === "run");
    for (const e of c.events) {
      if (e.action === "step-back") { const d = (e.duration ?? 0.9) * 1.1 * 0.5; x -= Math.sin(heading) * d; z -= Math.cos(heading) * d; continue; }
      if (e.action !== "walk" && e.action !== "run" && e.action !== "turn") continue;
      const t = typeof e.target === "string" ? named[e.target] : e.target ? { x: e.target.x, z: e.target.z } : undefined;
      if (!t) continue;
      if (e.action === "turn") { heading = Math.atan2(t.x - x, t.z - z); continue; }
      const len = Math.hypot(t.x - x, t.z - z);
      if (len > 0.05) heading = Math.atan2(t.x - x, t.z - z);
      // a walk still under way when the shot ends (or when the next one starts) gets only as far as time allows
      const next = moves[moves.indexOf(e) + 1], until = next ? next.at : spec.duration;
      const reach = Math.max(0, (e.action === "run" ? 2.5 : 1.1) * (until - e.at - 0.35));
      const k = len > 0 ? Math.min(1, reach / len) : 1;
      x += (t.x - x) * k; z += (t.z - z) * k;
    }
    out[c.id] = { x, z, heading };
  }
  return out;
}
