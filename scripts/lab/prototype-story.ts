// Hand-authored prototype story: "The Last Delivery" (original). The Ollama director will later produce this same structure.
import { StorySchema, type Shot, type Story } from "../../packages/shared/src";
import { planCamera } from "../../apps/server/src/shots/cameraLanguage";

type Draft = Omit<Shot, "id" | "order" | "camera" | "motion" | "sceneId"> & { motion?: Shot["motion"]["type"]; sceneId?: string; visualPrompt?: string };
const drafts: Draft[] = [
  { beat: "hook", duration: 2.4, shotType: "extreme-close-up", subjectIds: [], locationId: "street", emotion: "curious", action: "a phone buzzes in the dark; the order name is the rider's own", visualPrompt: "hands holding a glowing phone", visualKey: "k1-phone-v13",
    focus: { x: 0.55, y: 0.5, rx: 0.5, ry: 0.35 }, transition: { type: "cut" }, characterMotion: [], dialogue: [{ id: "d01", characterId: "kai", text: "The last order of the night. The name on it was mine.", emphasis: ["mine"] }], sfx: [{ kind: "ping", at: 0.15 }, { kind: "riser", at: 0.2, volume: 0.35 }], insert: { kind: "phone", text: "NEW ORDER\nDELIVER TO: KAI" } },
  { beat: "setup", duration: 2.8, shotType: "establishing", subjectIds: ["kai"], locationId: "street", emotion: "uneasy", action: "a lone rider stands tiny at the far end of a narrow alley", visualPrompt: "wide alley, rider far away", visualKey: "k2-alley-wide",
    focus: { x: 0.48, y: 0.78, rx: 0.2, ry: 0.13 }, transition: { type: "cut" }, characterMotion: [], dialogue: [{ id: "d02", characterId: "kai", text: "Sundial Court. Nobody has lived there for years." }], sfx: [{ kind: "footsteps", at: 0.4, volume: 0.3 }] },
  { beat: "curiosity", duration: 1.8, shotType: "low-angle", subjectIds: [], locationId: "street", emotion: "eerie", action: "the tower block looms over the street, its windows glowing like eyes", visualPrompt: "tower block from below", visualKey: "k3-building-v35",
    focus: { x: 0.5, y: 0.5, rx: 0.7, ry: 0.7 }, transition: { type: "cut" }, characterMotion: [], dialogue: [], sfx: [{ kind: "glitch", at: 0.5, volume: 0.25 }] },
  { beat: "curiosity", duration: 2.2, shotType: "medium-close", subjectIds: ["kai"], locationId: "street", emotion: "uneasy", action: "Kai looks up, wary, hand tight on the handlebar", visualPrompt: "rider portrait uneasy", visualKey: "k4-rider-uneasy",
    transition: { type: "cut" }, characterMotion: [{ action: "breathing" }, { action: "nod", at: 0.9, strength: 0.4 }], dialogue: [{ id: "d03", characterId: "kai", text: "Hello? Delivery for... me?" }], sfx: [{ kind: "heartbeat", at: 0.2, volume: 0.35 }] },
  { beat: "conflict", duration: 2.2, shotType: "wide", subjectIds: [], locationId: "lobby", emotion: "eerie", action: "the old elevator doors slide open by themselves, warm light spills out", visualPrompt: "lobby elevator opening", visualKey: "k6-lobby-elevator",
    focus: { x: 0.5, y: 0.55, rx: 0.6, ry: 0.5 }, transition: { type: "cut" }, characterMotion: [], dialogue: [], sfx: [{ kind: "ding", at: 0.2 }, { kind: "door", at: 0.35, volume: 0.45 }] },
  { beat: "conflict", duration: 2.2, shotType: "medium", subjectIds: ["customer"], locationId: "elevator", emotion: "eerie", action: "a man in a long coat waits inside the elevator without looking at Kai", visualPrompt: "man in elevator profile", visualKey: "k7-elevator-inside",
    focus: { x: 0.46, y: 0.5, rx: 0.3, ry: 0.42 }, transition: { type: "zoom", duration: 0.3 }, characterMotion: [{ action: "breathing" }], dialogue: [{ id: "d04", characterId: "customer", text: "You are late, Kai. Again.", emphasis: ["again"] }], sfx: [] },
  { beat: "escalation", duration: 1.6, shotType: "close-up", subjectIds: ["kai"], locationId: "street", emotion: "shock", action: "Kai freezes, eyes wide: he has never been here before", visualPrompt: "rider shocked", visualKey: "k5-rider-shock",
    transition: { type: "cut" }, characterMotion: [{ action: "surprise", at: 0.05, strength: 0.9 }, { action: "fear", strength: 0.8 }], dialogue: [{ id: "d05", characterId: "kai", text: "Again?!", emphasis: ["again"] }], sfx: [{ kind: "impact", at: 0.0, volume: 0.6 }], effects: { impact: true } },
  { beat: "escalation", duration: 2.0, shotType: "extreme-close-up", subjectIds: [], locationId: "street", emotion: "tense", action: "the phone glitches and shows the delivery was completed every night", visualPrompt: "phone glitching", visualKey: "k1-phone",
    focus: { x: 0.5, y: 0.7, rx: 0.55, ry: 0.3 }, transition: { type: "cut" }, characterMotion: [], dialogue: [{ id: "d06", characterId: "customer", text: "You always come back." }], sfx: [{ kind: "glitch", at: 0.1 }], insert: { kind: "phone", text: "DELIVERED\nEVERY NIGHT" }, effects: { flash: true } },
  { beat: "payoff", duration: 1.8, shotType: "extreme-close-up", subjectIds: ["double"], locationId: "elevator", emotion: "eerie", action: "Kai's double smiles calmly: it has been waiting", visualPrompt: "double smile", visualKey: "k8-double-smile",
    transition: { type: "fade", duration: 0.35 }, characterMotion: [{ action: "smile", strength: 0.8 }, { action: "breathing" }], dialogue: [{ id: "d07", characterId: "customer", text: "Welcome home." }], sfx: [{ kind: "impact", at: 0.05 }], effects: { impact: true, flash: true } },
  { beat: "payoff", duration: 2.2, shotType: "wide", subjectIds: [], locationId: "street", emotion: "calm", action: "the building goes dark, the title appears", visualPrompt: "building closing shot", visualKey: "k3-building-v34",
    focus: { x: 0.5, y: 0.5, rx: 0.7, ry: 0.7 }, transition: { type: "fade" }, characterMotion: [], dialogue: [], sfx: [], insert: { kind: "title", text: "THE LAST DELIVERY" }, motion: "pull-out" },
];

const sceneOf = (i: number): string => (i < 4 ? "scene-1" : i < 6 ? "scene-2" : "scene-3");
const shots: Shot[] = drafts.map((d, i) => {
  const order = i + 1;
  const { camera, motion } = planCamera({ shotType: d.shotType, beat: d.beat, emotion: d.emotion, action: d.action, duration: d.duration, order, motion: d.motion });
  const { motion: _m, sceneId: _s, ...rest } = d;
  return { ...rest, id: `shot-${String(order).padStart(2, "0")}`, order, sceneId: sceneOf(i), camera, motion, visualPrompt: d.visualPrompt ?? d.action } as Shot;
});

export const PROTO_STORY: Story = StorySchema.parse({
  logline: "A delivery rider's last order of the night is addressed to himself, and leads to a building that has been waiting for him.",
  beats: [
    { kind: "hook", summary: "The phone shows an order with the rider's own name." },
    { kind: "setup", summary: "He rides to an abandoned address at night." },
    { kind: "curiosity", summary: "The building is dead, but an elevator opens by itself." },
    { kind: "conflict", summary: "A stranger inside knows his name and says he is late." },
    { kind: "escalation", summary: "The phone says he has delivered here every night." },
    { kind: "payoff", summary: "His double smiles: he never left." },
  ],
  locations: [
    { id: "street", name: "Sundial Court street", description: "narrow old city alley outside an abandoned building", visualIdentity: "narrow old city alley at night, wet pavement, warm lanterns, cool blue haze", lighting: "warm lantern light against cold blue haze", importantObjects: ["lanterns", "brick walls"] },
    { id: "lobby", name: "Abandoned lobby", description: "dusty marble lobby with one working elevator", visualIdentity: "dim abandoned lobby, cracked marble, single old elevator", lighting: "one flickering ceiling light, warm elevator glow", importantObjects: ["elevator"] },
    { id: "elevator", name: "The elevator", description: "small old elevator with yellow light", visualIdentity: "small old elevator with warm yellow light", lighting: "warm yellow, strong contrast", importantObjects: [] },
  ],
  scenes: [
    { id: "scene-1", locationId: "street", beat: "hook", summary: "The order arrives and Kai rides to Sundial Court.", shotIds: shots.slice(0, 4).map((s) => s.id) },
    { id: "scene-2", locationId: "lobby", beat: "conflict", summary: "The elevator opens and the customer waits inside.", shotIds: shots.slice(4, 6).map((s) => s.id) },
    { id: "scene-3", locationId: "elevator", beat: "payoff", summary: "Kai learns he has always been coming back.", shotIds: shots.slice(6).map((s) => s.id) },
  ],
  shots,
  keyVisuals: [],
});
export const VOICE_OF: Record<string, string> = { kai: "en-a", customer: "en-b", narrator: "en-narrator" };
