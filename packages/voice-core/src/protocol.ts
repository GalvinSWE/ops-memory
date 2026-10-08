/**
 * The wire format between a voice client and a voice server. Plain JSON, versioned by path
 * (`/v1/ask`). `@ops-memory/voice-web` keeps its own copy of these types so it installs with no
 * dependencies; change both together.
 */

/**
 * How the answer is produced.
 * - `model`: the LLM answers from the facts (costs tokens, reads naturally).
 * - `facts`: the facts are read out as they are (free, no model call).
 * - `auto`: `model`, falling back to `facts` if the model cannot be reached.
 */
export type AnswerMode = 'model' | 'facts' | 'auto';

export interface VoiceAskRequest {
  question: string;
  /** Unit name or id, when the UI already knows which unit the person means. */
  unit?: string;
  mode?: AnswerMode;
}

export interface VoiceSource {
  /** `F1`, `F2`… as cited in the answer. */
  ref: string;
  unit: string;
  kind: string;
  topic: string;
  status: 'active' | 'resolved';
  statement: string;
  confidence: number;
  quote: string;
  date: string;
  url?: string;
}

export interface VoiceAskResponse {
  question: string;
  /** The answer as text, citations included, for the screen. */
  answer: string;
  /** The answer cleaned up for text-to-speech: no citations, markup or links. */
  spoken: string;
  /** Which mode actually produced the answer. */
  answeredBy: 'model' | 'facts';
  sources: VoiceSource[];
  units: { id: string; name: string }[];
  costUsd: number;
}

export interface VoiceErrorResponse {
  error: string;
}
