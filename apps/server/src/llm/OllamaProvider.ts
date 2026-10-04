import type { ServiceDetail } from "@studio/shared";
import { OllamaUnavailableError } from "../errors";
import { createLogger } from "../lib/logger";
import type { ChatRequest, LLMProvider } from "./types";

export interface OllamaOptions {
  url: string;
  model: string;
  timeoutMs: number;
  retries: number;
  temperature: number;
}

const log = createLogger("ollama");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";

  constructor(private readonly opts: OllamaOptions) {}

  get model(): string {
    return this.opts.model;
  }

  private installHint(): string {
    return `Install Ollama from https://ollama.com, make sure it is running (\`ollama serve\`), then run \`ollama pull ${this.opts.model}\`.`;
  }

  async chat(req: ChatRequest): Promise<string> {
    const body = {
      model: this.opts.model,
      messages: req.messages,
      stream: false,
      ...(req.format ? { format: req.format } : {}),
      options: { temperature: req.temperature ?? this.opts.temperature },
    };

    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      try {
        const signal = req.signal
          ? AbortSignal.any([req.signal, AbortSignal.timeout(this.opts.timeoutMs)])
          : AbortSignal.timeout(this.opts.timeoutMs);
        const res = await fetch(`${this.opts.url}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          if (res.status === 404) {
            throw new OllamaUnavailableError(`Ollama model "${this.opts.model}" is not available.`, this.installHint());
          }
          const err = new Error(`Ollama returned HTTP ${res.status}: ${text.slice(0, 300)}`);
          (err as Error & { retryable?: boolean }).retryable = res.status >= 500;
          throw err;
        }
        const data = (await res.json()) as { message?: { content?: string } };
        const content = data.message?.content;
        if (typeof content !== "string" || content.length === 0) throw new Error("Ollama returned an empty response");
        log.debug("chat ok", { model: this.opts.model, ms: Date.now() - started, chars: content.length });
        return content;
      } catch (err) {
        if (req.signal?.aborted) throw err; // cancelled by the caller: never retry
        if (err instanceof OllamaUnavailableError) throw err;
        if (err instanceof DOMException && err.name === "TimeoutError") {
          throw new Error(`Ollama did not answer within ${Math.round(this.opts.timeoutMs / 1000)}s (raise OLLAMA_TIMEOUT_MS or use a smaller model).`);
        }
        const unreachable = err instanceof TypeError; // fetch network failure
        const retryable = unreachable || (err as { retryable?: boolean }).retryable === true;
        if (retryable && attempt < this.opts.retries) {
          const delay = 1000 * 2 ** attempt;
          log.warn(`chat failed (${(err as Error).message}); retrying in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        if (unreachable) {
          throw new OllamaUnavailableError(`Cannot reach Ollama at ${this.opts.url}.`, this.installHint());
        }
        throw err;
      }
    }
  }

  async health(): Promise<ServiceDetail> {
    try {
      const res = await fetch(`${this.opts.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { status: "unavailable", message: `Ollama answered HTTP ${res.status}`, hint: this.installHint() };
      const data = (await res.json()) as { models?: { name: string }[] };
      const names = (data.models ?? []).map((m) => m.name);
      const wanted = this.opts.model;
      const present = names.some((n) => n === wanted || n === `${wanted}:latest` || n.split(":")[0] === wanted);
      if (!present) {
        return {
          status: "unavailable",
          message: `Ollama is running but model "${wanted}" is not pulled.`,
          hint: `Run \`ollama pull ${wanted}\` (installed: ${names.join(", ") || "none"}).`,
        };
      }
      return { status: "ready", message: `Ollama ready, model "${wanted}"` };
    } catch {
      return { status: "unavailable", message: `Cannot reach Ollama at ${this.opts.url}`, hint: this.installHint() };
    }
  }
}
