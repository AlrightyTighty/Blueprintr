import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { resetConfig } from '../src/config.js';
import { closePool } from '../src/db/pool.js';

const MIGRATIONS = join(import.meta.dirname, '../../database');

/**
 * Creates a scratch database, applies the real migrations from /database, and points the app at it.
 * Needs TEST_DATABASE_URL: a connection string for a Postgres server where we may CREATE DATABASE.
 */
export async function createTestDatabase(): Promise<() => Promise<void>> {
  const adminUrl = process.env.TEST_DATABASE_URL!;
  const name = `blueprint_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  for (const file of readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort()) {
    await db.query(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  await db.end();

  process.env.DATABASE_URL = url.toString();
  resetConfig();

  return async () => {
    await closePool();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  };
}
