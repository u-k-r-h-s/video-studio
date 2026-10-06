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

export function lightingFor(l: Pick<Location, "visualIdentity" | "lighting" | "description">): LightingPreset {
  const t = `${l.visualIdentity} ${l.lighting} ${l.description}`.toLowerCase();
  const night = /(night|dark|moon|midnight|evening|neon|shadow)/.test(t);
  if (/(horror|eerie|creepy|ghost|blood)/.test(t)) return "horror";
  if (/(rain|storm|wet|drizzle)/.test(t)) return "rain";
  if (/(warehouse|factory|industrial|dock|hangar)/.test(t) && night) return "warehouse";
  if (/(street|alley|city|road)/.test(t) && night) return "street";
  if (/(interior|room|hall|corridor|kitchen|office|lobby)/.test(t)) return /(warm|lamp|candle|fire|golden|amber)/.test(t) ? "warm-interior" : "cold-interior";
  return night ? "night" : "day";
}

const CAMERA_SHOT: Record<Shot["shotType"], CameraSpec3D["shot"]> = {
  establishing: "wide", wide: "wide", "medium-wide": "wide", "low-angle": "wide", "high-angle": "wide", tracking: "wide", action: "medium",
  medium: "medium", "medium-close": "closeup", "close-up": "closeup", "extreme-close-up": "closeup", "over-shoulder": "over_shoulder", pov: "over_shoulder",
};
const CAMERA_MOVE: Record<Shot["motion"]["type"], CameraSpec3D["move"]> = {
  static: "static", "push-in": "push_in", "pull-out": "pull_out", pan: "pan", tilt: "tilt", tracking: "tracking", shake: "handheld", parallax: "follow", action: "handheld",
};

/** Where an action is directed, as a set point name or a position (the set kit names: door, door-front, doorway, camera). */
function targetOf(a: Pick<ShotAnimAction, "toward" | "to" | "action">, here: { x: number; z: number }): CharacterEvent3D["target"] {
  const t = (a.toward ?? "").toLowerCase();
  if (a.to === "camera" || /(camera|viewer|us\b)/.test(t)) return "camera";
  if (/(door|entrance|gate|building|warehouse|house|inside|in there)/.test(t)) return a.action === "walk" || a.action === "run" || a.action === "enter" ? "door-front" : "doorway";
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
  push: "push", pull: "pull", "raise-object": "raise", "lower-object": "lower", "hold-phone": "hold", listen: "look-around",
};

export function compileShot3D(inp: Compile3DInput): { spec: Shot3DSpec; notes: string[] } {
  const { shot, duration: D } = inp;
  const notes: string[] = [];
  const loc = inp.story.locations.find((l) => l.id === shot.locationId) ?? inp.story.locations[0]!;
  const who = shot.subjectIds[0] ? inp.characters.find((c) => c.id === shot.subjectIds[0]) : undefined;
  const actions = who ? impliedActions(shot) : [];
  const objects = shot.animation?.objects ?? [];
  const lighting = lightingFor(loc);
  const text = `${loc.visualIdentity} ${loc.lighting} ${loc.description}`.toLowerCase();

  // the set: a facade with a working door in front of the plate; a lamp over the door; some props for scale and depth
  const doorEvents: NonNullable<SetObject3D["events"]> = [];
  const r = mulberry(inp.seed);
  const objs: SetObject3D[] = [
    { id: "door", kind: "door", x: DOOR.x, z: DOOR.z, params: { width: 2.6, height: 3.3, hinge: "left", glow: /(cold|blue|moon)/.test(text) ? "#9cc0ff" : "#ffb46a", cold: "#6f9dff" }, events: doorEvents },
    { id: "lamp", kind: "lamp", x: DOOR.x, y: 4.25, z: DOOR.z + 0.55, params: { color: "#ffc98a", intensity: 240 }, events: /(flicker|broken|dying)/.test(text) || shot.emotion === "eerie" ? [{ at: 0, action: "flicker" }] : [] },
    { id: "crates", kind: "crate", x: 3.2 + r() * 0.6, z: DOOR.z + 1.2, rotation: r() },
    { id: "crates2", kind: "crate", x: 4.1 + r() * 0.4, z: DOOR.z + 0.9, rotation: r(), scale: 0.85 },
    { id: "barrel", kind: "barrel", x: -3.0, z: DOOR.z + 1.0 },
    { id: "barrel2", kind: "barrel", x: -3.6, z: DOOR.z + 1.5, params: { color: "#5a3a28" } },
    { id: "pallet", kind: "pallet", x: -2.2, z: DOOR.z + 2.6, rotation: 0.4 },
    { id: "dumpster", kind: "dumpster", x: 6.5, z: DOOR.z + 2.2, rotation: -0.3 },
  ];

  const characters: CharacterSpec3D[] = [];
  if (who) {
    const cast = inp.cast(who);
    // where the character starts: far from the door when the shot is a walk to it, close to it otherwise
    const mover = actions.find((a) => a.action === "walk" || a.action === "run" || a.action === "enter");
    const walkTime = mover ? placeAction(mover.when, 0, D) : null;
    const travel = mover ? Math.min(14, Math.max(2.5, (mover.action === "run" ? 3.2 : NOMINAL_WALK) * (D - (walkTime?.start ?? 0)) * 0.78)) : 0;
    const startZ = DOOR.z + 0.75 + (mover ? travel : 2.4 + (inp.indexInScene ?? 0) * 0.2);
    // not walking: beside the door, side-on to the facade, so a camera on the street side sees the face AND the doorway
    const start = { x: DOOR.x + (mover ? 1.6 : 2.4), z: mover ? startZ : DOOR.z + 1.35 };
    const props: PropSpec3D[] = [...(cast.props ?? [])];
    const events: CharacterEvent3D[] = [];
    const ensureProp = (kind: PropSpec3D["kind"]): string => {
      const have = props.find((p) => p.kind === kind);
      if (have) return have.id;
      const id = `${kind}-${who.id}`;
      props.push({ id, kind, socket: kind === "bag" ? "back" : "rightHand" });
      events.push({ at: 0, action: "hold", prop: id });
      return id;
    };
    for (const o of objects) {
      const k = classifyProp(o.object);
      if (k === "flashlight") { const id = ensureProp("flashlight"); if (o.action === "glow" || o.action === "flicker" || o.action === "appear") { const { start: s } = placeAction(o.when, 0.5, D); events.push({ at: s, action: "raise", prop: id, target: "doorway" }); } }
      else if (k === "phone") { ensureProp("phone"); }
      else if (k === "door" && (o.action === "open" || o.action === "close")) { const { start: s } = placeAction(o.when, 1, D); doorEvents.push({ at: s, action: o.action, duration: 1.7 }); }
    }
    for (const a of actions) {
      const act = ACTION_MAP[a.action];
      if (!act) continue;
      const dur = a.duration ?? DEFAULT_DURATION[a.action] ?? 0.9;
      const { start: s, duration } = placeAction(a.when, dur, D);
      const target = targetOf(a, start);
      if (act === "raise") { const id = ensureProp("flashlight"); events.push({ at: s, action: "raise", prop: id, target: "doorway", duration: 0.55 }); continue; }
      if (act === "lower") { events.push({ at: s, action: "lower", prop: props.find((p) => p.socket === "rightHand")?.id, duration: 0.5 }); continue; }
      if (a.action === "hold-phone") { const id = ensureProp("phone"); events.push({ at: s, action: "raise", prop: id, duration: 0.4 }, { at: s, action: "look", target: { x: start.x, y: 1.2, z: start.z + 0.6 }, duration: Math.max(1, D - s) }); continue; }
      if (act === "push" || act === "pull") {
        // the door opens under the hand: the character steps to it first if needed
        events.push({ at: Math.max(0, s - 0.1), action: act, target: "door", duration: 0.9 });
        if (!doorEvents.some((e) => e.action === "open")) doorEvents.push({ at: s + 0.25, action: "open", duration: 1.8 });
        continue;
      }
      if (act === "look" && a.action === "look-down") { events.push({ at: s, action: "look", target: { x: start.x, y: 0, z: start.z + 2 }, duration }); continue; }
      if (act === "look" && a.action === "look-up") { events.push({ at: s, action: "look", target: { x: start.x, y: 6, z: DOOR.z }, duration }); continue; }
      events.push({ at: s, action: act, target, duration: act === "walk" || act === "run" ? undefined : duration });
      if (act === "react" || act === "surprise" || act === "fear") events.push({ at: s + 0.15, action: "step-back", duration: 0.8 });
    }
    // a door that opens in the shot: the character pushes it if it is close
    for (const d of doorEvents) if (d.action === "open" && !events.some((e) => e.action === "push" || e.action === "pull")) events.push({ at: Math.max(0, d.at - 0.25), action: "push", target: "door", duration: 0.9 });
    // when a push happens, the character must be at the door first
    const push = events.find((e) => e.action === "push" || e.action === "pull");
    if (push && !events.some((e) => e.action === "walk" || e.action === "run")) { start.z = DOOR.z + 2.1; start.x = DOOR.x + 0.5; events.push({ at: Math.max(0, push.at - 1.3), action: "walk", target: "door-front" }); }
    // one raise per prop is enough (the object list and the action list often both say it)
    events.sort((a, b) => a.at - b.at);
    for (let i = events.length - 1; i > 0; i--) { const e = events[i]!; if (e.action === "raise" && events.slice(0, i).some((x) => x.action === "raise" && x.prop === e.prop && Math.abs(x.at - e.at) < 0.6)) events.splice(i, 1); }
    // facing at the start: toward the door (into the scene) when walking to it, three-quarters to the camera otherwise
    const heading = mover ? Math.atan2(DOOR.x - start.x, DOOR.z + 0.4 - start.z) : Math.atan2(DOOR.x - start.x, DOOR.z + 0.4 - start.z);
    characters.push({ id: who.id, asset: cast.asset, wardrobe: cast.wardrobe, start: { ...start, heading }, props, events, expression: shot.emotion === "fear" ? "fear" : shot.emotion === "shock" ? "surprised" : "neutral" });
    notes.push(...events.map((e) => `${e.at.toFixed(2)} ${e.action}${typeof e.target === "string" ? ` -> ${e.target}` : ""}${e.prop ? ` (${e.prop})` : ""}`));
  }

  // camera: shot size + movement from the Director; a moving subject is followed
  const moving = characters[0]?.events.some((e) => e.action === "walk" || e.action === "run");
  let move = CAMERA_MOVE[shot.motion.type];
  if (moving && (move === "static" || move === "pan")) move = "follow";
  const camShot = CAMERA_SHOT[shot.shotType];
  const camera: CameraSpec3D = {
    shot: camShot, move, target: who?.id ?? "door", side: inp.seed % 2 ? 1 : -1,
    behind: shot.shotType === "over-shoulder" || shot.shotType === "pov" || (moving && camShot !== "closeup"),
    // a character facing into the set (the door) is seen in three-quarter profile, the place it looks at in the same frame
    ...(!moving && camShot !== "over_shoulder" && who ? { angle: camShot === "closeup" ? 0.8 : 0.95 } : {}),
    ...(characters[0]?.events.some((e) => e.action === "react" || e.action === "surprise" || e.action === "fear") || move === "push_in" ? { toward: "doorway" } : {}),
  };
  const spec: Shot3DSpec = {
    id: shot.id, duration: D, width: inp.width, height: inp.height, fps: inp.fps, seed: inp.seed, lighting,
    environment: { kind: "warehouse-exterior", backdrop: inp.backdrop?.(loc), wallTexture: inp.wallTexture?.(loc), objects: objs, weather: { rain: /(rain|storm|wet)/.test(text) ? 0.8 : 0, fog: undefined } },
    characters, camera,
  };
  return { spec, notes };
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
