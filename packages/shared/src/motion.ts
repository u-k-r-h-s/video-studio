import { z } from "zod";
import { EASINGS } from "./constants";

/**
 * Motion primitives: the only vocabulary the renderer understands. The planner/LLM never writes FFmpeg
 * expressions; a deterministic MotionPlanner produces these and the renderer compiles them.
 *
 * All times are seconds from scene start. Positions are fractions of the canvas (1.0 = full width/height).
 * Semantics: before `start` a primitive contributes its `from`; after `end` it holds its `to`.
 */
const base = {
  start: z.number().min(0),
  end: z.number().min(0),
  easing: z.enum(EASINGS).default("linear"),
};
const num = z.number().finite();
const vec2 = z.tuple([num, num]);

export const LayerTargetSchema = z.object({
  layer: z.enum(["camera", "character", "prop", "subtitle"]),
  /** character id / prop asset id / subtitle asset id. Not used for the camera. */
  id: z.string().optional(),
});
export type LayerTarget = z.infer<typeof LayerTargetSchema>;

export const MotionSchema = z
  .discriminatedUnion("type", [
    /** Camera crop position as a fraction (0..1) of the available slack. */
    z.object({ type: z.literal("pan"), target: LayerTargetSchema, from: vec2, to: vec2, ...base }),
    /** Camera zoom factor (>= 1). */
    z.object({ type: z.literal("zoom"), target: LayerTargetSchema, from: z.number().min(1), to: z.number().min(1), ...base }),
    /** Position offset in canvas fractions, additive. */
    z.object({ type: z.literal("translate"), target: LayerTargetSchema, from: vec2, to: vec2, ...base }),
    /** Size multiplier, multiplicative. */
    z.object({ type: z.literal("scale"), target: LayerTargetSchema, from: z.number().min(0), to: z.number().min(0), ...base }),
    /** Decaying-free sinusoidal jitter (canvas fraction amplitude) inside the window. */
    z.object({ type: z.literal("shake"), target: LayerTargetSchema, amplitude: z.number().min(0).max(0.2), frequency: z.number().min(0.1).max(60), ...base }),
    /** Opacity ramp 0->1 (fade in) or 1->0 (fade out). */
    z.object({ type: z.literal("fade"), target: LayerTargetSchema, from: z.number().min(0).max(1), to: z.number().min(0).max(1), ...base }),
    /** Periodic breathing / bobbing inside the window. */
    z.object({
      type: z.literal("pulse"),
      target: LayerTargetSchema,
      axis: z.enum(["scale", "x", "y"]),
      amplitude: z.number().min(0).max(0.2),
      frequency: z.number().min(0.1).max(30),
      shape: z.enum(["sine", "abs_sine"]).default("sine"),
      ...base,
    }),
  ])
  .refine((m) => m.end >= m.start, { message: "motion end must be >= start" });
export type Motion = z.infer<typeof MotionSchema>;
