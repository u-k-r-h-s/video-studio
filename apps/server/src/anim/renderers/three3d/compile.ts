import type { Character, Location, Shot, ShotAnimAction, Story } from "@studio/shared";
import { DEFAULT_DURATION, placeAction } from "../../actions";
import { classifyProp, impliedActions } from "../../semantics";
import type { Action3D, CameraSpec3D, CharacterEvent3D, CharacterSpec3D, LightingPreset, PropSpec3D, SetObject3D, Shot3DSpec } from "./spec";

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
  if (/(away|back|behind|street|road)/.test(t)) return { x: here.x + 1.5, z: here.z + 7 };
  if (/(sound|noise|voice|shadow|figure|dark)/.test(t)) return "doorway";
  return a.action === "walk" || a.action === "run" ? "door-front" : "doorway";
}

const ACTION_MAP: Partial<Record<ShotAnimAction["action"], Action3D>> = {
  idle: "idle", walk: "walk", run: "run", enter: "walk", exit: "run", turn: "turn", "look-left": "look", "look-right": "look", "look-up": "look", "look-down": "look",
  "look-center": "look", "head-turn": "look", nod: "nod", "shake-head": "shake-head", "step-forward": "walk", "step-back": "step-back", "hand-gesture": "wave",
  point: "point", react: "react", surprise: "surprise", fear: "fear", anger: "react", smile: "idle", "raise-hand": "wave", wave: "wave", reach: "reach",
  push: "push", pull: "pull", "raise-object": "raise", "lower-object": "lower", "hold-phone": "hold", listen: "look-around", press: "press", adjust: "adjust", hesitate: "hesitate",
};

export function compileShot3D(inp: Compile3DInput): { spec: Shot3DSpec; notes: string[] } {
  const { shot, duration: D } = inp;
  const notes: string[] = [];
  const loc = inp.story.locations.find((l) => l.id === shot.locationId) ?? inp.story.locations[0]!;
  const who = shot.subjectIds[0] ? inp.characters.find((c) => c.id === shot.subjectIds[0]) : undefined;
  const actions = who ? impliedActions(shot) : [];
  const objects = shot.animation?.objects ?? [];
  const lighting = lightingFor(loc);
  const kit = kitFor(loc);
  const text = `${loc.visualIdentity} ${loc.lighting} ${loc.description}`.toLowerCase();
  const night = /night/.test(lighting) || lighting.includes("interior") && !lighting.includes("daylight");
  const rainy = loc.weather === "rain" || lighting.includes("rain") || (!loc.weather && /(rain|storm|wet|drizzle)/.test(text));
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
  } else {
    objs.push(
      { id: "mailbox", kind: "mailbox", x: DOOR.x + 1.3, z: 1.7, params: { color: ["#2d4f86", "#b8312f", "#2e5a3a"][Math.floor(r() * 3)]! } },
      { id: "car", kind: "car", x: DOOR.x + 6.5, z: 6.2, params: { color: ["#b8312f", "#2d6fa8", "#e0b03a", "#e8e8e8"][Math.floor(r() * 4)]! } },
      { id: "streetlamp", kind: "streetlamp", x: DOOR.x - 7.5, z: 3.7 },
    );
  }

  const characters: CharacterSpec3D[] = [];
  if (who) {
    const cast = inp.cast(who);
    const movers = actions.filter((a) => a.action === "walk" || a.action === "run" || a.action === "enter");
    const mover = movers[0];
    const walkTime = mover ? placeAction(mover.when, 0, D) : null;
    const travel = mover ? Math.min(14, Math.max(2.5, (mover.action === "run" ? 3.2 : NOMINAL_WALK) * (D - (walkTime?.start ?? 0)) * 0.72)) : 0;
    const toDoor = movers.some((a) => targetOf(a, { x: 0, z: 0 }) === "door-front");
    const handActs = actions.some((a) => ["press", "push", "pull", "reach"].includes(a.action));
    // staging: where the character starts so the action reads (and stays in the set)
    let start: { x: number; z: number };
    if (kit === "neighborhood") {
      start = mover ? (toDoor && movers.length === 1 && travel < 6 ? { x: DOOR.x - 0.2, z: Math.min(2.6, DOOR.z + 0.8 + travel) } : { x: DOOR.x - 1.2 - travel, z: 2.6 })
        : handActs ? { x: DOOR.x + 0.95, z: DOOR.z + 0.85 } : { x: DOOR.x + 1.4, z: DOOR.z + 1.5 };
    } else {
      start = mover ? { x: DOOR.x + 1.6, z: DOOR.z + 0.75 + travel } : handActs ? { x: DOOR.x + 1.2, z: DOOR.z + 1.6 } : { x: DOOR.x + 2.2, z: DOOR.z + 1.3 };
    }
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
      if (k === "flashlight") { const id = ensureProp("flashlight"); if (o.action === "glow" || o.action === "flicker" || o.action === "appear") { const { start: s } = placeAction(o.when, 0.5, D); events.push({ at: s, action: "raise", prop: id, target: "doorway" }); } }
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
      let target = targetOf(a, start);
      // in a street of houses, "down the street" means along the sidewalk, not into the road
      if ((act === "walk" || act === "run") && kit === "neighborhood" && typeof target !== "string" && /(street|road|sidewalk|along|down)/.test((a.toward ?? "").toLowerCase())) target = { x: DOOR.x - 1.2, z: 2.6 };
      if (act === "walk" || act === "run") {
        // a walk to a door goes via the approach (the path start / a point in front of the bay) when it starts far away
        walks++;
        if (target === "door-front" && kit === "neighborhood" && start.z > 1.5) { events.push({ at: s, action: act, target: "approach" }); events.push({ at: s + 0.05, action: act, target: movers.length > 1 && walks === 1 ? "approach" : "door-front" }); continue; }
        if (target === "door-front" && movers.length > 1 && walks === 1) target = "approach";
        events.push({ at: s, action: act, target });
        continue;
      }
      if (act === "raise") { const id = ensureProp("flashlight"); events.push({ at: s, action: "raise", prop: id, target: "doorway", duration: 0.6 }); continue; }
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
      if (act === "look" && a.action === "look-up") { events.push({ at: s, action: "look", target: kit === "neighborhood" ? "address" : { x: start.x, y: 6, z: DOOR.z }, duration: Math.max(duration, 1.2) }); continue; }
      events.push({ at: s, action: act, target, duration: act === "look" ? Math.max(duration, 1.2) : duration });
      if (act === "react" || act === "surprise" || act === "fear") events.push({ at: s + 0.3, action: "step-back", duration: 0.8 });
    }
    // a door that opens without anyone pushing it opens from inside: the character watches it
    for (const d of doorEvents) if (d.action === "open" && !events.some((e) => e.action === "push" || e.action === "pull")) events.push({ at: Math.max(0, d.at - 0.2), action: "look", target: "doorway", duration: Math.max(1.2, D - d.at) });
    const push = events.find((e) => e.action === "push" || e.action === "pull");
    if (push && !events.some((e) => e.action === "walk" || e.action === "run")) { start = kit === "neighborhood" ? { x: DOOR.x + 0.2, z: DOOR.z + 2.0 } : { x: DOOR.x + 0.5, z: DOOR.z + 2.4 }; events.push({ at: 0.1, action: "walk", target: "door-front" }); }
    events.sort((a, b) => a.at - b.at);
    for (let i = events.length - 1; i > 0; i--) { const e = events[i]!; if (e.action === "raise" && events.slice(0, i).some((x) => x.action === "raise" && x.prop === e.prop && Math.abs(x.at - e.at) < 0.6)) events.splice(i, 1); }
    const first = events.find((e) => e.action === "walk" || e.action === "run");
    // standing near the door: side-on to the facade, turned toward the doorway (a camera on the street side sees the face AND the door)
    const heading = first && start.z > 1.5 && kit === "neighborhood" ? Math.PI / 2 : first ? Math.atan2(DOOR.x - start.x, DOOR.z + 0.4 - start.z) : Math.atan2(DOOR.x - 0.2 - start.x, DOOR.z + 0.25 - start.z);
    characters.push({ id: who.id, asset: cast.asset, wardrobe: cast.wardrobe, start: { ...start, heading }, props, events, expression: shot.emotion === "fear" ? "fear" : shot.emotion === "shock" ? "surprised" : "neutral" });
    notes.push(...events.map((e) => `${e.at.toFixed(2)} ${e.action}${typeof e.target === "string" ? ` -> ${e.target}` : ""}${e.prop ? ` (${e.prop})` : ""}`));
  }

  // camera: shot size + movement from the Director; a moving subject is tracked from a slight side angle
  const moving = characters[0]?.events.some((e) => e.action === "walk" || e.action === "run");
  let move = CAMERA_MOVE[shot.motion.type];
  if (moving && (move === "static" || move === "pan")) move = "follow";
  const camShot = CAMERA_SHOT[shot.shotType];
  const reacting = characters[0]?.events.some((e) => e.action === "react" || e.action === "surprise" || e.action === "fear");
  const camera: CameraSpec3D = {
    shot: camShot, move, target: who?.id ?? "door", side: inp.seed % 2 ? 1 : -1,
    behind: camShot === "over_shoulder",
    ...(camShot === "over_shoulder" ? {} : moving && camShot === "wide" ? { angle: 2.05 } : moving ? { angle: 1.6 } : who ? { angle: camShot === "closeup" ? 0.85 : 1.05 } : {}),
    ...(reacting || move === "push_in" ? { toward: "doorway" } : {}),
    // a door that opens (or what the character reacts to inside) stays in the frame with the character
    ...(camShot !== "over_shoulder" && !moving && who && (doorEvents.length || reacting || characters[0]?.events.some((e) => e.target === "doorbell")) ? { frameWith: "door" } : {}),
  };
  const spec: Shot3DSpec = {
    id: shot.id, duration: D, width: inp.width, height: inp.height, fps: inp.fps, seed: inp.seed, lighting,
    environment: { kind: kit, backdrop: inp.backdrop?.(loc), wallTexture: inp.wallTexture?.(loc), objects: objs, weather: { rain: rainy ? 0.8 : 0, wind: night ? 0.3 : 0.7 } },
    characters, camera,
  };
  return { spec, notes };
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
