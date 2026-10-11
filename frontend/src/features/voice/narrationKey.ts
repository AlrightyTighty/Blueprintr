/**
 * A short, stable name for a narration clip: the persona plus the exact words spoken. The generator
 * script and the browser both compute it, so a clip is found only when its text is unchanged.
 */
export function narrationKey(personaId: string, text: string): string {
  // FNV-1a, 32 bit. Not secret; only needs to be the same in Node and the browser.
  let hash = 0x811c9dc5;
  for (const character of `${personaId}|${text}`) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${personaId}-${hash.toString(16).padStart(8, '0')}`;
}
