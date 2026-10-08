/**
 * Server-side speech providers, for phase 2. Phase 1 runs speech in the browser
 * (`@ops-memory/voice-web` uses the Web Speech API), so nothing implements these yet; they fix the
 * seam so a cloud or self-hosted engine plugs in without touching the rest.
 */

export interface AudioInput {
  /** Raw audio bytes as recorded, e.g. webm/opus from MediaRecorder. */
  data: Uint8Array;
  mimeType: string;
  /** BCP 47, e.g. `en-US`, `vi-VN`. Omit to let the engine detect it. */
  language?: string;
}

export interface Transcript {
  text: string;
  language?: string;
  /** 0..1 when the engine reports it. */
  confidence?: number;
}

export interface SpeechToText {
  readonly name: string;
  transcribe(audio: AudioInput): Promise<Transcript>;
}

export interface SpeechOutput {
  data: Uint8Array;
  mimeType: string;
}

export interface TextToSpeech {
  readonly name: string;
  /** Called per sentence when streaming, so the first words play before the answer is complete. */
  synthesize(text: string, options?: { language?: string; voice?: string }): Promise<SpeechOutput>;
}
