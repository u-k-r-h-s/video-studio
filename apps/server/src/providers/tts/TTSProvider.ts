import type { LanguageId, ServiceDetail } from "@studio/shared";

export interface VoiceInfo {
  id: string;
  language: LanguageId;
  /** Provider-specific model reference (for Piper: file name inside the voices directory). */
  model: string;
  speaker?: number;
  license?: string;
}

export interface SpeechRequest {
  text: string;
  voiceId: string;
  /** Absolute destination of the raw (untrimmed) WAV. */
  outPath: string;
  signal?: AbortSignal;
}

export interface SpeechResult {
  path: string;
  durationSec: number;
}

export interface TTSProvider {
  readonly name: string;
  listVoices(): VoiceInfo[];
  getVoice(voiceId: string): VoiceInfo;
  synthesize(req: SpeechRequest): Promise<SpeechResult>;
  health(): Promise<ServiceDetail>;
}
