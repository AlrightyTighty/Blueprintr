import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
      // Always "/", as in a GitHub download. On Windows relative() gives "\", which broke mapping code to Terraform.
      else files.push({ path: relative(root, full).split(sep).join('/'), content: readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return files;
}
