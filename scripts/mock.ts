// Entry point for `pnpm mock` (the showcase) and `pnpm mock:large` (`--large`, passed by the package script).
// The generators live in server/src/mock/ so the server test suite covers them.
import { runMockCli } from '../server/src/mock/cli';

const argv = process.argv.slice(2);
const large = argv[0] === '--large';

process.exitCode = runMockCli(large ? 'large' : 'showcase', large ? argv.slice(1) : argv, {
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
});
