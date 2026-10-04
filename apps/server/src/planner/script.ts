import { NARRATOR_ID, slugify } from "@studio/shared";
import { normalizeForCompare } from "./normalize";

export interface ScriptLine {
  speaker: string;
  /** id the speaker maps to: "narrator" or a kebab-case character id. */
  speakerId: string;
  text: string;
}

const NARRATOR_NAMES = new Set(["narrator", "narration", "voiceover", "voice over", "vo"]);
const LINE = /^([\p{L}][\p{L}\p{N} .'\-]{0,39}?)\s*[:：]\s*(.+)$/u;

/**
 * Deterministic parse of a script written as `NAME: line` (one per line). Returns undefined when the script is not
 * in that form (then only the looser "text appears in the script" check applies).
 */
export function parseScript(text: string): ScriptLine[] | undefined {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsed: ScriptLine[] = [];
  const ids = new Map<string, string>(); // speaker name (lower-case) -> id
  for (const row of rows) {
    const m = row.match(LINE);
    if (!m) continue;
    const speaker = m[1]!.trim();
    const key = speaker.toLowerCase();
    if (!ids.has(key)) {
      const base = NARRATOR_NAMES.has(key) ? NARRATOR_ID : slugify(speaker) || `speaker-${ids.size + 1}`;
      ids.set(key, base);
    }
    parsed.push({ speaker, speakerId: ids.get(key)!, text: m[2]!.trim() });
  }
  return parsed.length >= 2 && parsed.length >= 0.7 * rows.length ? parsed : undefined;
}

/** Distinct non-narrator speakers in order of first appearance: the cast the script itself defines. */
export function scriptCast(lines: ScriptLine[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const l of lines) if (l.speakerId !== NARRATOR_ID && !seen.has(l.speakerId)) seen.set(l.speakerId, l.speaker);
  return [...seen].map(([id, name]) => ({ id, name }));
}

const words = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length;

/**
 * Splits the script lines into `n` CONTIGUOUS groups (original order, every line exactly once), balanced by word count.
 * The model is never asked to do this: a 3B model measurably duplicates/reorders lines when it has to.
 */
export function groupLines(lines: ScriptLine[], n: number): ScriptLine[][] {
  const count = Math.max(1, Math.min(n, lines.length));
  const total = lines.reduce((a, l) => a + words(l.text), 0);
  const groups: ScriptLine[][] = [];
  let current: ScriptLine[] = [];
  let acc = 0;
  lines.forEach((line, i) => {
    current.push(line);
    acc += words(line.text);
    const groupsLeft = count - groups.length - 1;
    const linesLeft = lines.length - i - 1;
    const reachedShare = acc >= (total * (groups.length + 1)) / count;
    if (groups.length < count - 1 && (reachedShare || linesLeft === groupsLeft) && linesLeft >= groupsLeft) {
      groups.push(current);
      current = [];
    }
  });
  if (current.length) groups.push(current);
  return groups;
}
