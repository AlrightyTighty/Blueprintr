import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { resetNarration } from '../src/services/narration.js';
import { createFakes } from './fakes.js';

describe('POST /narrate', () => {
  const fakes = createFakes();
  const app = buildApp({ integrations: fakes.integrations, logger: false });
  const speak = (text: unknown) => app.inject({ method: 'POST', url: '/narrate', payload: { text } as object });

  beforeEach(() => {
    resetNarration();
    vi.restoreAllMocks();
  });

  it('returns the line as MP3 without needing an account', async () => {
    const res = await speak('Welcome to the tour.');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('audio/mpeg');
    expect(res.body).toContain('Welcome to the tour.');
  });

  it('speaks a repeated line only once', async () => {
    const synthesize = vi.spyOn(fakes.elevenlabs, 'synthesize');
    await speak('The same line.');
    await speak('The same line.');
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it('rejects empty and over-long lines', async () => {
    expect((await speak('   ')).statusCode).toBe(422);
    expect((await speak('x'.repeat(701))).statusCode).toBe(422);
  });

  it('stops spending once the daily character budget is used up', async () => {
    const synthesize = vi.spyOn(fakes.elevenlabs, 'synthesize');
    // 700 characters each, a different line every time.
    const line = (n: number) => `${n}`.padEnd(700, 'a');
    let lastStatus = 200;
    let spoken = 0;
    for (let n = 0; n < 10 && lastStatus === 200; n += 1) {
      lastStatus = (await speak(line(n))).statusCode;
      if (lastStatus === 200) spoken += 1;
    }
    expect(lastStatus).toBe(429);
    // 5 lines is 3500 characters, within the 4000 budget; a 6th would make 4200.
    expect(spoken).toBe(5);
    expect(synthesize).toHaveBeenCalledTimes(5);
    // A line already spoken today is still free.
    expect((await speak(line(0))).statusCode).toBe(200);
  });

  it('gives the budget back when ElevenLabs fails', async () => {
    vi.spyOn(fakes.elevenlabs, 'synthesize').mockRejectedValueOnce(new Error('upstream down'));
    expect((await speak('First try.')).statusCode).toBe(500);
    expect((await speak('First try.')).statusCode).toBe(200);
  });
});
