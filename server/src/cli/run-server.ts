// Entry point for `pnpm dev:server`.
import { buildApp } from '../app';
import { DEFAULT_DB_PATH, openDb } from '../db/client';
import { listenOptions } from '../listen';

const listen = listenOptions();
const dbPath = process.env.REDWHALE_DB ?? DEFAULT_DB_PATH;
const db = openDb(dbPath);
const app = await buildApp({ db, port: listen.port, logger: true });

const shutdown = () => {
  void app.close().then(() => {
    db.$client.close();
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen(listen);
app.log.info(`RED WHALE API on http://${listen.host}:${String(listen.port)} (database ${dbPath})`);
