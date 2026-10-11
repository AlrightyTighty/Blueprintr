import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The deploy only passes along the settings it lists. A setting added to config.ts but not to the stack
// would silently fall back to its default in production, so this test makes the two lists agree.
const read = (relative: string) => readFileSync(path.join(__dirname, '../..', relative), 'utf-8');

/** Settings the stack (or Lambda itself) provides rather than the deploying shell. */
const SET_BY_THE_STACK = ['NODE_ENV', 'AUDIO_BUCKET', 'AWS_REGION', 'DB_POOL_MAX', 'DATABASE_CA_PATH'];
/** Settings that only make sense on a laptop. */
const LOCAL_ONLY = ['DATABASE_SSL'];

describe('deploy configuration', () => {
  const configKeys = [...read('backend/src/config.ts').matchAll(/^  ([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]);
  const passedThrough = [...(/PASSTHROUGH_ENV = \[([\s\S]*?)\] as const/.exec(read('iac/lib/stacks/backend-stack.ts'))?.[1] ?? '').matchAll(/'([A-Z0-9_]+)'/g)].map((match) => match[1]);

  it('reads both lists', () => {
    expect(configKeys.length).toBeGreaterThan(20);
    expect(passedThrough.length).toBeGreaterThan(10);
  });

  it('passes every backend setting to the deployed function, or says why not', () => {
    const accountedFor = new Set([...passedThrough, ...SET_BY_THE_STACK, ...LOCAL_ONLY]);
    expect(configKeys.filter((key) => !accountedFor.has(key))).toEqual([]);
  });

  it('does not pass along settings the backend no longer has', () => {
    expect(passedThrough.filter((key) => !configKeys.includes(key))).toEqual([]);
  });
});
