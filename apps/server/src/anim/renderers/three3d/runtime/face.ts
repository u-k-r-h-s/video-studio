import * as THREE from "three";
import type { Expression, SpeechSpec3D } from "../spec";

/**
 * The face of a character, whatever the model offers, found by name:
 * - visemes (the 15 standard mouth shapes: "AA_VI_10_aa", "viseme_aa", "aa"...) for speech;
 * - ARKit-style shapes ("JawOpen", "EyeBlinkLeft", "MouthSmileLeft", "BrowInnerUp"...) for expressions, blinks and jaw;
 * - a jaw bone, when there are no shapes.
 * A model with none of these has no face rig: `capabilities.lipSync` is "none" and nothing on it is faked.
 */
const VIS = ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "I", "O", "U"] as const;
type Shape = { mesh: THREE.Mesh; index: number };
const norm = (s: string): string => s.replace(/^.*[.|:]/, "").replace(/[^a-z]/gi, "").toLowerCase();

const EXPR: Record<Expression, Record<string, number>> = {
  neutral: {},
  happy: { mouthsmileleft: 0.65, mouthsmileright: 0.65, cheeksquintleft: 0.35, cheeksquintright: 0.35, eyesquintleft: 0.15, eyesquintright: 0.15 },
  sad: { mouthfrownleft: 0.55, mouthfrownright: 0.55, browinnerup: 0.75, mouthpressleft: 0.2, mouthpressright: 0.2, eyesquintleft: 0.1, eyesquintright: 0.1 },
  angry: { browdownleft: 0.8, browdownright: 0.8, nosesneerleft: 0.35, nosesneerright: 0.35, eyesquintleft: 0.35, eyesquintright: 0.35, mouthpressleft: 0.3, mouthpressright: 0.3, mouthfrownleft: 0.25, mouthfrownright: 0.25 },
  worried: { browinnerup: 0.85, mouthstretchleft: 0.25, mouthstretchright: 0.25, mouthfrownleft: 0.2, mouthfrownright: 0.2, eyewideleft: 0.2, eyewideright: 0.2 },
  surprised: { eyewideleft: 0.85, eyewideright: 0.85, browinnerup: 0.65, browouterupleft: 0.7, browouterupright: 0.7, jawopen: 0.22 },
  fear: { eyewideleft: 0.7, eyewideright: 0.7, browinnerup: 0.9, mouthstretchleft: 0.45, mouthstretchright: 0.45, jawopen: 0.1 },
};

export interface FaceCapabilities { visemes: number; expressionShapes: number; blink: boolean; jawBone: boolean; lipSync: "visemes" | "jaw-shape" | "jaw-bone" | "none" }

export class FaceRig {
  private readonly vis = new Map<string, Shape[]>();
  private readonly shapes = new Map<string, Shape[]>();
  private jaw?: THREE.Bone;
  private jawRest?: THREE.Quaternion;
  readonly capabilities: FaceCapabilities;
  private cur = new Map<Shape, number>();
  private expr = new Map<string, number>();
  private nextBlink: number;
  private blinkAt = -10;
  private rnd: () => number;

  constructor(model: THREE.Object3D, seed = 1) {
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.morphTargetDictionary) return;
      for (const [name, index] of Object.entries(m.morphTargetDictionary)) {
        const raw = name.replace(/^.*[.|:]/, "");
        const vm = /(?:VI_\d+_|viseme_?)(sil|PP|FF|TH|DD|kk|CH|SS|nn|RR|aa|E|I|O|U)$/i.exec(raw);
        if (vm) { const k = VIS.find((v) => v.toLowerCase() === vm[1]!.toLowerCase())!; this.vis.set(k, [...(this.vis.get(k) ?? []), { mesh: m, index }]); continue; }
        const n = norm(raw.replace(/^(AK|AU|SR|HB)_\d+_/, ""));
        this.shapes.set(n, [...(this.shapes.get(n) ?? []), { mesh: m, index }]);
      }
    });
    model.traverse((o) => { if (!this.jaw && (o as THREE.Bone).isBone && /(^|_)m?jaw$/i.test(o.name)) this.jaw = o as THREE.Bone; });
    if (this.jaw) this.jawRest = this.jaw.quaternion.clone();
    const have = [...new Set(Object.values(EXPR).flatMap((e) => Object.keys(e)))].filter((k) => this.shapes.has(k)).length;
    this.capabilities = {
      visemes: this.vis.size, expressionShapes: have, blink: this.shapes.has("eyeblinkleft") || this.shapes.has("blink"), jawBone: !!this.jaw,
      lipSync: this.vis.size >= 5 ? "visemes" : this.shapes.has("jawopen") ? "jaw-shape" : this.jaw ? "jaw-bone" : "none",
    };
    let a = (seed * 2654435761) >>> 0 || 1;
    this.rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    this.nextBlink = 0.8 + this.rnd() * 2.5;
  }

  get hasFace(): boolean { return this.capabilities.lipSync !== "none" || this.capabilities.expressionShapes > 0; }

  /** How open the mouth is and which viseme is active at shot time t (0 / null when not speaking). */
  static speaking(speech: SpeechSpec3D[] | undefined, t: number): { open: number; viseme: string | null; line?: SpeechSpec3D } {
    for (const s of speech ?? []) {
      const u = t - s.at;
      if (u < 0 || u > s.duration) continue;
      const f = u * s.fps, i = Math.floor(f), k = f - i;
      const open = (s.env[i] ?? 0) * (1 - k) + (s.env[i + 1] ?? 0) * k;
      let v: string | null = null;
      for (const x of s.visemes) { if (x.t <= u) v = x.v; else break; }
      return { open, viseme: v, line: s };
    }
    return { open: 0, viseme: null };
  }

  /** One frame: speech, expression (eased), blinks. `listening` = attentive neutral when someone else speaks. */
  update(t: number, dt: number, speech: SpeechSpec3D[] | undefined, expression: Expression): { talking: boolean; open: number } {
    const target = new Map<Shape, number>();
    const add = (list: Shape[] | undefined, w: number): void => { for (const s of list ?? []) target.set(s, Math.min(1, (target.get(s) ?? 0) + w)); };
    // expression: eased toward the recipe, so a face changes over ~0.3 s instead of popping
    const recipe = EXPR[expression] ?? {};
    const keys = new Set([...Object.keys(recipe), ...this.expr.keys()]);
    for (const k of keys) {
      const now = this.expr.get(k) ?? 0, want = recipe[k] ?? 0;
      this.expr.set(k, now + (want - now) * Math.min(1, dt * 6 || 1));
    }
    const sp = FaceRig.speaking(speech, t);
    const talking = sp.viseme !== null || sp.open > 0.02;
    for (const [k, w] of this.expr) {
      // while speaking the mouth belongs to the visemes: expression keeps the brows / eyes / cheeks, softens the mouth
      const mouth = /^(mouth|jaw)/.test(k);
      add(this.shapes.get(k), w * (talking && mouth ? 0.35 : 1));
    }
    // speech: the active viseme scaled by the audio envelope; jaw opening follows the envelope too
    if (talking) {
      const open = Math.min(1, sp.open * 1.15);
      if (this.capabilities.lipSync === "visemes") {
        // the shape is as strong as the voice is loud: silent moments inside a line close the mouth
        add(this.vis.get(sp.viseme ?? "aa"), open > 0.04 ? Math.min(1, 0.12 + open) : 0);
        add(this.shapes.get("jawopen"), 0.18 * open);
      } else if (this.capabilities.lipSync === "jaw-shape") add(this.shapes.get("jawopen"), 0.55 * open);
    }
    if (this.jaw && this.jawRest && this.capabilities.lipSync === "jaw-bone") this.jaw.quaternion.copy(this.jawRest).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.22 * (talking ? sp.open : 0)));
    // blinks: every 2-5 s, 0.16 s long, a little more often while listening
    if (t >= this.nextBlink) { this.blinkAt = t; this.nextBlink = t + 2 + this.rnd() * 3; }
    const b = t - this.blinkAt, blink = b >= 0 && b < 0.16 ? Math.sin((b / 0.16) * Math.PI) : 0;
    if (blink > 0) { add(this.shapes.get("eyeblinkleft"), blink); add(this.shapes.get("eyeblinkright"), blink); add(this.shapes.get("blink"), blink); }
    // ease every shape toward its target (mouth fast, the rest a little slower)
    const all = new Set([...this.cur.keys(), ...target.keys()]);
    for (const s of all) {
      const now = this.cur.get(s) ?? 0, want = target.get(s) ?? 0;
      const v = dt > 0 ? now + (want - now) * Math.min(1, dt * 22) : want;
      this.cur.set(s, v);
      if (s.mesh.morphTargetInfluences) s.mesh.morphTargetInfluences[s.index] = v;
    }
    return { talking, open: sp.open };
  }
}
