import { getConfig } from '../config.js';
import { AppError } from '../http/errors.js';
import { integrations } from '../integrations/registry.js';

const MAX_CACHED_LINES = 200;

// Both live in this process only. Fine for one server; on Lambda each warm instance has its own.
const audioByText = new Map<string, Buffer>();
let budgetDay = '';
let charactersSpentToday = 0;

/** For tests. */
export function resetNarration(): void {
  audioByText.clear();
  budgetDay = '';
  charactersSpentToday = 0;
}

function budgetExceeded(): AppError {
  return new AppError(
    429,
    'narration_budget_exceeded',
    'Narration budget used up',
    "Today's spoken-narration budget is used up. Captions still work; it resets tomorrow (UTC).",
  );
}

/** Speaks `text` in the configured voice. A line already spoken is served from memory and costs nothing. */
export async function narrate(text: string): Promise<Buffer> {
  const cached = audioByText.get(text);
  if (cached) return cached;

  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) {
    budgetDay = today;
    charactersSpentToday = 0;
  }
  if (charactersSpentToday + text.length > getConfig().NARRATION_DAILY_CHARACTER_BUDGET) throw budgetExceeded();

  // Reserve first so simultaneous requests can't all slip under the limit, and give it back on failure.
  charactersSpentToday += text.length;
  try {
    const audio = await integrations().elevenlabs.synthesize(text);
    if (audioByText.size >= MAX_CACHED_LINES) audioByText.delete(audioByText.keys().next().value!);
    audioByText.set(text, audio);
    return audio;
  } catch (error) {
    charactersSpentToday -= text.length;
    throw error;
  }
}
