import type { z } from "zod";

export interface ToolContext {
  signal?: AbortSignal;
  progress?: (pct: number, message: string) => void;
}

/**
 * A capability the studio can perform. Tools wrap pipeline stages; they never run arbitrary commands and are
 * never given a shell. The LLM does not call tools in this version (the pipeline does, deterministically), but the
 * interface is shaped so an LLM director can be given an allow-listed subset later.
 */
export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  execute(input: I, ctx: ToolContext): Promise<O>;
}
