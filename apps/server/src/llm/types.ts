import type { ServiceDetail } from "@studio/shared";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** JSON Schema the response must conform to (structured output). */
  format?: Record<string, unknown>;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Adapter boundary for language models. The story pipeline only depends on this
 * interface, so Ollama can be swapped (or an optional cloud provider added) without
 * touching the rest of the app. Tool/function calling is added in the agent phase.
 */
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(request: ChatRequest): Promise<string>;
  health(): Promise<ServiceDetail>;
}
