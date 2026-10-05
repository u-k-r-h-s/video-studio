import type { AnimationSettings, Character, Shot, ShotAnimAction, ShotObjectAction, Story } from "@studio/shared";
import { DEFAULT_DURATION, placeAction } from "./actions";
import { effectsForLocation, type AssetManifest } from "./manifest";
import { classifyProp, impliedActions, MOVING, normName, resolveDirection, viewFor, type Direction } from "./semantics";
import type { AnimShotSpec, AnimationEvent, EffectSpec, EventType, VisualLayer } from "./types";

export const STAGE = { W: 1080, H: 1920 } as const;

/** How a framing places the character: on-screen height, feet position, and how far the camera is zoomed on the head. */
interface Framing { kind: "wide" | "medium" | "close" | "extreme"; heightMul: number; feetY: number; zoom: number; camY: number; soft: boolean }
const FRAMES: Record<Framing["kind"], Framing> = {
  wide: { kind: "wide", heightMul: 1, feetY: 1560, zoom: 1, camY: 960, soft: false },
  medium: { kind: "medium", heightMul: 1.38, feetY: 1740, zoom: 1, camY: 1000, soft: false },
  close: { kind: "close", heightMul: 1.67, feetY: 2020, zoom: 1.85, camY: 780, soft: true },
  extreme: { kind: "extreme", heightMul: 1.67, feetY: 2020, zoom: 2.3, camY: 760, soft: true },
};
export function framingOf(shotType: Shot["shotType"]): Framing {
  switch (shotType) {
    case "extreme-close-up": return FRAMES.extreme;
    case "close-up": case "medium-close": return FRAMES.close;
    case "medium": case "over-shoulder": case "pov": return FRAMES.medium;
    default: return FRAMES.wide;
  }
}

const WALK_SPEED = 520, RUN_SPEED = 1000;
/** A change of camera view is a short cross-dissolve between two cut-outs (a long one is a visible double exposure). */
const VIEW_BLEND = 0.1;

/** The least time a shot needs for its physical action to be seen (a walk must cross the screen, a door needs time to open). */
export function minShotDuration(shot: Pick<Shot, "subjectIds" | "shotType" | "emotion" | "animation" | "beat" | "dialogue">): number {
  let min = 1.4;
  for (const a of impliedActions(shot)) {
    if (a.action === "walk" || a.action === "enter" || a.action === "exit") min = Math.max(min, 2.6);
    else if (a.action === "run") min = Math.max(min, 2.0);
    else if (a.action === "turn" || a.action === "head-turn") min = Math.max(min, 1.6);
    else if (a.action === "step-forward" || a.action === "step-back") min = Math.max(min, 1.4);
    else if (a.action === "nod" || a.action === "shake-head") min = Math.max(min, 1.5);
  }
  for (const o of shot.animation?.objects ?? []) {
    if (o.action === "open" || o.action === "close") min = Math.max(min, 2.6);
    else if (o.action === "drive") min = Math.max(min, 2.2);
    else min = Math.max(min, 1.6);
  }
  return min;
}

export interface ComposeInput {
  shot: Shot;
  story: Story;
  characters: Character[];
  manifest: AssetManifest;
  anim: AnimationSettings;
  /** Final shot length from the edit timeline (seconds). */
  duration: number;
  fps: number;
  seed: number;
  /** Does the library hold this asset (so the composer never points a layer at art that failed to generate)? */
  has: (assetId: string) => boolean;
}
export interface ComposedShot {
  spec: AnimShotSpec;
  /** Vertical centre of captions (fraction of the height). */
  captionY: number;
  /** A phone message to draw onto the phone's screen, if the shot has one. */
  phoneMessage?: { text: string; key: string; asset: string };
  /** What the compiler decided, in words (for logs and tests). */
  notes: string[];
}

const warmWords = /(lamp|lantern|candle|warm|golden|sunset|amber|fire|yellow|incandescent|fluorescent|interior|hallway|corridor|elevator|lobby)/i;

/**
 * The animation compiler: a shot (what the director meant) -> layers, timed events, effects and camera. Everything is derived
 * from semantic actions with fixed rules: where a walk goes, which camera view of the character is shown, how an object
 * moves, what the camera does about it. No coordinates, frame numbers or transforms ever come from the model.
 */
export function composeShot(inp: ComposeInput): ComposedShot {
  const { shot, story, manifest, anim, duration: D } = inp;
  const { W, H } = STAGE;
  const notes: string[] = [];
  const loc = story.locations.find((l) => l.id === shot.locationId) ?? story.locations[0]!;
  const who = shot.subjectIds[0] && inp.has(shot.subjectIds[0]) ? shot.subjectIds[0] : undefined;
  if (shot.subjectIds[0] && !who) notes.push(`character ${shot.subjectIds[0]} has no art: shown as an empty place`);
  const objects: ShotObjectAction[] = shot.animation?.objects ?? [];
  const actions = who ? impliedActions(shot) : [];
  const mover = actions.find((a) => MOVING.has(a.action) && a.action !== "step-forward" && a.action !== "step-back");
  let frame = framingOf(shot.shotType);
  if (mover && (frame.kind === "close" || frame.kind === "extreme")) { frame = FRAMES.medium; notes.push("a moving character needs room: framed as a medium shot"); }
  const charH0 = anim.characterHeight;
  const charH = Math.round(charH0 * frame.heightMul);
  const layers: VisualLayer[] = [];
  const events: AnimationEvent[] = [];
  const effects: EffectSpec[] = [];
  const bgParallax = frame.soft ? 0.3 : 0.55;
  const warm = warmWords.test(`${loc.visualIdentity} ${loc.lighting} ${loc.description}`);
  const tint = warm ? "#2a1c10" : "#10182c";
  const rimColor = warm ? "#ffd9a0" : "#8fbaff";
  const ev = (targetId: string, type: EventType, start: number, duration: number, params?: AnimationEvent["params"]): void => { events.push({ targetId, type, start, duration, ...(params ? { params } : {}) }); };

  // background
  const locAsset = manifest.locations.find((l) => l.id === loc.id)?.assetId ?? `loc-${loc.id}`;
  if (!inp.has(locAsset)) notes.push(`background ${locAsset} is missing`);
  layers.push({ id: "bg", type: "background", source: frame.soft ? `${locAsset}-soft` : locAsset, x: W / 2, y: H / 2, scale: 1, opacity: 1, zIndex: 0, parallax: bgParallax, height: H * 1.15 });

  // ground position of the action and where things happen
  let startX = W / 2, endX = W / 2, startY = frame.feetY, endY = frame.feetY, startScale = 1, endScale = 1;
  let moverDir: Direction | null = null, targetObject: string | undefined;
  let moverEvent: { start: number; duration: number } | null = null;
  if (mover && who) {
    const r = resolveDirection(mover, objects);
    moverDir = r.dir;
    targetObject = r.object;
    const m = placeAction(mover.when, mover.duration ?? Math.max(DEFAULT_DURATION[mover.action] ?? 0.7, D * (1 - 0.04) - 0.5), D);
    moverEvent = m;
    const speed = (mover.action === "run" ? RUN_SPEED : WALK_SPEED) * (charH0 / 900);
    const dist = Math.min(speed * m.duration * 0.9, 3000);
    if (moverDir === "right" || moverDir === "object") { startX = 0.15 * W; endX = startX + dist; }
    else if (moverDir === "left") { startX = 0.85 * W; endX = startX - dist; }
    else if (moverDir === "camera") { startX = W / 2; endX = W / 2; startY = frame.feetY - 260; endY = frame.feetY + 140; startScale = 0.5; endScale = 1; }
    else { startX = W / 2; endX = W / 2; startY = frame.feetY + 140; endY = frame.feetY - 260; startScale = 1; endScale = 0.5; }
    notes.push(`${mover.action} ${moverDir}${targetObject ? ` toward ${targetObject}` : ""}`);
  } else if (who) {
    startX = endX = W / 2;
  }

  // props
  let phoneLayered = false;
  let phoneMessage: ComposedShot["phoneMessage"];
  const propLayerId = new Map<string, string>();
  for (const o of objects) {
    const kind = classifyProp(o.object);
    const key = kind === "generic" || kind === "picture" ? normName(o.object) : kind;
    const asset = manifest.props.find((p) => p.id === key)?.assetId;
    if (!asset || !inp.has(asset)) { notes.push(`prop "${o.object}" has no art: skipped`); continue; }
    const id = `obj-${key}`;
    propLayerId.set(normName(o.object), id);
    const groundY = frame.feetY;
    if (kind === "door") {
      const doorX = moverDir === "object" ? endX + 0.5 * charH : W * 0.66;
      const dh = Math.round(charH * 1.18);
      layers.push({ id, type: "prop", source: asset, x: doorX, y: groundY, scale: 1, opacity: 1, zIndex: 8, height: dh, parallax: bgParallax, door: { hinge: "left", glow: "#ffcf8a" }, shadow: false });
    } else if (kind === "phone" && (frame.kind === "close" || frame.kind === "extreme") && who) {
      phoneLayered = true;
      layers.push({ id, type: "foreground", source: asset, x: 690, y: 1950, scale: 1, opacity: 1, zIndex: 40, height: 430, parallax: 1 });
      layers.push({ id: `${id}-lit`, type: "foreground", source: shot.insert?.kind === "phone" ? `${asset}-msg-${shot.id}` : `${asset}-lit`, x: 690, y: 1950, scale: 1, opacity: 0, zIndex: 41, height: 430, parallax: 1, attach: id });
      if (shot.insert?.kind === "phone") phoneMessage = { text: shot.insert.text, key: `${asset}-msg-${shot.id}`, asset };
    } else if (kind === "car") {
      layers.push({ id, type: "prop", source: asset, x: -300, y: groundY - 25, scale: 1, opacity: 1, zIndex: 10, height: Math.round(charH0 * 0.2), parallax: bgParallax, flipX: true, tint: "#05080f", tintAmount: 0.6, shadow: false });
    } else if (kind === "picture") {
      // hangs on the wall behind the character, at head height, and moves with the background
      layers.push({ id, type: "prop", source: asset, x: Math.min(W - 230, Math.max(230, endX + 0.5 * charH)), y: groundY - Math.round(charH * 0.5), scale: 1, opacity: 1, zIndex: 6, height: Math.round(charH * 0.38), parallax: bgParallax, tint, tintAmount: 0.15, shadow: false });
    } else if (kind === "package" || kind === "generic") {
      layers.push({ id, type: "prop", source: asset, x: Math.min(W - 160, endX + 0.55 * charH), y: groundY + 8, scale: 1, opacity: 1, zIndex: 14, height: Math.round(charH * 0.24), parallax: 1, tint, tintAmount: 0.2 });
    }
  }

  // the character
  if (who) {
    const c = inp.characters.find((x) => x.id === who);
    layers.push({
      id: who, type: "character", source: who, x: startX, y: startY, scale: startScale, opacity: 1, zIndex: 20, height: charH, shadow: true, tint, tintAmount: warm ? 0.3 : 0.26,
      rim: { color: rimColor, side: warm ? -1 : 1, amount: 0.45 }, ...(c ? {} : {}),
    });
    const sceneActs: ShotAnimAction[] = actions;
    for (const a of sceneActs) {
      const base = DEFAULT_DURATION[a.action] ?? 0.8;
      const isMove = a === mover;
      const dur = a.duration ?? (isMove ? moverEvent!.duration : base);
      const { start, duration } = isMove ? moverEvent! : placeAction(a.when, dur, D);
      const params: AnimationEvent["params"] = {};
      const dir = resolveDirection(a, objects);
      if (isMove) {
        params.to = endX;
        if (moverDir === "camera" || moverDir === "away") { params.y = endY; params.scale = endScale; }
        const v = viewFor(a.action, dir.dir);
        if (v) ev(who, "view", Math.max(0, start - 0.05), VIEW_BLEND, { to: v });
        ev(who, a.action as EventType, start, duration, params);
        // after the move, face the camera again if something else follows (a look, a line, a reaction)
        const after = start + duration;
        if (v && v !== "front" && (sceneActs.some((o) => o !== a && placeAction(o.when, 0.5, D).start >= after - 0.05) || shot.dialogue.length)) ev(who, "view", Math.min(D - 0.3, after + 0.05), VIEW_BLEND, { to: "front" });
        continue;
      }
      if (a.action === "turn" || a.action === "head-turn") {
        const to = a.to === "left" || a.to === "right" || a.to === "camera" ? a.to : dir.dir === "left" ? "left" : dir.dir === "camera" ? "camera" : "right";
        params.to = to;
        if (a.action === "turn") {
          ev(who, "view", start, VIEW_BLEND, { to: "three-quarter" });
          if (to !== "camera") ev(who, "view", start + 0.25, VIEW_BLEND, { to: "side" });
          else ev(who, "view", start + 0.2, VIEW_BLEND, { to: "front" });
        }
      } else if (a.action === "look-left" || a.action === "look-right") {
        // looking toward something to one side with the whole body reads as a turn: three-quarter view if the art exists
        if (frame.kind === "wide" || frame.kind === "medium") ev(who, "view", Math.max(0, start - 0.05), VIEW_BLEND, { to: "three-quarter" });
      }
      ev(who, a.action as EventType, start, duration, Object.keys(params).length ? params : undefined);
    }
  }

  // object events
  for (const o of objects) {
    const id = propLayerId.get(normName(o.object));
    const kind = classifyProp(o.object);
    if (!id) {
      // a phone in a wide shot has no sprite: its light falls on the character instead
      if (kind === "phone" && who) { const { start, duration } = placeAction(o.when, 1.6, D); ev(who, "glow", start, duration, { color: "#8fd0ff", amount: 0.9, sfx: "ping" }); notes.push("phone light on the character"); }
      continue;
    }
    const dur = o.duration ?? (o.action === "open" || o.action === "close" ? 0.9 : o.action === "drive" ? Math.max(1.4, D * 0.55) : 0.7);
    const { start, duration } = placeAction(o.when, dur, D);
    if (kind === "phone" && phoneLayered) {
      if (o.action === "appear" || o.action === "move" || o.action === "glow") {
        ev(id, "move", Math.max(0, start - 0.2), 0.85, { x: 680, y: 1520, ease: "out" });
        ev(id, "shake", Math.max(0, start - 0.2), Math.min(1.9, D - start), { amount: 5 });
        ev(`${id}-lit`, "fade", start + 0.6, 0.1, { to: 1 });
        ev(`${id}-lit`, "glow", start + 0.6, Math.max(0.5, D - start - 0.6), { color: "#9fd6ff", radius: 230, amount: 0.55, sfx: "ping" });
        if (who) ev(who, "glow", start + 0.6, Math.max(0.5, D - start - 0.6), { color: "#8fd0ff", amount: 0.9 });
      } else ev(id, o.action as EventType, start, duration);
      continue;
    }
    if (kind === "car" && o.action === "drive") {
      const speedC = 1250 * (charH0 / 900);
      const tp = start + duration * 0.45; // the car passes the character here
      const xChar = moverEvent ? startX + (endX - startX) * Math.min(1, Math.max(0, (tp - moverEvent.start) / moverEvent.duration)) : W / 2;
      const xs = xChar - speedC * (tp - start) - 100, xe = xs + speedC * duration;
      layers.find((l) => l.id === id)!.x = xs;
      ev(id, "drive", start, duration, { x: xe, y: layers.find((l) => l.id === id)!.y });
      ev(id, "glow", start, duration, { color: "#ffe1a8", radius: 300, amount: 0.8, sfx: "whoosh", sfxAt: duration * 0.35 });
      continue;
    }
    if ((kind === "package" || kind === "generic") && o.action === "appear") {
      // it drops in from above and lands
      const l = layers.find((x) => x.id === id)!;
      const y1 = l.y;
      l.y = y1 - 260;
      ev(id, "appear", start, 0.3, { pop: false });
      ev(id, "move", start, 0.4, { x: l.x, y: y1, ease: "in" });
      continue;
    }
    ev(id, o.action as EventType, start, duration);
  }

  // effects from the place, plus something alive in every shot
  const found = effectsForLocation(loc);
  const intensity = shot.beat === "escalation" || shot.beat === "payoff" ? 0.9 : 0.7;
  if (found.includes("rain")) effects.push({ type: "rain", intensity, layer: "front", angle: 12 });
  if (found.includes("fog") || !found.length) effects.push({ type: "fog", intensity: 0.55, layer: "back" });
  if (found.includes("snow")) effects.push({ type: "snow", intensity: 0.7, layer: "front" });
  if (found.includes("leaves")) effects.push({ type: "leaves", intensity: 0.6, layer: "front" });
  if (found.includes("dust") || !found.length) effects.push({ type: "dust", intensity: 0.5, layer: "front" });
  if (found.includes("lightFlicker")) effects.push({ type: "lightFlicker", x: warm ? 540 : 1500, y: warm ? 420 : 640, radius: 700, color: warm ? "#ffe9c4" : "#ff9a5a", intensity: 0.8, layer: "front", seed: (inp.seed % 9) + 2 });
  if (mover?.action === "run") effects.push({ type: "streaks", intensity: 0.8, layer: "front", start: 0.2 });

  // camera: it follows a walker, pushes in on faces, shakes at a startle or an impact
  const cam = (start: number, duration: number, params: AnimationEvent["params"]): void => ev("camera", "camera", start, duration, params);
  let camera = { x: W / 2, y: H / 2, zoom: 1, rotation: 0 };
  if (mover && who && (moverDir === "left" || moverDir === "right" || moverDir === "object")) {
    cam(0, D, { mode: "follow", target: who, screenX: moverDir === "left" ? 0.62 : 0.38, tau: mover.action === "run" ? 0.25 : 0.35 });
    cam(0, D, { mode: "push", zoom: 1.08 });
  } else if (frame.kind === "close" || frame.kind === "extreme") {
    camera = { x: 560, y: frame.camY, zoom: frame.zoom - 0.1, rotation: 0 };
    cam(0, D, { mode: "push", zoom: frame.zoom + 0.1 });
  } else if (who) {
    camera = { x: W / 2 + 40, y: frame.camY, zoom: 1.0, rotation: 0 };
    cam(0, D, { mode: "push", zoom: shot.emotion === "calm" ? 1.08 : 1.22 });
    cam(0, D, { mode: "pan", x: W / 2 + 120, y: frame.camY });
  } else {
    camera = { x: W / 2 - 160, y: H / 2, zoom: 1.0, rotation: 0 };
    cam(0, D, { mode: "pan", x: W / 2 + 160, y: H / 2 });
    cam(0, D, { mode: "push", zoom: 1.14 });
  }
  for (const a of actions) if (a.action === "surprise" || a.action === "react" || a.action === "fear" || a.action === "anger") {
    const { start } = placeAction(a.when, 0.8, D);
    cam(start, Math.min(1.2, D - start), { mode: "shake", amount: a.action === "fear" ? 18 : 28, decay: 4.5, impact: a.action === "surprise" || a.action === "react" });
  }
  if (shot.effects?.impact) cam(0, Math.min(1.2, D), { mode: "shake", amount: 30, decay: 4.5 });
  if (shot.effects?.flash) cam(0, 0.5, { mode: "flash", amount: 0.5 });

  const spec: AnimShotSpec = { id: shot.id, duration: D, width: STAGE.W, height: STAGE.H, fps: inp.fps, layers, events: events.sort((a, b) => a.start - b.start), effects, camera, seed: inp.seed };
  return { spec, captionY: frame.kind === "close" || frame.kind === "extreme" ? 0.8 : 0.72, phoneMessage, notes };
}
