import type { LanguageId, ServiceDetail } from "@studio/shared";

export interface SubtitleImageRequest {
  text: string;
  language: LanguageId;
  fontFamily: string;
  fontSizePx: number;
  widthPx: number;
  /** Outline width as a percentage of the font size (CoreText semantics). */
  strokePercent: number;
  /** Absolute destination PNG path. */
  outPath: string;
}

export interface SubtitleImage {
  path: string;
  width: number;
  height: number;
}

/**
 * Renders one subtitle cue to a transparent PNG. Implementations must shape complex scripts correctly
 * (Hindi/Devanagari conjuncts); Pillow-without-raqm was measured to fail, which is why CoreText is the default.
 */
export interface SubtitleRenderer {
  readonly name: string;
  render(req: SubtitleImageRequest): Promise<SubtitleImage>;
  health(): Promise<ServiceDetail>;
}
