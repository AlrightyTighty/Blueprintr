// Speaks tour scripts. Plays a pre-generated ElevenLabs clip when one exists for the exact words,
// otherwise falls back to the browser's built-in voice. Narration is the one place speech is
// triggered from, so changing how the guide sounds means changing only this file.
import { narrationKey } from './narrationKey';
import type { Persona } from './personas';

export type VoiceSource = 'elevenlabs' | 'browser';

const WORDS_PER_SECOND = 2.6;
const NARRATION_URL = '/narration';

let currentUtterance: SpeechSynthesisUtterance | null = null;
let currentAudio: HTMLAudioElement | null = null;
let currentFallbackTimer: ReturnType<typeof setTimeout> | null = null;
// Cancelling fires the old speech's end event; the token tells us to ignore it.
let currentToken = 0;

let manifestPromise: Promise<Set<string>> | undefined;

/** Which narration clips were generated (written by `npm run narrate:demo`). Empty if there are none. */
function loadManifest(): Promise<Set<string>> {
  manifestPromise ??= fetch(`${NARRATION_URL}/index.json`)
    .then((response) => (response.ok ? (response.json() as Promise<{ clips: string[] }>) : { clips: [] }))
    .then((manifest) => new Set(manifest.clips))
    .catch(() => new Set<string>());
  return manifestPromise;
}

export function isSpeechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Picks an English voice, spreading personas across the voices the device has. */
function pickVoice(persona: Persona): SpeechSynthesisVoice | undefined {
  const englishVoices = window.speechSynthesis.getVoices().filter((voice) => voice.lang.startsWith('en'));
  if (englishVoices.length === 0) return undefined;
  return persona.id === 'calm_docent' ? englishVoices[0] : englishVoices[Math.min(1, englishVoices.length - 1)];
}

export function stopSpeaking(): void {
  currentToken += 1;
  if (currentFallbackTimer) clearTimeout(currentFallbackTimer);
  currentFallbackTimer = null;
  currentUtterance = null;
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio = null;
  }
  if (isSpeechAvailable()) window.speechSynthesis.cancel();
}

function speakWithBrowserVoice(text: string, persona: Persona, token: number, finish: () => void): void {
  if (!isSpeechAvailable()) {
    // No speech support at all: wait about as long as reading would take, so the tour still advances.
    currentFallbackTimer = setTimeout(finish, (text.split(/\s+/).length / WORDS_PER_SECOND) * 1000);
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = persona.rate;
  utterance.pitch = persona.pitch;
  const voice = pickVoice(persona);
  if (voice) utterance.voice = voice;
  utterance.onend = finish;
  utterance.onerror = (event) => {
    // 'canceled' and 'interrupted' are us stopping it; anything else would stall the tour.
    if (event.error !== 'canceled' && event.error !== 'interrupted') finish();
  };
  // Browsers drop the end event if the utterance is garbage-collected, so keep a reference.
  currentUtterance = utterance;
  // A short delay after cancel() avoids Chrome swallowing the next utterance.
  setTimeout(() => {
    if (token === currentToken && currentUtterance === utterance) window.speechSynthesis.speak(utterance);
  }, 60);
}

/**
 * Reads `text` aloud and calls `onDone` when it finishes. `onSource` reports which voice is used.
 */
export function speak(text: string, persona: Persona, onDone: () => void, onSource?: (source: VoiceSource) => void): void {
  stopSpeaking();
  const token = currentToken;
  const finish = () => {
    if (token === currentToken) onDone();
  };
  const fallBack = () => {
    if (token !== currentToken) return;
    onSource?.('browser');
    speakWithBrowserVoice(text, persona, token, finish);
  };

  const key = narrationKey(persona.id, text);
  void loadManifest().then((clips) => {
    if (token !== currentToken) return;
    if (!clips.has(key)) {
      fallBack();
      return;
    }
    const audio = new Audio(`${NARRATION_URL}/${key}.mp3`);
    currentAudio = audio;
    audio.onended = finish;
    audio.onerror = fallBack;
    // Playback can be refused (no user gesture yet); the browser voice still works then.
    audio.play().then(() => onSource?.('elevenlabs'), fallBack);
  });
}
