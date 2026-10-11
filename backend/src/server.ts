import { buildApp } from './app.js';
import { getConfig } from './config.js';
import { closePool } from './db/pool.js';

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
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
