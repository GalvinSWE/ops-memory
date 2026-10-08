/**
 * Copy of the wire types in `@ops-memory/voice-core/src/protocol.ts`, kept here so this package
 * installs with no dependencies. Change both together.
 */
export type AnswerMode = 'model' | 'facts' | 'auto';

export interface VoiceAskRequest {
  question: string;
  unit?: string;
  mode?: AnswerMode;
}

export interface VoiceSource {
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
  answer: string;
  spoken: string;
  answeredBy: 'model' | 'facts';
  sources: VoiceSource[];
  units: { id: string; name: string }[];
  costUsd: number;
}
