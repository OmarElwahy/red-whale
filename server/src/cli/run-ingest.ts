// Entry point for `pnpm ingest`.
import { runIngestCli } from './ingest';

process.exitCode = runIngestCli(process.argv.slice(2), {
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
});
