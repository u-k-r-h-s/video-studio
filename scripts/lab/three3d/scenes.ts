// Visual Quality V2 test scenes, written exactly as the AI Director writes shots (semantic actions, objects, shot size,
// camera motion, emotion; locations with timeOfDay/weather). Nothing 3D-specific in here: the 3D compiler and renderer do the rest.
import type { Character, Shot, Story } from "@studio/shared";

const base = { visualPrompt: "", visualKey: "", dialogue: [], sfx: [], characterMotion: [], transition: { type: "cut" as const }, focus: { x: 0.5, y: 0.4 }, camera: { startScale: 1, endScale: 1, startX: 0.5, endX: 0.5, startY: 0.5, endY: 0.5 } };
const act = (action: string, when: string, toward?: string) => ({ character: "rider", action, when, ...(toward ? { toward } : {}) });
const obj = (object: string, action: string, when: string) => ({ object, action, when });

export interface Scene { name: string; characters: Character[]; story: Pick<Story, "locations">; shots: Shot[]; continuity?: (i: number, spec: import("../../../apps/server/src/anim/renderers/three3d/spec").Shot3DSpec) => void }

export const NIGHT: Scene = {
  name: "night",
  characters: [{ id: "rider", name: "Sam", description: "a night-shift delivery rider", appearance: "a young man with short brown hair", clothing: "orange courier jacket and dark trousers with a delivery bag", visualIdentity: "" }],
  story: { locations: [{ id: "warehouse", name: "Abandoned warehouse", description: "an abandoned warehouse loading bay", visualIdentity: "abandoned corrugated-metal warehouse, wet asphalt, one lamp over a heavy door", lighting: "cold moonlight, a warm lamp over the door", importantObjects: ["door"], timeOfDay: "night", weather: "rain" }] },
  shots: [
    { ...base, id: "shot-01", sceneId: "scene-01", order: 1, locationId: "warehouse", subjectIds: ["rider"], beat: "setup", duration: 4.6, shotType: "tracking", emotion: "uneasy", action: "Sam walks through the rain toward the warehouse door and slows down.", motion: { type: "tracking" },
      animation: { actions: [act("walk", "start", "the warehouse door"), act("head-turn", "end", "the door")], objects: [] } },
    { ...base, id: "shot-02", sceneId: "scene-01", order: 2, locationId: "warehouse", subjectIds: ["rider"], beat: "curiosity", duration: 5.6, shotType: "over-shoulder", emotion: "tense", action: "He raises his flashlight at the door, steps closer, hesitates, then pushes it open; warm light spills out.", motion: { type: "push-in" },
      animation: { actions: [act("raise-object", "start", "the door"), act("walk", "early", "the door"), act("hesitate", "mid"), act("push", "late", "the door")], objects: [obj("flashlight", "glow", "start"), obj("door", "open", "late")] } },
    { ...base, id: "shot-03", sceneId: "scene-01", order: 3, locationId: "warehouse", subjectIds: ["rider"], beat: "escalation", duration: 4.2, shotType: "medium", emotion: "fear", action: "He looks inside. Something moves. His head snaps back, his body pulls away and he steps back.", motion: { type: "push-in" },
      animation: { actions: [act("raise-object", "start", "inside"), act("head-turn", "start", "inside"), act("surprise", "mid")], objects: [obj("flashlight", "glow", "start")] } },
  ] as unknown as Shot[],
  continuity: (i, spec) => { if (i === 2) spec.environment.objects.find((o) => o.id === "door")!.events = [{ at: -10, action: "open", duration: 0.01 }]; },
};

export const DAY: Scene = {
  name: "day",
  characters: [{ id: "rider", name: "Sam", description: "a cheerful delivery courier", appearance: "a young man with short brown hair", clothing: "yellow courier jacket and blue trousers with a delivery bag", visualIdentity: "" }],
  story: { locations: [{ id: "maple", name: "Maple Street", description: "a sunny suburban street", visualIdentity: "sunny suburban street with colourful houses, front lawns, trees and a sidewalk", lighting: "bright midday sun, blue sky", importantObjects: ["door", "doorbell"], timeOfDay: "day", weather: "sunny" }] },
  shots: [
    { ...base, id: "shot-01", sceneId: "scene-01", order: 1, locationId: "maple", subjectIds: ["rider"], beat: "setup", duration: 4.0, shotType: "tracking", emotion: "joy", action: "Sam walks down the sunny street carrying a package.", motion: { type: "tracking" },
      animation: { actions: [act("walk", "start", "down the street")], objects: [obj("package", "hold", "start")] } },
    { ...base, id: "shot-02", sceneId: "scene-01", order: 2, locationId: "maple", subjectIds: ["rider"], beat: "curiosity", duration: 4.4, shotType: "medium", emotion: "curious", action: "He checks the house number, hitches the package up and walks to the door.", motion: { type: "static" },
      animation: { actions: [act("head-turn", "start", "the address"), act("adjust", "early"), act("walk", "mid", "the door")], objects: [obj("package", "hold", "start")] } },
    { ...base, id: "shot-03", sceneId: "scene-01", order: 3, locationId: "maple", subjectIds: ["rider"], beat: "conflict", duration: 3.8, shotType: "medium-close", emotion: "curious", action: "He presses the doorbell and waits. A strange noise comes from inside; his head turns first, then his body.", motion: { type: "static" },
      animation: { actions: [act("press", "start", "the doorbell"), act("hesitate", "early"), act("head-turn", "mid", "inside"), act("surprise", "late")], objects: [obj("package", "hold", "start")] } },
    { ...base, id: "shot-04", sceneId: "scene-01", order: 4, locationId: "maple", subjectIds: ["rider"], beat: "payoff", duration: 3.4, shotType: "medium", emotion: "shock", action: "The door swings open. Sam leans back in surprise.", motion: { type: "push-in" },
      animation: { actions: [act("surprise", "early")], objects: [obj("package", "hold", "start"), obj("door", "open", "start")] } },
  ] as unknown as Shot[],
};
