// Entry point for `pnpm dev:server`.
import { buildApp, type RunnerOptions } from '../app';
import { DEFAULT_DB_PATH, OutdatedDatabaseError, openDb } from '../db/client';
import { listenOptions } from '../listen';
import { CatalogError, loadCatalog } from '../runner/catalog';
import { DockerRuntime } from '../runner/docker';
import { jobsDirFor } from '../runner/finish';

const listen = listenOptions();
const dbPath = process.env.REDWHALE_DB ?? DEFAULT_DB_PATH;
function open() {
  try {
    return openDb(dbPath);
  } catch (e) {
    if (!(e instanceof OutdatedDatabaseError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}
const db = open();

/** The tool runner, unless tools/ holds invalid definitions (then the graph still works; runs answer 503). */
function runnerOptions(): RunnerOptions | undefined {
  try {
    const catalog = loadCatalog();
    const maxJobs = Number(process.env.REDWHALE_MAX_JOBS ?? '2');
    return {
      runtime: new DockerRuntime(),
      catalog,
      jobsDir: jobsDirFor(dbPath),
      maxJobs: Number.isInteger(maxJobs) && maxJobs > 0 ? maxJobs : 2,
    };
  } catch (e) {
    if (!(e instanceof CatalogError)) throw e;
    console.error(`${e.message}\nThe tool runner is OFF until these are fixed (pnpm tools:check).`);
    return undefined;
  }
}

const app = await buildApp({ db, port: listen.port, logger: true, runner: runnerOptions() });
// Jobs left running by the last process fail, its containers go, and the queue resumes; then Docker is watched.
await app.orchestrator?.recover();
app.orchestrator?.startMonitor();

const shutdown = () => {
  void app.close().then(() => {
    db.$client.close();
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen(listen);
app.log.info(`RED WHALE API on http://${listen.host}:${String(listen.port)} (database ${dbPath})`);
