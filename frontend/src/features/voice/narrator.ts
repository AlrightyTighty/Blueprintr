// Plays the guide's voice. Lines are ElevenLabs audio in the one voice chosen for the app: a clip made
// ahead of time (scripts/generateDemoNarration.mts) when there is one for the exact words, otherwise
// the backend speaks it live (POST /narrate). If neither is possible the line is a caption only: it
// never switches to a different voice.
//
// The voice mode (see useVoiceStore) decides what may happen. Only "live" ever calls the backend, so
// "off" and "saved" never spend voice credits.
import { apiPostForBlob } from '../../api';
import { narrationKey } from './narrationKey';
import { GUIDE } from './personas';
import { useVoiceStore } from './useVoiceStore';

/** captions = no recording for this line; off = the voice is switched off. */
export type VoiceSource = 'elevenlabs' | 'captions' | 'off';

const WORDS_PER_SECOND = 2.6;
const NARRATION_URL = '/narration';

let currentAudio: HTMLAudioElement | null = null;
let currentCaptionTimer: ReturnType<typeof setTimeout> | null = null;
// Stopping fires the old clip's end event; the token tells us to ignore it.
let currentToken = 0;

let manifestPromise: Promise<Set<string>> | undefined;

/** Which clips exist (written by `npm run narrate:demo`). Empty if there are none. */
function loadManifest(): Promise<Set<string>> {
  manifestPromise ??= fetch(`${NARRATION_URL}/index.json`)
    .then((response) => (response.ok ? (response.json() as Promise<{ clips: string[] }>) : { clips: [] }))
    .then((manifest) => new Set(manifest.clips))
    .catch(() => new Set<string>());
  return manifestPromise;
}

// Live lines already fetched (or being fetched), by text. Null means the backend couldn't speak it.
const liveAudioByText = new Map<string, Promise<string | null>>();

/** Asks the backend to speak a line. Resolves to an audio URL, or null if that isn't possible. */
function fetchLiveAudio(text: string): Promise<string | null> {
  let pending = liveAudioByText.get(text);
  if (!pending) {
    pending = apiPostForBlob('/narrate', { text })
      .then((audio) => URL.createObjectURL(audio))
      .catch(() => null);
    liveAudioByText.set(text, pending);
    // Don't remember failures: a budget that resets or a server that comes back should work next time.
    void pending.then((url) => {
      if (url === null) liveAudioByText.delete(text);
    });
  }
  return pending;
}

/**
 * Starts getting a line ready so it plays without a gap. Does nothing when a recorded clip exists, and
 * nothing at all unless the voice is live, because this is what would otherwise spend credits.
 */
export function prefetchNarration(text: string): void {
  if (useVoiceStore.getState().mode !== 'live') return;
  void loadManifest().then((clips) => {
    if (!clips.has(narrationKey(GUIDE.id, text))) void fetchLiveAudio(text);
  });
}

export function stopSpeaking(): void {
  currentToken += 1;
  if (currentCaptionTimer) clearTimeout(currentCaptionTimer);
  currentCaptionTimer = null;
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio = null;
  }
}

/**
 * Says `text` in the guide's voice and calls `onDone` when it finishes. With no clip for these exact
 * words it waits about as long as reading would take, so a tour still moves on. `onSource` reports which.
 */
export function speak(text: string, onDone: () => void, onSource?: (source: VoiceSource) => void): void {
  stopSpeaking();
  const token = currentToken;
  const finish = () => {
    if (token === currentToken) onDone();
  };
  const showCaptionOnly = () => {
    if (token !== currentToken) return;
    onSource?.('captions');
    currentCaptionTimer = setTimeout(finish, (text.split(/\s+/).length / WORDS_PER_SECOND) * 1000);
  };

  const play = (url: string) => {
    if (token !== currentToken) return;
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = finish;
    audio.onerror = showCaptionOnly;
    // Playback can be refused if the browser hasn't seen a click yet; captions still carry the tour.
    audio.play().then(() => onSource?.('elevenlabs'), showCaptionOnly);
  };

  const mode = useVoiceStore.getState().mode;
  if (mode === 'off') {
    onSource?.('off');
    currentCaptionTimer = setTimeout(finish, (text.split(/\s+/).length / WORDS_PER_SECOND) * 1000);
    return;
  }

  const key = narrationKey(GUIDE.id, text);
  void loadManifest().then(async (clips) => {
    if (token !== currentToken) return;
    if (clips.has(key)) {
      play(`${NARRATION_URL}/${key}.mp3`);
      return;
    }
    // A line spoken earlier this visit is already paid for, so it can be replayed in any mode but off.
    const alreadySpoken = liveAudioByText.get(text);
    const liveUrl = mode === 'live' ? await fetchLiveAudio(text) : alreadySpoken ? await alreadySpoken : null;
    if (token !== currentToken) return;
    if (liveUrl) play(liveUrl);
    else showCaptionOnly();
  });
}
