import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createVoiceAsk, IDLE_SNAPSHOT, voiceSupport, type VoiceAskOptions, type VoiceController, type VoiceSnapshot, type VoiceSupport } from './controller.js';

export interface UseVoiceAsk extends VoiceSnapshot {
  supported: VoiceSupport;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  ask: VoiceController['ask'];
  speak: VoiceController['speak'];
}

const SERVER_SUPPORT: VoiceSupport = { recognition: false, synthesis: false };

/**
 * React binding for `createVoiceAsk`. Options other than `endpoint` and `fetch` can change between
 * renders (language toggle, current unit) without recreating the controller.
 */
export function useVoiceAsk(options: VoiceAskOptions): UseVoiceAsk {
  const ref = useRef<VoiceController | null>(null);
  if (!ref.current) ref.current = createVoiceAsk(options);
  const controller = ref.current;

  useEffect(() => () => controller.destroy(), [controller]);
  useEffect(() => {
    controller.update({ language: options.language, token: options.token, mode: options.mode, unit: options.unit, speak: options.speak, timeoutMs: options.timeoutMs });
  }, [controller, options.language, options.token, options.mode, options.unit, options.speak, options.timeoutMs]);

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => IDLE_SNAPSHOT);
  // Support is only known in the browser; render as unsupported on the server to match hydration.
  const supported = useSyncExternalStore(noopSubscribe, voiceSupportCached, () => SERVER_SUPPORT);

  return useMemo(
    () => ({
      ...snapshot,
      supported,
      start: controller.start,
      stop: controller.stop,
      cancel: controller.cancel,
      ask: controller.ask,
      speak: controller.speak
    }),
    [snapshot, supported, controller]
  );
}

const noopSubscribe = () => () => {};
let cachedSupport: VoiceSupport | null = null;
const voiceSupportCached = () => (cachedSupport ??= voiceSupport());
