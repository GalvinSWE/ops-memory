import type { AnswerMode, VoiceAskResponse } from './protocol.js';
import { recognitionCtor, recognitionErrorMessage, synthesis, type Recognition } from './speech-api.js';

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface VoiceSnapshot {
  state: VoiceState;
  /** What was heard, final words only. */
  transcript: string;
  /** Words still being recognised, shown greyed out while listening. */
  interim: string;
  result: VoiceAskResponse | null;
  error: string | null;
}

export interface VoiceAskOptions {
  /** Base URL of the voice server, e.g. `http://127.0.0.1:7401`. */
  endpoint: string;
  /** BCP 47 language for recognition and speech. Default `en-US`. */
  language?: string;
  /** Bearer token, if the server requires one. */
  token?: string;
  /** Answer mode requested from the server. */
  mode?: AnswerMode;
  /** Limit answers to one unit (name or id). */
  unit?: string;
  /** Read answers out loud. Default true. */
  speak?: boolean;
  /** Give up on the server after this long. Default 30 s. */
  timeoutMs?: number;
  /** For tests or custom transports. Default: global `fetch`. */
  fetch?: typeof fetch;
}

export interface VoiceController {
  getSnapshot(): VoiceSnapshot;
  subscribe(listener: () => void): () => void;
  /** Start listening. Stops any answer being read out. */
  start(): void;
  /** Stop listening and send what was heard. */
  stop(): void;
  /** Stop everything: listening, the request, speech. */
  cancel(): void;
  /** Ask a typed question (also what `stop` calls with the transcript). */
  ask(question: string): Promise<VoiceAskResponse | null>;
  /** Read text out loud in the current language. */
  speak(text: string): void;
  update(options: Partial<Omit<VoiceAskOptions, 'endpoint' | 'fetch'>>): void;
  destroy(): void;
}

export interface VoiceSupport {
  /** The browser can turn speech into text. */
  recognition: boolean;
  /** The browser can read text out loud. */
  synthesis: boolean;
}

export const voiceSupport = (): VoiceSupport => ({ recognition: !!recognitionCtor(), synthesis: !!synthesis() });

export const IDLE_SNAPSHOT: VoiceSnapshot = Object.freeze({
  state: 'idle',
  transcript: '',
  interim: '',
  result: null,
  error: null
}) as VoiceSnapshot;

/**
 * Push-to-talk voice questions. Nothing touches the browser until `start`, `ask` or `speak` is
 * called, so it is safe to create during server-side rendering.
 */
export function createVoiceAsk(initial: VoiceAskOptions): VoiceController {
  let options = { language: 'en-US', speak: true, timeoutMs: 30_000, ...initial };
  let snapshot: VoiceSnapshot = IDLE_SNAPSHOT;
  const listeners = new Set<() => void>();
  let recognition: Recognition | null = null;
  let request: AbortController | null = null;
  let finalText = '';

  const set = (patch: Partial<VoiceSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const l of listeners) l();
  };

  const stopSpeech = () => synthesis()?.cancel();

  const speak = (text: string) => {
    const synth = synthesis();
    if (!synth || !text) return set({ state: 'idle' });
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = options.language;
    const prefix = options.language.split('-')[0]!.toLowerCase();
    const voices = synth.getVoices();
    const voice =
      voices.find((v) => v.lang.toLowerCase() === options.language.toLowerCase()) ??
      voices.find((v) => v.lang.toLowerCase().startsWith(prefix));
    if (voice) utterance.voice = voice;
    utterance.onend = () => snapshot.state === 'speaking' && set({ state: 'idle' });
    utterance.onerror = () => snapshot.state === 'speaking' && set({ state: 'idle' });
    set({ state: 'speaking' });
    synth.speak(utterance);
  };

  const ask = async (question: string): Promise<VoiceAskResponse | null> => {
    const text = question.trim();
    if (!text) {
      set({ state: 'idle' });
      return null;
    }
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    set({ state: 'thinking', transcript: text, interim: '', error: null });
    try {
      const doFetch = options.fetch ?? fetch;
      const res = await doFetch(`${options.endpoint.replace(/\/$/, '')}/v1/ask`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
        },
        body: JSON.stringify({ question: text, unit: options.unit, mode: options.mode }),
        signal: controller.signal
      });
      const body = (await res.json().catch(() => ({}))) as VoiceAskResponse & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `server answered ${res.status}`);
      if (request !== controller) return null; // superseded by a newer question
      set({ result: body });
      if (options.speak) speak(body.spoken);
      else set({ state: 'idle' });
      return body;
    } catch (error) {
      if (request !== controller) return null;
      const aborted = controller.signal.aborted;
      set({ state: 'error', error: aborted ? 'The memory server took too long to answer.' : messageOf(error) });
      return null;
    } finally {
      clearTimeout(timer);
      if (request === controller) request = null;
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      const Ctor = recognitionCtor();
      if (!Ctor) return set({ state: 'error', error: 'This browser cannot recognise speech. Use Chrome, Edge or Safari, or type the question.' });
      stopSpeech();
      request?.abort();
      recognition?.abort();
      finalText = '';
      const rec = new Ctor();
      rec.lang = options.language;
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i]!;
          if (r.isFinal) finalText += r[0]!.transcript;
          else interim += r[0]!.transcript;
        }
        set({ transcript: finalText.trim(), interim: interim.trim() });
      };
      rec.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        set({ state: 'error', error: recognitionErrorMessage(e.error) });
      };
      rec.onend = () => {
        if (recognition !== rec) return;
        recognition = null;
        if (snapshot.state !== 'listening') return;
        const heard = (finalText || snapshot.interim).trim();
        if (heard) void ask(heard);
        else set({ state: 'idle', interim: '' });
      };
      recognition = rec;
      set({ state: 'listening', transcript: '', interim: '', error: null, result: null });
      rec.start();
    },

    stop() {
      // Recognition finishes the last words, then `onend` sends the question.
      recognition?.stop();
    },

    cancel() {
      recognition?.abort();
      recognition = null;
      request?.abort();
      request = null;
      stopSpeech();
      set({ state: 'idle', interim: '' });
    },

    ask,
    speak,

    update(patch) {
      options = { ...options, ...patch };
    },

    destroy() {
      recognition?.abort();
      request?.abort();
      stopSpeech();
      listeners.clear();
    }
  };
}

const messageOf = (e: unknown) =>
  e instanceof TypeError ? 'Cannot reach the memory server. Is it running?' : e instanceof Error ? e.message : String(e);
