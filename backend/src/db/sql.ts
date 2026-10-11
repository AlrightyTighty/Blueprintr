/**
 * Builds the `SET` clause for a partial update. `columns` maps patch keys to column names;
 * keys whose value is `undefined` are skipped. Returns null when there is nothing to set.
 */
export function buildSet(
  patch: Record<string, unknown>,
  columns: Record<string, string>,
  startIndex = 1,
): { clause: string; values: unknown[] } | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    const value = patch[key];
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${startIndex + values.length - 1}`);
  }
  return sets.length === 0 ? null : { clause: sets.join(', '), values };
}
