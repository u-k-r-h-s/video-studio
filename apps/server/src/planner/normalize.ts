import { CAMERA_MOVEMENTS, EMOTIONS, EMPHASES, ENTRANCES, NARRATOR_ID, SHOTS, slugify } from "@studio/shared";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const norm = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : "");

/** "market-thief" / "the_last_clue" -> "Market Thief" / "The Last Clue". Real titles are left alone. */
export function prettifyTitle(title: string): string {
  const t = title.trim();
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(t)) return t;
  return t.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function normalizeOutline(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  if (typeof raw.title === "string") out.title = prettifyTitle(raw.title);
  if (Array.isArray(raw.characters)) {
    out.characters = raw.characters.map((c) => {
      if (!isRecord(c)) return c;
      const source = typeof c.id === "string" && c.id.trim() ? c.id : typeof c.name === "string" ? c.name : "";
      return { ...c, id: slugify(source) };
    });
  }
  return out;
}

const CAMERA_SYNONYMS: Record<string, string> = {
  slow_zoom_in: "zoom_in", zoom_in_slowly: "zoom_in", push_in: "zoom_in", slow_zoom_out: "zoom_out", pull_out: "zoom_out",
  pan: "pan_right", slow_pan_left: "pan_left", slow_pan_right: "pan_right", none: "static", still: "static", fixed: "static",
};

/** Whole-word, case-insensitive: does `text` mention any name token (4+ letters) of the character? */
function isMentioned(text: string, name: string): boolean {
  return name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 4)
    .some((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${t}($|[^\\p{L}\\p{N}])`, "iu").test(text));
}

/**
 * Deterministic, SAFE clean-up of raw model output BEFORE schema validation. It only fixes things small models
 * get "almost right" (ids with spaces/capitals, enum synonyms, forgotten speakers). Unknown shapes pass through
 * and are rejected by the schema, which triggers a repair round-trip.
 */
export function normalizeScenes(raw: unknown, cast: { id: string; name: string }[]): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.scenes)) return raw;
  const known = new Set(cast.map((c) => c.id));
  return {
    ...raw,
    scenes: raw.scenes.map((s) => {
      if (!isRecord(s)) return s;
      const out: Record<string, unknown> = { ...s };
      if (typeof s.location === "string") out.location = s.location.trim();
      if (typeof s.duration === "number" && Number.isFinite(s.duration)) out.duration = Math.round(s.duration * 10) / 10;

      let characters = Array.isArray(s.characters) ? s.characters.filter((c): c is string => typeof c === "string").map((c) => slugify(c)) : undefined;
      if (Array.isArray(s.dialogue)) {
        out.dialogue = s.dialogue
          .filter((d) => !(isRecord(d) && typeof d.text === "string" && d.text.trim() === ""))
          .map((d) => {
            if (!isRecord(d)) return d;
            const rawSpeaker = typeof d.characterId === "string" ? d.characterId : typeof d.character === "string" ? d.character : undefined;
            const speaker = rawSpeaker === undefined ? undefined : slugify(rawSpeaker);
            const line: Record<string, unknown> = { ...d, characterId: speaker, text: typeof d.text === "string" ? d.text.trim() : d.text };
            delete line.character;
            if (typeof line.emotion === "string" && !(EMOTIONS as readonly string[]).includes(norm(line.emotion))) delete line.emotion;
            else if (typeof line.emotion === "string") line.emotion = norm(line.emotion);
            if (characters && speaker && speaker !== NARRATOR_ID && known.has(speaker) && !characters.includes(speaker)) characters.push(speaker);
            return line;
          });
      }
      if (characters) {
        if (typeof s.visualDescription === "string") {
          for (const c of cast) if (!characters.includes(c.id) && isMentioned(s.visualDescription, c.name)) characters.push(c.id);
        }
        characters = [...new Set(characters)].filter((c) => c !== NARRATOR_ID);
        out.characters = characters;
      }
      if (Array.isArray(s.props)) {
        out.props = [...new Set(s.props.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter((p) => p.length >= 2))];
      }
      if (isRecord(s.camera)) {
        let movement = norm(s.camera.movement);
        movement = CAMERA_SYNONYMS[movement] ?? movement;
        const shot = norm(s.camera.shot);
        out.camera = { movement, ...(((SHOTS as readonly string[]).includes(shot)) ? { shot } : {}) };
        if (!(CAMERA_MOVEMENTS as readonly string[]).includes(movement)) out.camera = { movement: s.camera.movement, shot: s.camera.shot };
      }
      if (isRecord(s.motion)) {
        const entrance = norm(s.motion.entrance);
        const emphasis = norm(s.motion.emphasis);
        out.motion = {
          entrance: (ENTRANCES as readonly string[]).includes(entrance) ? entrance : "left",
          emphasis: (EMPHASES as readonly string[]).includes(emphasis) ? emphasis : "none",
        };
      }
      return out;
    }),
  };
}

/** Lower-case, strip punctuation/quotes and collapse whitespace: used to compare script text with model output. */
export function normalizeForCompare(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[‘’“”"'`]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
