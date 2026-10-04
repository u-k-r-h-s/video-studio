import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PIPELINE_STAGES, type FormatProfile } from "@studio/shared";
import { ProjectStore } from "../src/storage/ProjectStore";
import { ProfileRegistry } from "../src/profiles";
import { motionComic } from "../src/profiles/motionComic";
import { ScenePlanner } from "../src/planner/ScenePlanner";
import { ShotDirector } from "../src/shots/director";
import type { MediaTools } from "../src/pipeline/types";
import { MemoryGate, type ComfyProbe, type OllamaControl } from "../src/services/MemoryGate";
import { ComfyUIProvider } from "../src/providers/image/ComfyUIProvider";
import type { ComfySession } from "../src/providers/image/ComfyProcess";
import type { SpeechRequest, TTSProvider, VoiceInfo } from "../src/providers/tts/TTSProvider";
import type { SubtitleImage, SubtitleImageRequest, SubtitleRenderer } from "../src/providers/subtitle/SubtitleRenderer";
import type { RenderOutput, SceneRenderer, ScenePlan } from "../src/render/SceneRenderer";
import { PipelineRunner } from "../src/pipeline/PipelineRunner";
import { Studio } from "../src/pipeline/Studio";
import type { PipelineServices } from "../src/pipeline/types";
import { createPipelineTools } from "../src/tools/pipelineTools";
import { TOOL_NAMES } from "../src/tools/pipelineTools";
import { ToolDispatcher } from "../src/tools/ToolDispatcher";
import { encodePng } from "../src/lib/png";
import { encodeWav } from "../src/lib/wav";
import { FakeLLM } from "./helpers";
import { setLogQuiet } from "../src/lib/logger";
import { OllamaUnloadError, ComfyStopError } from "../src/errors";

setLogQuiet(true);

/** Flat orange background with a dark figure: what a generated character looks like before keying. */
export function figurePng(w = 64, h = 112): Buffer {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fig = x > w * 0.3 && x < w * 0.7 && y > h * 0.15 && y < h * 0.95;
    data.set(fig ? [60, 30, 20, 255] : [225, 154, 84, 255], (y * w + x) * 4);
  }
  return encodePng({ width: w, height: h, data });
}

export const OUTLINE = {
  title: "The Midnight Thief",
  characters: [
    { id: "raghu", name: "Raghu", description: "A clever village detective", appearance: "thin old man, white moustache, brown coat, flat cap" },
    { id: "mintu", name: "Mintu", description: "A hungry monkey", appearance: "small brown monkey, red vest" },
  ],
};
export const SCENES = {
  scenes: [
    { location: "Village Shop", visualDescription: "A small shop at night with half-empty shelves.", characters: ["raghu"], props: ["wooden mousetrap"],
      dialogue: [{ characterId: "raghu", text: "Someone is stealing food from my shop every night." }], camera: { movement: "zoom_in", shot: "medium" }, motion: { entrance: "left", emphasis: "none" }, duration: 6 },
    { location: "Village Shop", visualDescription: "Raghu sets a simple trap and hides.", characters: ["raghu"], props: [],
      dialogue: [{ characterId: "narrator", text: "He waited in the dark." }], camera: { movement: "pan_right", shot: "wide" }, motion: { entrance: "none", emphasis: "none" }, duration: 5 },
    { location: "Village Shop", visualDescription: "Mintu the monkey is caught in the trap.", characters: ["raghu", "mintu"], props: ["banana"],
      dialogue: [{ characterId: "mintu", text: "I was only a little hungry!" }, { characterId: "raghu", text: "Next time, just ask." }], camera: { movement: "static", shot: "close_up" }, motion: { entrance: "right", emphasis: "impact" }, duration: 7 },
  ],
};

export interface Harness {
  dir: string;
  store: ProjectStore;
  studio: Studio;
  runner: PipelineRunner;
  svc: PipelineServices;
  events: string[];
  state: { ollamaLoaded: boolean; comfyAlive: boolean; failPromptNumber?: number; ollamaUnloadWorks: boolean; comfyStopVerifyFails: boolean; ttsFails: boolean; prompts: number };
  dispatcher: ToolDispatcher;
  profile: FormatProfile;
  newProject(over?: object): Promise<string>;
  rebuild(): Harness;
  close(): Promise<void>;
}

export async function makeHarness(opts: { renderer?: SceneRenderer; profile?: FormatProfile; llm?: FakeLLM; media?: MediaTools } = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-pipe-"));
  const events: string[] = [];
  const state: Harness["state"] = { ollamaLoaded: false, comfyAlive: false, ollamaUnloadWorks: true, comfyStopVerifyFails: false, ttsFails: false, prompts: 0 };
  const profile = opts.profile ?? motionComic;

  // --- fake ComfyUI HTTP API
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const json = (o: unknown, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url.pathname === "/prompt") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      state.prompts++; events.push("comfy:prompt");
      if (state.failPromptNumber === state.prompts) return json({ error: "boom", node_errors: { "7": "out of memory" } }, 500);
      json({ prompt_id: `p${state.prompts}` });
    }); }
    else if (url.pathname.startsWith("/history/")) { const id = url.pathname.split("/")[2]!; json({ [id]: { status: { status_str: "success", completed: true, messages: [] }, outputs: { "9": { images: [{ filename: `${id}.png`, subfolder: "", type: "temp" }] } } } }); }
    else if (url.pathname === "/view") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(figurePng()); }
    else if (url.pathname === "/upload/image") { events.push("comfy:upload"); req.resume(); req.on("end", () => json({ name: "uploaded.png" })); }
    else if (url.pathname === "/free") { events.push("comfy:free"); json({}); }
    else json({}, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // --- fake Ollama (resident after a chat until unloaded)
  const llm = opts.llm ?? new FakeLLM((req) => (req.messages.some((m) => m.content.includes("title and cast")) ? OUTLINE : SCENES));
  const origChat = llm.chat.bind(llm);
  llm.chat = async (req) => { events.push("ollama:chat"); state.ollamaLoaded = true; return origChat(req); };
  const ollama: OllamaControl = {
    loadedModels: async () => (state.ollamaLoaded ? ["llama3.2:latest"] : []),
    unload: async () => { events.push("ollama:unload"); if (state.ollamaUnloadWorks) state.ollamaLoaded = false; },
    hasRunnerProcess: async () => state.ollamaLoaded,
  };
  const probe: ComfyProbe = { isProcessAlive: () => state.comfyAlive, isPortOpen: async () => state.comfyAlive || state.comfyStopVerifyFails };
  const gate = new MemoryGate(ollama, probe, { unloadTimeoutMs: 150, pollMs: 5 });
  const session: ComfySession = {
    ...probe,
    start: async () => { events.push("comfy:start"); if (state.ollamaLoaded) throw new Error("GATE BYPASSED: ComfyUI started while Ollama was resident"); state.comfyAlive = true; },
    stop: async () => { events.push("comfy:stop"); state.comfyAlive = false; },
  };
  const image = new ComfyUIProvider(session, gate, { baseUrl: base, checkpoint: "ck", lora: "lora", imageTimeoutMs: 5000, pollMs: 2, models: { sd15: { id: "sd15", checkpoint: "ck", lora: "lora" }, ds8: { id: "ds8", unet: "u", clip: "c", vae: "v", lora: "lora" } }, defaultModel: "sd15" });

  // --- fake TTS / subtitles / renderer
  const voices: VoiceInfo[] = [{ id: "en-a", language: "en", model: "m.onnx" }, { id: "en-b", language: "en", model: "m.onnx" }, { id: "en-narrator", language: "en", model: "m.onnx" }, { id: "en-c", language: "en", model: "m.onnx" }, { id: "hi-rohan", language: "hi", model: "h.onnx" }];
  const tts: TTSProvider = {
    name: "fake-piper", listVoices: () => voices,
    getVoice: (id) => voices.find((v) => v.id === id)!,
    synthesize: async (r: SpeechRequest) => {
      events.push(`piper:${path.basename(r.outPath, ".raw.wav")}`);
      if (state.comfyAlive) throw new Error("GATE BYPASSED: Piper ran while ComfyUI was alive");
      if (state.ttsFails) throw new Error("piper crashed");
      const sec = 0.3 + r.text.length * 0.06;
      const sr = 22050, lead = Math.round(0.2 * sr), tone = Math.round(sec * sr);
      const s = new Int16Array(lead + tone + lead);
      for (let i = 0; i < tone; i++) s[lead + i] = Math.round(7000 * Math.sin((2 * Math.PI * 300 * i) / sr));
      await fs.mkdir(path.dirname(r.outPath), { recursive: true });
      await fs.writeFile(r.outPath, encodeWav({ sampleRate: sr, samples: s }));
      return { path: r.outPath, durationSec: s.length / sr };
    },
    health: async () => ({ status: "ready", message: "fake" }),
  };
  const subtitle: SubtitleRenderer = {
    name: "fake-coretext",
    render: async (r: SubtitleImageRequest): Promise<SubtitleImage> => { events.push(`subtitle:${path.basename(r.outPath, ".png")}`); await fs.mkdir(path.dirname(r.outPath), { recursive: true }); await fs.writeFile(r.outPath, figurePng(40, 20)); return { path: r.outPath, width: 980, height: 200 }; },
    health: async () => ({ status: "ready", message: "fake" }),
  };
  const fakeRenderer: SceneRenderer = {
    name: "fake-ffmpeg",
    renderScene: async (plan: ScenePlan, out: string): Promise<RenderOutput> => {
      events.push(`render:${plan.sceneId}`);
      if (state.comfyAlive || state.ollamaLoaded) throw new Error("GATE BYPASSED: render ran with a heavy model resident");
      await fs.mkdir(path.dirname(out), { recursive: true }); await fs.writeFile(out, `clip ${plan.sceneId} ${plan.duration}`);
      return { path: out, durationSec: plan.duration, width: 1080, height: 1920, fps: 30, encoder: "fake", renderMs: 1 };
    },
    assemble: async (clips: string[], out: string): Promise<RenderOutput> => { events.push(`assemble:${clips.length}`); await fs.mkdir(path.dirname(out), { recursive: true }); await fs.writeFile(out, "final"); return { path: out, durationSec: clips.length * 5, width: 1080, height: 1920, fps: 30, encoder: "fake", renderMs: 1 }; },
    health: async () => ({ status: "ready", message: "fake" }),
  };

  const store = new ProjectStore(dir);
  await store.init();
  const svc: PipelineServices = {
    store, profiles: new ProfileRegistry([profile]), planner: new ScenePlanner(llm, { maxRepairs: 1, temperature: 0.5 }), gate,
    advisor: { snapshot: async () => ({ freePercent: 60, swapUsedMb: 1000 }) }, memoryWarnFreePercent: 30,
    director: new ShotDirector(llm, { maxRepairs: 1, temperature: 0.5 }), media: opts.media,
    providers: { image: { comfyui: image }, tts: { piper: tts }, subtitle: { coretext: subtitle }, renderer: { "ffmpeg-motion": opts.renderer ?? fakeRenderer } },
  };
  const runner = new PipelineRunner(svc);
  const dispatcher = new ToolDispatcher(createPipelineTools(runner, () => undefined), TOOL_NAMES);
  const studio = new Studio(svc, dispatcher);

  const h: Harness = {
    dir, store, studio, runner, svc, events, state, dispatcher, profile,
    newProject: async (over = {}) => (await store.create({ inputMode: "idea", inputText: "A clever detective catches a thief who steals food at night.", ...over }, profile)).id,
    rebuild: () => { throw new Error("use makeHarness again with the same dir"); },
    close: async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); },
  };
  return h;
}

export const stageStatuses = async (h: Harness, id: string) => Object.fromEntries(PIPELINE_STAGES.map((s) => [s.id, 0])) && (await h.store.require(id)).stages;
export { OllamaUnloadError, ComfyStopError };
