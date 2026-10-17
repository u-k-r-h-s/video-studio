import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { EventBus } from "../src/events";
import { JobManager } from "../src/jobs/JobManager";
import { ProfileRegistry } from "../src/profiles";
import { animatedShort } from "../src/profiles/animatedShort";
import { animatedShort3d } from "../src/profiles/animatedShort3d";
import { engineOf, parseRendererChoice, profileForRenderer } from "../src/profiles/rendererChoice";
import { createPipelineTools } from "../src/tools/pipelineTools";
import { makeHarness, type Harness } from "./harness";

// Regression: the previous Hindi video was meant to be checked for Three.js and came out 2D. An explicit --renderer=3d must
// never end up on the 2D engine: not through a spelling, not through --profile, not through the API defaults.
const registry = new ProfileRegistry();
const get = (id: string) => registry.get(id);

describe("renderer choice (--renderer)", () => {
  it("accepts only known spellings; anything else is an error, never a default", () => {
    for (const v of ["3d", "3D", " three ", "threejs", "Three.js", "three3d", "webgl"]) expect(parseRendererChoice(v)).toBe("3d");
    for (const v of ["2d", "canvas", "canvas2d"]) expect(parseRendererChoice(v)).toBe("2d");
    for (const v of ["", "3", "three-d", "blender", undefined]) expect(() => parseRendererChoice(v)).toThrow(/Unknown renderer/);
  });

  it("--renderer=3d picks the Three.js profile, and a 2D --profile is a conflict, not a silent 2D render", () => {
    expect(engineOf(animatedShort3d)).toBe("three3d");
    expect(engineOf(animatedShort)).toBe("canvas2d");
    expect(profileForRenderer("3d", undefined, get)).toBe("animated-short-3d");
    expect(engineOf(get(profileForRenderer("3d", undefined, get)!))).toBe("three3d");
    expect(() => profileForRenderer("3d", "animated-short", get)).toThrow(/renderer_mismatch|is drawn by canvas2d/);
    expect(() => profileForRenderer("3d", "cinematic-animated-short", get)).toThrow(/still-image/);
    expect(() => profileForRenderer("2d", "animated-short-3d", get)).toThrow(/three3d/);
    expect(profileForRenderer("3d", "animated-short-3d", get)).toBe("animated-short-3d");
    expect(profileForRenderer(undefined, "animated-short", get)).toBe("animated-short"); // no renderer requested: unchanged
  });
});

describe("API: an explicit renderer is binding", () => {
  let h: Harness | undefined, server: http.Server | undefined, base = "";
  afterEach(async () => { server?.close(); server = undefined; await h?.close(); h = undefined; });
  async function start() {
    h = await makeHarness({ profile: animatedShort3d });
    h.svc.profiles.register(animatedShort);
    const bus = new EventBus(), jobs = new JobManager(bus, 1);
    server = http.createServer();
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    const health = { check: async () => ({ services: {}, gates: { ollamaResident: false, comfyuiRunning: false }, checkedAt: "now" }) } as never;
    server.on("request", createApp({ deps: { store: h.store, studio: h.studio, jobs, bus, health, profiles: h.svc.profiles, tools: createPipelineTools(h.runner, (id) => jobs.get(id)) }, allowedOrigins: [], port }));
  }
  const post = async (body: Record<string, unknown>) => {
    const r = await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputMode: "idea", inputText: "A courier finds a lost parcel in the colony.", language: "en", targetDurationSeconds: 20, ...body }) });
    return { status: r.status, json: (await r.json()) as { project?: { id: string; formatProfile: string }; error?: { code: string; message: string } } };
  };

  it("renderer 3d without a profile creates a Three.js project; with a 2D profile or an unknown value it is a 400", async () => {
    await start();
    const ok = await post({ renderer: "3d" });
    expect(ok.status).toBe(201);
    expect(ok.json.project!.formatProfile).toBe("animated-short-3d");
    const clash = await post({ renderer: "3d", formatProfile: "animated-short" });
    expect(clash.status).toBe(400);
    expect(clash.json.error!.code).toBe("renderer_mismatch");
    const bad = await post({ renderer: "3D-ish" });
    expect(bad.status).toBe(400);
    expect(bad.json.error!.code).toBe("renderer_invalid");
    // let the planning job the first request started finish before the harness removes its folder
    for (let i = 0; i < 400; i++) { const r = (await (await fetch(`${base}/api/projects/${ok.json.project!.id}`)).json()) as { activeJob: unknown }; if (!r.activeJob) break; await new Promise((res) => setTimeout(res, 15)); }
    const profiles = (await (await fetch(`${base}/api/profiles`)).json()) as { profiles: { id: string; engine: string }[] };
    expect(Object.fromEntries(profiles.profiles.map((p) => [p.id, p.engine]))).toMatchObject({ "animated-short-3d": "three3d", "animated-short": "canvas2d" });
  });
});
