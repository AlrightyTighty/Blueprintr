import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { AudioStorage } from './audioStorage.js';

/**
 * Keeps briefing audio on local disk, for running without an S3 bucket (AUDIO_BUCKET unset), such as on a
 * laptop. Files survive restarts, so a cached briefing keeps working. The "signed URL" is a data: URL
 * holding the audio itself, so no extra route or bucket is needed.
 */
export class LocalAudioStorage implements AudioStorage {
  private readonly directory: string;

  constructor(directory = join(tmpdir(), 'ripplemap-audio')) {
    this.directory = resolve(directory);
  }

  isConfigured(): boolean {
    return true;
  }

  private pathFor(key: string): string {
    const path = resolve(this.directory, key);
    // Keys are built by the server, but never let one climb out of the folder.
    if (!path.startsWith(this.directory + sep)) throw new Error(`Invalid audio key: ${key}`);
    return path;
  }

  async put(key: string, audio: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, audio);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string): Promise<string> {
    const audio = await readFile(this.pathFor(key));
    return `data:audio/mpeg;base64,${audio.toString('base64')}`;
  }
}
