// Entry point for `pnpm mock`. The generator lives in server/src/mock/ so the server test suite covers it.
import { runMockCli } from '../server/src/mock/cli';

process.exitCode = runMockCli(process.argv.slice(2), {
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
});
