import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SourceFile } from '../src/core/terraform/model.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** Reads a fixture folder into the same shape the GitHub downloader produces. */
export function loadFixture(name: string): SourceFile[] {
  const root = join(FIXTURES, name);
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push({ path: relative(root, full), content: readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return files;
}
