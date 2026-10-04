import type { ChatRequest, LLMProvider } from "../src/llm/types";

/** Replays canned responses in order; records every request. */
export class FakeLLM implements LLMProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  readonly requests: ChatRequest[] = [];
  private i = 0;

  /** An array replays in order (repeating the last); a function answers each request. */
  constructor(private readonly responses: (string | object)[] | ((req: ChatRequest) => string | object)) {}

  async chat(req: ChatRequest): Promise<string> {
    this.requests.push({ ...req, messages: [...req.messages] });
    const next = Array.isArray(this.responses)
      ? this.responses[Math.min(this.i++, this.responses.length - 1)]
      : this.responses(req);
    return typeof next === "string" ? next : JSON.stringify(next);
  }

  async health() {
    return { status: "ready" as const, message: "fake" };
  }
}

export const outline = {
  title: "The Midnight Thief",
  logline: "A sharp old detective outwits a snack-stealing thief.",
  synopsis: "An old detective notices food vanishing from a village shop and sets a clever trap that reveals the thief is a hungry monkey.",
  characters: [
    { id: "Inspector Raghu", name: "Inspector Raghu", description: "Thin old man with a white moustache and round glasses", age: 68, clothing: "Brown coat and cap", colors: ["brown", "white"], personality: ["clever", "calm"] },
    { id: "monkey-mintu", name: "Mintu", description: "Small brown monkey with a big grin and quick hands", age: 5, clothing: "Tiny red vest", colors: ["brown", "red"], personality: ["cheeky"] },
  ],
};

export function scene(overrides: Record<string, unknown> = {}) {
  return {
    id: "x",
    duration: 5,
    location: "Village Shop",
    characters: ["Inspector Raghu"],
    action: "The detective studies the empty shelves.",
    dialogue: [{ character: "Inspector Raghu", emotion: "suspicious", text: "Something is off here." }],
    camera: { shot: "medium", movement: "slow_zoom_in" },
    ...overrides,
  };
}
