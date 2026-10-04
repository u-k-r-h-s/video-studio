import { z } from "zod";
import { LlmValidationError } from "../errors";
import { createLogger } from "../lib/logger";
import type { ChatMessage, LLMProvider } from "./types";

const log = createLogger("structured");

/** Keywords the model-side grammar sometimes rejects; our own zod validation still enforces them. */
const STRIPPED_KEYS = new Set(["$schema", "pattern", "format"]);

function stripKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripKeys);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>)
        .filter(([k]) => !STRIPPED_KEYS.has(k))
        .map(([k, v]) => [k, stripKeys(v)]),
    );
  }
  return node;
}

/** JSON Schema passed to Ollama's `format` parameter (constrained decoding). */
export function toOllamaFormat(schema: z.ZodType): Record<string, unknown> {
  return stripKeys(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** Models occasionally wrap JSON in markdown fences or prose. */
export function extractJson(raw: string): string {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/**
 * Parse model output. If strict parsing fails, try ONE deterministic, safe clean-up (smart quotes used as JSON
 * delimiters, trailing commas). Anything still invalid is reported so the model can be asked to repair it;
 * output is never evaluated or executed.
 */
export function parseModelJson(raw: string): { ok: true; value: unknown; repaired: boolean } | { ok: false; error: string } {
  const body = extractJson(raw);
  try {
    return { ok: true, value: JSON.parse(body), repaired: false };
  } catch (first) {
    const cleaned = body.replace(/[\u201C\u201D]/g, '"').replace(/,\s*([}\]])/g, "$1");
    try {
      return { ok: true, value: JSON.parse(cleaned), repaired: true };
    } catch {
      return { ok: false, error: (first as Error).message };
    }
  }
}

export interface StructuredRequest<S extends z.ZodType> {
  llm: LLMProvider;
  label: string;
  schema: S;
  messages: ChatMessage[];
  maxRepairs: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Deterministic fix-ups applied to the parsed JSON before schema validation. */
  normalize?: (raw: unknown) => unknown;
  /** Extra checks / fix-ups on schema-valid output. Return issues to trigger a repair round. */
  refine?: (value: z.infer<S>) => { value: z.infer<S>; issues: string[] };
  /** Called before each repair round (attempt starts at 1). */
  onRepair?: (attempt: number, issues: string[]) => void;
}

/**
 * Asks the LLM for JSON, validates it, and on failure sends the exact problems back
 * and asks for a corrected version, up to `maxRepairs` times.
 */
export async function generateStructured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
  const format = toOllamaFormat(req.schema);
  const messages = [...req.messages];

  for (let attempt = 0; ; attempt++) {
    const raw = await req.llm.chat({ messages, format, temperature: req.temperature, signal: req.signal });

    let issues: string[] = [];
    let parsedJson: unknown;
    const parsed = parseModelJson(raw);
    if (parsed.ok) parsedJson = parsed.value;
    else issues = [`The response was not valid JSON (${parsed.error}).`];

    if (issues.length === 0) {
      const normalized = req.normalize ? req.normalize(parsedJson) : parsedJson;
      const result = req.schema.safeParse(normalized);
      if (!result.success) {
        issues = result.error.issues.slice(0, 12).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      } else {
        const refined = req.refine ? req.refine(result.data) : { value: result.data as z.infer<S>, issues: [] };
        if (refined.issues.length === 0) return refined.value;
        issues = refined.issues.slice(0, 12);
      }
    }

    log.warn(`${req.label}: invalid output (attempt ${attempt + 1})`, { issues: issues.join(" | ") });
    if (attempt >= req.maxRepairs) {
      throw new LlmValidationError(
        `The model did not return a valid ${req.label} after ${attempt + 1} attempt(s).`,
        issues,
      );
    }
    req.onRepair?.(attempt + 1, issues);
    messages.push(
      { role: "assistant", content: raw },
      {
        role: "user",
        content: `Your JSON has these problems:\n${issues.map((i) => `- ${i}`).join("\n")}\n\nReturn the complete corrected JSON object only, no commentary.`,
      },
    );
  }
}
