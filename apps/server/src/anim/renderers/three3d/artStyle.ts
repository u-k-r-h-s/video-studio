/**
 * Art direction presets. A style is more than lighting: it chooses the shading model (physically based or a toon ramp),
 * the colour palettes the sets are painted with, the post grade, an exposure bias, the lens, and which character library
 * the casting prefers. The story (or the profile) names the style; the visual plan applies it to every scene.
 */
export const ART_STYLES = ["cinematic", "semi-realistic", "family-animated", "indian-folk"] as const;
export type ArtStyleId = (typeof ART_STYLES)[number];

export interface Palette { wall: string; door: string; trim: string; roof: string }
export interface ArtStyle {
  id: ArtStyleId;
  label: string;
  /** "pbr": physically based materials; "toon": a 3-step light ramp on every material (flat, painterly bands). */
  shading: "pbr" | "toon";
  /** Set colours, one picked per location (so two places in the same story differ). */
  palettes: Palette[];
  grade: { contrast: number; saturation: number; bloom: number; grain: number; vignette: number };
  /** Added to the lighting preset's exposure (stops-ish, multiplicative). */
  exposure: number;
  /** Lens multiplier on every framing (< 1 longer, > 1 wider). */
  lens: number;
  /** Character library style the casting prefers (config/characters3d.json). */
  characters: string;
}

export const STYLES: Record<ArtStyleId, ArtStyle> = {
  cinematic: {
    id: "cinematic", label: "Cinematic stylized 3D", shading: "pbr", exposure: 1, lens: 0.92, characters: "semi-realistic",
    palettes: [{ wall: "#cfa77a", door: "#2f4f6f", trim: "#efe4cf", roof: "#5a3a2c" }, { wall: "#9fb3bf", door: "#7a3328", trim: "#e8e2d6", roof: "#3a4250" }, { wall: "#d8c4a0", door: "#2e5b4a", trim: "#f2ead8", roof: "#6a3a2a" }],
    grade: { contrast: 1.08, saturation: 1.02, bloom: 0.16, grain: 4, vignette: 0.85 },
  },
  "semi-realistic": {
    id: "semi-realistic", label: "Realistic / semi-realistic 3D", shading: "pbr", exposure: 1, lens: 1, characters: "semi-realistic",
    palettes: [{ wall: "#d6c7ad", door: "#4a3a2c", trim: "#ece6da", roof: "#6b5444" }, { wall: "#c9b8a0", door: "#3c4a52", trim: "#e2ddd2", roof: "#5c4a3e" }, { wall: "#e0d2bc", door: "#5a4030", trim: "#f0ebe2", roof: "#4e4038" }],
    grade: { contrast: 1.03, saturation: 0.97, bloom: 0.08, grain: 2, vignette: 0.45 },
  },
  "family-animated": {
    id: "family-animated", label: "Family animated-film 3D", shading: "pbr", exposure: 1.12, lens: 1.06, characters: "semi-realistic",
    palettes: [{ wall: "#f2c48d", door: "#3d8bd6", trim: "#fff6e6", roof: "#d9583b" }, { wall: "#a8e0c8", door: "#e66a6a", trim: "#ffffff", roof: "#5a7bd6" }, { wall: "#f7d6e0", door: "#6a4fc2", trim: "#fff8f0", roof: "#e08a3a" }],
    grade: { contrast: 0.98, saturation: 1.2, bloom: 0.22, grain: 1, vignette: 0.35 },
  },
  "indian-folk": {
    id: "indian-folk", label: "Indian folk-story 3D", shading: "toon", exposure: 1.05, lens: 1, characters: "semi-realistic",
    palettes: [{ wall: "#e3a84c", door: "#1f4e8c", trim: "#f6ead0", roof: "#a8432a" }, { wall: "#c4553a", door: "#2b6b4f", trim: "#f2d38a", roof: "#5a2a1e" }, { wall: "#6f8fc4", door: "#c4553a", trim: "#f6ead0", roof: "#3a2a5a" }, { wall: "#e8c7a0", door: "#8a2a4a", trim: "#fff1d0", roof: "#2e5a4a" }],
    grade: { contrast: 1.06, saturation: 1.28, bloom: 0.12, grain: 3, vignette: 0.7 },
  },
};

export function artStyleOf(id: string | undefined): ArtStyle {
  return STYLES[(ART_STYLES as readonly string[]).includes(id ?? "") ? (id as ArtStyleId) : "cinematic"];
}
