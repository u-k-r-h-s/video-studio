import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProfileRegistry } from "../src/profiles";
import { ExecFileRunner } from "../src/lib/command";
import { assertSafeId, safeJoin } from "../src/lib/paths";
import { setLogQuiet } from "../src/lib/logger";
import { ProjectStore } from "../src/storage/ProjectStore";
import { describeError, ComfyStartError, LlmValidationError } from "../src/errors";
import { motionComic } from "../src/profiles/motionComic";

beforeAll(() => setLogQuiet(true));

let dir: string;
let store: ProjectStore;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-store-"));
  store = new ProjectStore(dir);
  await store.init();
});
afterEach(async () => fs.rm(dir, { recursive: true, force: true }));

describe("ProjectStore", () => {
  it("creates a project with all stages pending and the standard folders", async () => {
    const p = await store.create({ inputMode: "idea", inputText: "A clever detective catches a thief." }, motionComic);
    expect(p.status).toBe("draft");
    expect(Object.values(p.stages).every((s) => s.status === "pending")).toBe(true);
    for (const d of ["characters", "images", "audio", "subtitles", "scenes", "final", "logs"]) {
      expect((await fs.stat(store.resolve(p.id, d))).isDirectory()).toBe(true);
    }
    expect(p.id).toMatch(/^a-clever-detective-catches-a-thief-[0-9a-f]{6}$/);
  });

  it("persists updates atomically and survives a 'restart' (new store instance)", async () => {
    const p = await store.create({ inputMode: "idea", inputText: "A clever detective catches a thief.", title: "Demo" }, motionComic);
    await store.update(p.id, (x) => {
      x.stages.image_generation = { status: "completed", completedAt: "2026-01-01T00:00:00.000Z" };
      x.assets.push({ id: "bg-shop", kind: "background", path: "images/bg-shop.png", status: "ready", inputHash: "abc", meta: {}, createdAt: "2026-01-01T00:00:00.000Z" });
    });
    const reopened = new ProjectStore(dir);
    const again = await reopened.require(p.id);
    expect(again.stages.image_generation!.status).toBe("completed");
    expect(again.assets[0]!.id).toBe("bg-shop");
    expect(again.updatedAt >= p.updatedAt).toBe(true);
  });

  it("rejects invalid state instead of writing it", async () => {
    const p = await store.create({ inputMode: "idea", inputText: "A clever detective catches a thief." }, motionComic);
    await expect(store.update(p.id, (x) => { (x as { status: string }).status = "bogus"; })).rejects.toThrow();
    expect((await store.require(p.id)).status).toBe("draft");
  });

  it("serialises concurrent updates without losing writes", async () => {
    const p = await store.create({ inputMode: "idea", inputText: "A clever detective catches a thief." }, motionComic);
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.update(p.id, (x) => { x.errors.push({ stage: "t", message: `e${i}`, at: "now" }); })));
    expect((await store.require(p.id)).errors).toHaveLength(10);
  });

  it("marks interrupted (running) stages as failed so the project is resumable", async () => {
    const p = await store.create({ inputMode: "idea", inputText: "A clever detective catches a thief." }, motionComic);
    await store.update(p.id, (x) => { x.status = "generating"; x.stages.image_generation = { status: "running", startedAt: "t" }; });
    const recovered = await store.recoverInterrupted();
    expect(recovered).toEqual([p.id]);
    const after = await store.require(p.id);
    expect(after.stages.image_generation!.status).toBe("failed");
    expect(after.stages.image_generation!.error).toContain("Interrupted");
    expect(after.status).toBe("draft"); // no scenes yet
  });

  it("blocks path traversal and bad ids", async () => {
    expect(() => store.resolve("ok-id-000000", "../../etc/passwd")).toThrow();
    expect(() => assertSafeId("../x")).toThrow();
    expect(() => safeJoin("/data/p", "..", "q")).toThrow();
    await expect(store.get("../../etc")).rejects.toThrow();
  });
});

describe("ExecFileRunner allow-list (no arbitrary command execution)", () => {
  it("refuses programs that are not on the list, including shells", async () => {
    const runner = new ExecFileRunner(["/bin/echo"]);
    await expect(runner.run("/bin/sh", ["-c", "echo pwned"])).rejects.toMatchObject({ code: "command_not_allowed" });
    await expect(runner.run("rm", ["-rf", "/tmp/x"])).rejects.toMatchObject({ code: "command_not_allowed" });
    expect(() => runner.spawn("/usr/bin/curl", [], {})).toThrow();
  });
  it("runs allowed programs with arguments passed literally (no shell interpolation)", async () => {
    const runner = new ExecFileRunner(["/bin/echo"]);
    const r = await runner.run("/bin/echo", ["hello; touch /tmp/should-not-exist $(whoami)"]);
    expect(r.stdout.trim()).toBe("hello; touch /tmp/should-not-exist $(whoami)");
    await expect(fs.stat("/tmp/should-not-exist")).rejects.toThrow();
  });
});

describe("profiles + errors", () => {
  it("validates registered profiles and reports unknown ones", () => {
    const reg = new ProfileRegistry();
    expect(reg.get("motion-comic").video.width).toBe(1080);
    expect(() => reg.get("documentary")).toThrow(/Unknown format profile/);
    expect(() => reg.register({ ...motionComic, video: { ...motionComic.video, width: 0 } })).toThrow();
  });
  it("renders user-facing messages without stack traces", () => {
    const m = describeError(new ComfyStartError("python exited with code 1", new Error("boom")));
    expect(m).toContain("ComfyUI failed to start.");
    expect(m).not.toContain("python exited");
    expect(m).not.toMatch(/at .*\.ts/);
    expect(describeError(new LlmValidationError("bad", ["x: y"]))).toContain("Problems: x: y");
  });
});
