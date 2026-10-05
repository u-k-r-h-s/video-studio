import { AnimEngine } from "../../apps/server/src/anim/engine";
import { renderAnimShot } from "../../apps/server/src/anim/video";
import { A, bg, cfg, loadLab, mira, spec } from "./anim-common";

const { lib, variants } = await loadLab();
console.log("variants:", variants.join(","));
const s = spec("t1", 3.2, [bg("bg-street"), mira({ x: 120 })], [
  { start: 0.1, duration: 2.9, targetId: "mira", type: "walk", params: { to: 960 } },
], [{ type: "fog", intensity: 0.5, layer: "back" }, { type: "rain", intensity: 0.7, layer: "front" }]);
const engine = new AnimEngine(s, lib);
const r = await renderAnimShot(engine, `${A}/out/t1.mp4`, { ffmpeg: cfg.ffmpeg.ffmpeg, encoder: "h264_videotoolbox", bitrateKbps: 14000 });
console.log("rendered", r);
