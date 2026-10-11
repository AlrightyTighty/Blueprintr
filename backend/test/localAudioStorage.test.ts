import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalAudioStorage } from '../src/integrations/localAudioStorage.js';

describe('LocalAudioStorage', () => {
  let directory: string;
  let storage: LocalAudioStorage;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ripplemap-audio-test-'));
    storage = new LocalAudioStorage(directory);
  });
  afterAll(() => rm(directory, { recursive: true, force: true }));

  it('is always available, with no bucket needed', () => {
    expect(storage.isConfigured()).toBe(true);
  });

  it('stores audio and returns it as a playable data URL', async () => {
    await storage.put('briefings/project/plan.mp3', Buffer.from('mp3-bytes'));
    expect(await storage.exists('briefings/project/plan.mp3')).toBe(true);
    const url = await storage.signedUrl('briefings/project/plan.mp3');
    expect(url).toBe(`data:audio/mpeg;base64,${Buffer.from('mp3-bytes').toString('base64')}`);
  });

  it('reports audio it does not have, so the briefing is made again', async () => {
    expect(await storage.exists('briefings/project/missing.mp3')).toBe(false);
  });

  it('refuses keys that try to leave its folder', async () => {
    await expect(storage.put('../escape.mp3', Buffer.from('x'))).rejects.toThrow('Invalid audio key');
    expect(await storage.exists('../escape.mp3')).toBe(false);
  });
});
