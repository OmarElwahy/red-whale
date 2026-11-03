// `pnpm lab:up | lab:down | lab:status` (lab/README.md). Docker only through the runtime (docker.ts).
import { DockerRuntime } from '../runner/docker';
import { labDown, labStatus, labUp, type LabIo } from '../runner/lab';
import { NetworkError, toolsNetwork } from '../runner/network';

const io: LabIo = {
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
};

async function main(command: string | undefined): Promise<number> {
  const runtime = new DockerRuntime();
  if (command === 'down') return labDown(runtime, io);
  if (command !== 'up' && command !== 'status') {
    io.err('usage: pnpm lab:up | pnpm lab:down | pnpm lab:status');
    return 2;
  }
  let network;
  try {
    network = toolsNetwork();
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    io.err(`✗ ${e.message}`);
    return 1;
  }
  return command === 'up' ? labUp(runtime, network, io) : labStatus(runtime, network, io);
}

process.exitCode = await main(process.argv.slice(2).find((a) => a !== '--'));
