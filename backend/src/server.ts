import { buildApp } from './app.js';
import { getConfig } from './config.js';
import { closePool, getPool } from './db/pool.js';
import * as runs from './repositories/analysisRuns.js';

getConfig(); // fail fast on a bad environment

const app = buildApp();
const port = Number(process.env.PORT ?? 3000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().then(closePool).finally(() => process.exit(0));
  });
}

try {
  await app.listen({ port, host: '0.0.0.0' });
  // This server runs analyses in its own process, so any run still "running" from before a restart is dead.
  // (Not done on Lambda, where other instances may be running real analyses.)
  await runs.failAllActive(getPool(), 'The server restarted while this analysis was running. Try again.');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
