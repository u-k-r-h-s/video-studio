import { z } from "zod";
import { AppError, HttpError } from "../errors";
import { createLogger } from "../lib/logger";
import type { Tool, ToolContext } from "./Tool";

const log = createLogger("tools");

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<any, any>>();

  register<I, O>(tool: Tool<I, O>): this {
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool<any, any> | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Machine-readable tool descriptions (name, description, JSON Schema of the input). */
  describe(): { name: string; description: string; inputSchema: unknown }[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.inputSchema) }));
  }
}

/**
 * The ONE central dispatcher. Every pipeline action goes through `dispatch`:
 *  - only names on the explicit allow-list can run (anything else is refused, even if registered),
 *  - input is validated against the tool's schema before execution,
 *  - each call is logged with its duration.
 * There is no code path from model output (or the browser) to a shell.
 */
export class ToolDispatcher {
  private readonly allowed: Set<string>;

  constructor(
    private readonly registry: ToolRegistry,
    allowList: Iterable<string>,
  ) {
    this.allowed = new Set(allowList);
  }

  async dispatch<O = unknown>(name: string, rawInput: unknown, ctx: ToolContext = {}): Promise<O> {
    const tool = this.registry.get(name);
    if (!this.allowed.has(name) || !tool) {
      throw new AppError("tool_not_allowed", `The tool "${name}" is not available.`, { status: 403, details: { allowed: [...this.allowed] } });
    }
    const parsed = tool.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "invalid_tool_input", `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
    }
    const t0 = Date.now();
    log.info("tool", { tool: name, status: "started" });
    try {
      const out = (await tool.execute(parsed.data, ctx)) as O;
      log.info("tool", { tool: name, status: "completed", durationMs: Date.now() - t0 });
      return out;
    } catch (err) {
      log.warn("tool", { tool: name, status: "failed", durationMs: Date.now() - t0 });
      throw err;
    }
  }
}
