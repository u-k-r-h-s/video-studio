import type { Location, Shot, Story } from "@studio/shared";
import { artStyleOf, type ArtStyleId, type Palette } from "./artStyle";
import type { EnvironmentSpec3D, LightingPreset, VehicleKind3D, WorldSpec3D } from "./spec";

/**
 * The scene-by-scene visual direction of a story, decided BEFORE anything is rendered and from the story alone:
 * - per location (so every shot of a continuous scene shares it): the set kit, time of day, weather, lighting preset,
 *   rain / fog / wind, a power cut, the palette;
 * - per shot: the camera's angle, height and lens, varied deterministically (no shot repeats the previous angle; low
 *   angles for anger / shock / awe, high for sadness; one screen side per scene for continuity).
 * Nothing defaults to a particular story: no courier, no torch, no fixed daylight.
 */
export type Kit = Extract<EnvironmentSpec3D["kind"], "village" | "market" | "interior" | "road" | "neighborhood" | "warehouse-exterior" | "nature" | "city">;
export interface SceneDirection {
  locationId: string; kit: Kit; timeOfDay: "morning" | "day" | "golden_hour" | "sunset" | "night"; weather: "clear" | "sunny" | "cloudy" | "overcast" | "rain" | "fog";
  lighting: LightingPreset; rain: number; fog?: number; wind: number; lightsOut: boolean; palette: Palette;
  /** The living world around the set (landscape, sky life, traffic, pedestrians), with the reasons. */
  world: WorldSpec3D;
  /** Sun turned around the set for an open landscape (front light by day, raking at golden hour); else the preset's. */
  sunAzimuth?: number;
}
export interface ShotDirection { shotId: string; locationId: string; angle: number; side: number; heightOffset: number; fovScale: number; why: string }
export interface VisualPlan { artStyle: ArtStyleId; locations: SceneDirection[]; shots: ShotDirection[] }

const text = (l: Location): string => `${l.name} ${l.visualIdentity} ${l.description} ${l.lighting}`.toLowerCase();
const hash = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const CITY = /\b(city|downtown|metro|flyover|skyscrapers?|traffic|busy street|main road|city street|chowk|crossing|mumbai|delhi|kolkata|bengaluru|bangalore|chennai|hyderabad|pune|shahar)\b/;
const NATURE = /\b(river|riverbank|lake|pond|mountains?|hills?|valley|forest|jungle|woods|beach|sea|ocean|coast|shore|waterfall|meadow|nadi|jheel|talab|pahad|samundar|himalaya|snow)\b/;
export function kitOf(l: Location): Kit {
  const t = text(l);
  if (/\b(inside|interior|indoors|room|kitchen|living room|bedroom|hall|classroom|office|home interior|in the house|ghar ke andar)\b/.test(t)) return "interior";
  // a city street with shops is a street; a bazaar / haat / mandi / mela is the market lane
  if (CITY.test(t) && !/\b(village|gaon|gaanv|rural|bazaar|bazar|haat|mandi|mela|stalls|market)\b/.test(t)) return "city";
  if (/\b(market|bazaar|bazar|haat|mandi|stalls|fair|mela|shops)\b/.test(t)) return "market";
  if (/\b(warehouse|factory|industrial|dock|depot|hangar|loading bay|garage)\b/.test(t)) return "warehouse-exterior";
  if (/\b(courtyard|aangan|chaupal|haveli|mud house|hut)\b/.test(t)) return "village";
  if (/\b(road|highway|journey|bridge|bus stop|crossroads|country lane|dirt road|path through|fields? path)\b/.test(t)) return "road";
  if (NATURE.test(t)) return "nature";
  if (/\b(village|gaon|gaanv|rural|hut|mud house|courtyard|aangan|chaupal|well|farm|hamlet|haveli)\b/.test(t)) return "village";
  return "neighborhood";
}

export function directLocation(l: Location, palette: Palette): SceneDirection {
  const t = text(l);
  const tod: SceneDirection["timeOfDay"] = l.timeOfDay ?? (/(midnight|night|moonlight|moonlit|after dark|dark sky)/.test(t) ? "night" : /(sunset|dusk|evening)/.test(t) ? "sunset" : /(golden hour|golden light|late afternoon)/.test(t) ? "golden_hour" : /(dawn|sunrise|early morning|morning)/.test(t) ? "morning" : "day");
  const wx: SceneDirection["weather"] = l.weather ?? (/(rain|monsoon|storm|drizzle|downpour|wet)/.test(t) ? "rain" : /(fog|mist|haze|smog)/.test(t) ? "fog" : /(overcast|grey sky|gray sky|gloomy)/.test(t) ? "overcast" : /(cloud)/.test(t) ? "cloudy" : "sunny");
  const kit = kitOf(l);
  const outage = /(power cut|power outage|blackout|no electricity|bijli (gayi|chali)|lights? (went )?out|by candle ?light|only a candle|lantern light)/.test(t);
  const night = tod === "night";
  let lighting: LightingPreset;
  if (kit === "interior") lighting = outage ? "power-outage" : night || tod === "sunset" ? (/(cold|blue|tube|fluorescent)/.test(t) ? "cold-interior" : "warm-interior") : "indoor-daylight";
  else if (night) lighting = outage ? "power-outage" : wx === "rain" ? "rainy-night" : /(horror|eerie|creepy|ghost|abandoned|danger|thief|dramatic)/.test(t) ? "cinematic-night" : "night";
  else if (tod === "morning" && (wx === "fog" || /(mist|fog|haze)/.test(t))) lighting = "foggy-dawn";
  else if (tod === "sunset") lighting = "sunset";
  else if (tod === "golden_hour" || tod === "morning") lighting = wx === "rain" ? "rainy-day" : "golden-hour";
  else lighting = wx === "rain" ? "rainy-day" : wx === "fog" || wx === "overcast" ? "overcast" : wx === "cloudy" ? "cloudy-day" : "sunny-day";
  const rain = kit === "interior" || wx !== "rain" ? 0 : /(storm|downpour|heavy)/.test(t) ? 1 : /(drizzle|light rain)/.test(t) ? 0.4 : 0.8;
  const fog = wx === "fog" ? (kit === "interior" ? 0.01 : lighting === "foggy-dawn" ? 0.05 : 0.035) : undefined;
  const wind = /(storm|wind|breeze|gust)/.test(t) ? 1 : rain ? 0.7 : night ? 0.25 : 0.5;
  const world = planWorld(t, kit, { tod, wx, rain, wind, night });
  const sunAzimuth = kit === "nature" && !night && (lighting === "sunny-day" || lighting === "cloudy-day" || lighting === "golden-hour" || lighting === "sunset") ? (lighting === "golden-hour" || lighting === "sunset" ? 290 : 30) : undefined;
  return { locationId: l.id, kit, timeOfDay: tod, weather: wx, lighting, rain, ...(fog !== undefined ? { fog } : {}), wind, lightsOut: outage && (kit === "interior" || night), palette, world, ...(sunAzimuth !== undefined ? { sunAzimuth } : {}) };
}

const VEHICLE_WORDS: [RegExp, VehicleKind3D][] = [[/\b(bus|buses|bus stop|bus stand)\b/, "bus"], [/\b(auto|autos|rickshaw|tuk-?tuk)\b/, "auto"], [/\b(scooters?|scooty)\b/, "scooter"], [/\b(motorcycles?|motorbikes?|bikes?)\b/, "motorcycle"], [/\b(bicycles?|cycles?|cyclists?)\b/, "bicycle"], [/\b(cars?|taxis?|cabs?)\b/, "car"]];
/**
 * What lives around the set, from the place's own words and the scene's time and weather. Only listed elements are
 * built; each decision is recorded in `why`. Rules: nothing outdoor indoors; no sun or birds at night; no birds in rain;
 * vehicles only on a city street or a road that the story says has traffic / names a vehicle (a bus stop gets a bus that
 * stops), never in nature, a courtyard or a bazaar lane.
 */
export function planWorld(t: string, kit: Kit, s: { tod: SceneDirection["timeOfDay"]; wx: SceneDirection["weather"]; rain: number; wind: number; night: boolean }): WorldSpec3D {
  const why: string[] = [];
  if (kit === "interior") return { why: ["indoors: no sky, birds, traffic or landscape"] };
  const w: WorldSpec3D = { why };
  // landscape (the nature kit builds it)
  if (kit === "nature") {
    const relief = /\b(mountains?|himalaya|peaks?|snow|pahad|hill station)\b/.test(t) ? "mountains" : /\b(hills?|valley|slopes?)\b/.test(t) ? "hills" : "flat";
    const water = /\bwaterfall\b/.test(t) ? "waterfall" : /\b(beach|sea|ocean|coast|shore|samundar)\b/.test(t) ? "sea" : /\b(lake|pond|jheel|talab)\b/.test(t) ? "lake" : /\b(river|riverbank|stream|nadi|ghat)\b/.test(t) ? "river" : undefined;
    const crop = /\b(mustard|sarson)\b/.test(t) ? "mustard" : /\b(paddy|rice fields?|dhan)\b/.test(t) ? "paddy" : /\b(wheat|gehun|fields?|farm|khet)\b/.test(t) ? "wheat" : undefined;
    const forest = /\b(forest|jungle|woods)\b/.test(t) ? 0.95 : relief === "mountains" ? 0.6 : water === "sea" ? 0.45 : 0.35;
    w.landscape = { relief, ...(water ? { water } : {}), forest, grass: water === "sea" ? 0 : 0.8, ...(crop ? { crop } : {}), ...(water === "sea" ? { palms: true } : {}), ...(/\b(snow|snowy|himalaya|barf)\b/.test(t) ? { snow: true } : {}) };
    why.push(`landscape: ${relief}${water ? `, ${water}` : ""}${crop ? `, ${crop} fields` : ""}, forest ${forest} (from the place's words)`);
  }
  // sky life
  const cloudy = s.wx === "cloudy" || s.wx === "overcast" || s.rain > 0;
  const clouds = s.night ? (cloudy ? 6 : 3) : cloudy ? 14 : s.wx === "fog" ? 0 : 7;
  const birdsBase = kit === "nature" ? 10 : kit === "village" || kit === "road" ? 6 : kit === "city" || kit === "neighborhood" ? 4 : 0;
  const birds = s.night ? 0 : s.rain > 0 || s.wx === "fog" ? 0 : birdsBase;
  w.sky = { clouds, cloudSpeed: 1.5 + 4 * s.wind, birds };
  why.push(`sky: ${clouds} clouds${s.night ? " (night: dark, no sun)" : ""}; birds ${birds}${s.night ? " (none at night)" : s.rain > 0 ? " (none in rain)" : s.wx === "fog" ? " (none in fog)" : birdsBase ? "" : " (none for this kind of place)"}`);
  // traffic
  const named = VEHICLE_WORDS.filter(([re]) => re.test(t)).map(([, k]) => k);
  const generic = /\b(traffic|vehicles|busy road|rush hour|honking)\b/.test(t);
  if (kit === "city" || (kit === "road" && (named.length || generic))) {
    const mix: VehicleKind3D[] = named.length ? [...new Set(named)] : kit === "city" ? ["car", "auto", "scooter", "motorcycle", "car", "bus"] : ["scooter", "bicycle", "motorcycle"];
    if (kit === "city" && named.length === 1) mix.push("car", "scooter", "auto");
    if (kit === "road" && !named.includes("bicycle")) mix.push("bicycle");
    const busy = /\b(busy|traffic|rush|crowded|honking)\b/.test(t);
    const dirt = kit === "road" && /\b(dirt road|kachcha|kaccha|unpaved|dusty|mud road|earth road|gravel)\b/.test(t);
    const electric = (/\b(e-?rickshaw|electric auto|electric)\b/.test(t) ? ["auto"] : []) as VehicleKind3D[];
    w.traffic = { mix, rate: busy ? 10 : kit === "city" ? 6 : 3, lanes: kit === "city" ? 4 : 2, surface: dirt ? "dirt" : "tarmac", ...(electric.length ? { electric } : {}), ...(/\b(bus stop|bus stand|bus stops)\b/.test(t) ? { stop: { kind: "bus" as const, dwell: 6 } } : {}) };
    why.push(`traffic: ${mix.join("/")} at ${w.traffic.rate}/min/lane (${kit === "city" ? "a city street" : `the road names ${named.join(", ") || "traffic"}`})${w.traffic.stop ? "; the bus stops at the stop" : ""}`);
  } else why.push(kit === "road" ? "no traffic: the road's description names no vehicle" : `no traffic: ${kit} is not a road`);
  if (kit === "city") {
    w.streetlights = true;
    w.pedestrians = { assets: ["casual-man", "woman-casual", "farmer"], count: s.rain > 0.5 ? 3 : 6 };
    why.push(`pedestrians ${w.pedestrians.count} on the far pavement; streetlights`);
  }
  return w;
}

// close-ups stay fairly frontal: the mouth and the eyes carry the line
const ANGLES: Record<"close" | "medium" | "wide", number[]> = { close: [0.3, 0.5, 0.2, 0.62], medium: [0.65, 1.1, 0.4, 1.35, 0.9], wide: [1.25, 0.55, 1.7, 0.9, 2.05] };
const sizeOf = (s: Shot): "close" | "medium" | "wide" => (["close-up", "extreme-close-up", "medium-close", "pov"].includes(s.shotType) ? "close" : ["medium", "over-shoulder", "action"].includes(s.shotType) ? "medium" : "wide");

export function planVisuals(story: Story, styleId?: string): VisualPlan {
  const style = artStyleOf(styleId);
  const locations = story.locations.map((l, i) => directLocation(l, style.palettes[(hash(l.id) + i) % style.palettes.length]!));
  const shots: ShotDirection[] = [];
  let prev: { angle: number; loc: string } | null = null;
  story.shots.forEach((s, i) => {
    const size = sizeOf(s), list = ANGLES[size];
    let k = (hash(s.sceneId || s.locationId) + i) % list.length;
    if (prev && prev.loc === s.locationId && Math.abs(list[k]! - prev.angle) < 0.15) k = (k + 1) % list.length;
    const angle = list[k]!;
    // one side of the action per scene (the 180-degree rule); the angle around the subject varies inside it
    const side = hash(s.sceneId || s.locationId) % 2 ? 1 : -1;
    const low = s.shotType === "low-angle" || s.emotion === "anger" || s.emotion === "awe" || s.emotion === "shock";
    const high = s.shotType === "high-angle" || s.emotion === "sad";
    const heightOffset = low ? -0.55 : high ? 0.7 : size === "wide" ? 0.25 : 0;
    const fovScale = (size === "close" ? 0.88 : size === "wide" ? 1.05 : 1) * style.lens;
    shots.push({ shotId: s.id, locationId: s.locationId, angle, side, heightOffset, fovScale: +fovScale.toFixed(2), why: `${size}${low ? ", low angle" : high ? ", high angle" : ""}` });
    prev = { angle, loc: s.locationId };
  });
  return { artStyle: style.id, locations, shots };
}
