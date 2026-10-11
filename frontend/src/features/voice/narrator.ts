// Speaks tour scripts with the browser's built-in voice. Narration is the one place speech is
// triggered from, so swapping in ElevenLabs audio later means changing only this file.
import type { Persona } from './personas';

const WORDS_PER_SECOND = 2.6;

let currentUtterance: SpeechSynthesisUtterance | null = null;
let currentFallbackTimer: ReturnType<typeof setTimeout> | null = null;
// Cancelling fires the old utterance's end event; the token tells us to ignore it.
let currentToken = 0;

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
  if (isSpeechAvailable()) window.speechSynthesis.cancel();
}

/**
 * Reads `text` aloud and calls `onDone` when it finishes. With no speech support it waits about as
 * long as reading would take, so the tour still advances.
 */
export function speak(text: string, persona: Persona, onDone: () => void): void {
  stopSpeaking();
  const token = currentToken;
  const finish = () => {
    if (token === currentToken) onDone();
  };

  if (!isSpeechAvailable()) {
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
