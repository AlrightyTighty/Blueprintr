import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root, resolved from this file so paths work regardless of cwd.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
export const FRONTEND_DIR = path.join(REPO_ROOT, 'frontend');
