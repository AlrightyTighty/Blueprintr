import { readFileSync } from 'node:fs';
import pg from 'pg';
import { getConfig } from '../config.js';

// bigint columns (activity_log.id, github ids) fit comfortably in a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

/** Anything that can run a query: the pool, or a client inside a transaction. */
export interface Db {
  query: pg.Pool['query'];
}

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const config = getConfig();
    let ssl: pg.PoolConfig['ssl'];
    if (config.DATABASE_SSL === 'disable') ssl = false;
    else if (config.DATABASE_CA_PATH) ssl = { ca: readFileSync(config.DATABASE_CA_PATH, 'utf8'), rejectUnauthorized: true };

    pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ...(ssl === undefined ? {} : { ssl }),
    });
    pool.on('error', (err) => console.error('idle database client error', err));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}

/** Runs `fn` in a transaction; commits on success, rolls back (and rethrows) on error. */
export async function withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
