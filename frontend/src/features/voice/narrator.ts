// Plays the guide's voice. Every line is an ElevenLabs clip generated ahead of time with the one
// voice chosen for the app (see scripts/generateDemoNarration.mts), found by the exact words. A line
// with no clip is shown as a caption only: it never switches to a different voice.
import { narrationKey } from './narrationKey';
import { GUIDE } from './personas';

export type VoiceSource = 'elevenlabs' | 'captions';

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

  const key = narrationKey(GUIDE.id, text);
  void loadManifest().then((clips) => {
    if (token !== currentToken) return;
    if (!clips.has(key)) {
      showCaptionOnly();
      return;
    }
    const audio = new Audio(`${NARRATION_URL}/${key}.mp3`);
    currentAudio = audio;
    audio.onended = finish;
    audio.onerror = showCaptionOnly;
    // Playback can be refused if the browser hasn't seen a click yet; captions still carry the tour.
    audio.play().then(() => onSource?.('elevenlabs'), showCaptionOnly);
  });
}
