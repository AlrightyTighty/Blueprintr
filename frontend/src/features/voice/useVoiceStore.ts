import { create } from 'zustand';

/**
 * How much the guide may speak:
 * - off:   captions only, nothing is played and nothing is spent.
 * - saved: plays the pre-recorded clips (the demo tours); free. Anything without a clip is a caption.
 * - live:  also has ElevenLabs speak any other line on demand; this uses voice credits.
 */
export type VoiceMode = 'off' | 'saved' | 'live';

const STORAGE_KEY = 'ripplemap.voiceMode';
const DEFAULT_MODE: VoiceMode = 'saved';

function readStoredMode(): VoiceMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'off' || stored === 'saved' || stored === 'live' ? stored : DEFAULT_MODE;
  } catch {
    // Storage can be blocked; fall back to the free default.
    return DEFAULT_MODE;
  }
}

interface VoiceStoreState {
  mode: VoiceMode;
  setMode: (mode: VoiceMode) => void;
}

export const useVoiceStore = create<VoiceStoreState>((set) => ({
  mode: readStoredMode(),
  setMode: (mode) => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // The choice still applies for this visit.
    }
    set({ mode });
  },
}));
