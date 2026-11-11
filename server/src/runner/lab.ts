// The local lab (docs/architecture.md §11, lab/README.md): one nginx container on the tools network, reachable from
// job containers as lab.redwhale.test (and elsewhere.redwhale.test, the redirect target), with a fixed address and
// no host ports. `pnpm lab:up/down/status` (server/src/cli/lab.ts) call labUp/labDown/labStatus here, through the
// runtime interface; the spec is pure and unit-tested like spec.ts.
//
// lab:up never adds scope rules: the analyst adds them (it prints which).
import { fileURLToPath } from 'node:url';
import { LABEL_CONTEXT, hashFiles } from './catalog';
import { hostInSubnet } from './network';
import type { ContainerRuntime, NetworkSpec, ServiceSpec } from './runtime';

export const LAB_DIR = fileURLToPath(new URL('../../../lab', import.meta.url));
/** Exactly what goes into the lab image (and its tag). */
export const LAB_FILES = ['Dockerfile', 'index.html', 'nginx.conf'] as const;
export const LAB_REPO = 'redwhale-lab';
export const LAB_CONTAINER = 'redwhale-lab';
export const LABEL_LAB = 'redwhale.lab';
export const LAB_HOST = 'lab.redwhale.test';
/** Where http://lab.redwhale.test/ redirects: another host, also this container, so a followed redirect is logged. */
export const LAB_REDIRECT_HOST = 'elsewhere.redwhale.test';
/** The lab's host number in the tools subnet (.10 of the default /24); below the dynamic range. */
export const LAB_HOST_OFFSET = 10;
/** The TCP ports nginx listens on (lab/nginx.conf): 80 redirects, 443 the page, 8080 a plain page. */
export const LAB_PORTS = [80, 443, 8080] as const;
/** nginx's own user in the image. */
export const LAB_USER = '101:101';

export const labIp = (network: NetworkSpec): string => hostInSubnet(network.subnet, LAB_HOST_OFFSET);

export function labImage(dir: string = LAB_DIR): { ref: string; hash: string } {
  const hash = hashFiles(dir, LAB_FILES);
  return { ref: `${LAB_REPO}:${hash.slice(0, 12)}`, hash };
}

/** The lab container. Hardened like a job (read-only root, no capabilities, small limits) and never published. */
export function labSpec(image: { ref: string; hash: string }, network: NetworkSpec): ServiceSpec {
  const labels = { [LABEL_LAB]: 'lab', [LABEL_CONTEXT]: image.hash };
  return {
    name: LAB_CONTAINER,
    body: {
      Image: image.ref,
      User: LAB_USER,
      Labels: labels,
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Privileged: false,
        Memory: 128 * 1024 * 1024,
        MemorySwap: 128 * 1024 * 1024,
        NanoCpus: 500_000_000,
        PidsLimit: 64,
        Tmpfs: {
          '/tmp': 'rw,noexec,nosuid,nodev,size=16m',
          '/var/cache/nginx': 'rw,noexec,nosuid,nodev,size=16m',
        },
        // Lets nginx (not root) listen on 80/443 (and 8080) inside its own network namespace; no capability needed.
        Sysctls: { 'net.ipv4.ip_unprivileged_port_start': '0' },
        NetworkMode: network.name,
        PortBindings: {},
        PublishAllPorts: false,
        Init: true,
        RestartPolicy: { Name: 'no' },
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '1' } },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [network.name]: { Aliases: [LAB_HOST, LAB_REDIRECT_HOST], IPAMConfig: { IPv4Address: labIp(network) } },
        },
      },
    },
  };
}

export interface LabIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** What to add in the Scope panel to point tools at the lab. Printed, never applied. */
export function scopeHint(network: NetworkSpec): string[] {
  return [
    'To run tools against the lab, add these scope rules (Scope panel, or POST /api/scope/rules):',
    `  include  domain  ${LAB_HOST}`,
    `  include  ip      ${labIp(network)}`,
    'Active tools also need passive-only turned off. The lab is reachable only from tool containers (no host ports).',
  ];
}

async function labContainers(runtime: ContainerRuntime) {
  return (await runtime.listByLabel(LABEL_LAB)).containers;
}

/** Builds the image if needed, then (re)creates the container. Idempotent: an up-to-date running lab is left alone. */
export async function labUp(runtime: ContainerRuntime, network: NetworkSpec, io: LabIo, dir: string = LAB_DIR): Promise<number> {
  const ping = await runtime.ping();
  if (!ping.ok) {
    io.err(`✗ ${ping.error}\n  Start Docker Desktop, then run this again.`);
    return 1;
  }
  const image = labImage(dir);
  try {
    await runtime.ensureNetwork(network);
    if (await runtime.inspectImage(image.ref)) {
      io.out(`✓ image ${image.ref} is up to date`);
    } else {
      io.out(`… building ${image.ref} (downloads the pinned nginx image the first time)`);
      await runtime.build({
        context: dir,
        files: [...LAB_FILES],
        dockerfile: 'Dockerfile',
        tag: image.ref,
        labels: { [LABEL_LAB]: 'image', [LABEL_CONTEXT]: image.hash },
        onLog: (line) => {
          io.out(`    ${line}`);
        },
      });
      io.out(`✓ built ${image.ref}`);
    }
    const existing = await labContainers(runtime);
    const current = existing.find((c) => c.state === 'running' && c.labels[LABEL_CONTEXT] === image.hash);
    if (current && existing.length === 1) {
      io.out(`✓ the lab is already up (${current.name})`);
    } else {
      for (const c of existing) {
        io.out(`… removing the old lab container ${c.name} (${c.state})`);
        await runtime.removeContainer(c.id);
      }
      const id = await runtime.createService(labSpec(image, network));
      await runtime.start(id);
      io.out(`✓ the lab is up: ${LAB_CONTAINER} on ${network.name} at ${labIp(network)}`);
    }
  } catch (e) {
    io.err(`✗ ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  io.out(`  http://${LAB_HOST}/   301 to https://${LAB_REDIRECT_HOST}/ (a redirect tools must not follow)`);
  io.out(`  https://${LAB_HOST}/  the page (self-signed certificate)`);
  io.out(`  http://${LAB_HOST}:8080/  a plain page (a port only a port scan finds)`);
  io.out('');
  for (const line of scopeHint(network)) io.out(line);
  return 0;
}

/** Removes the lab container. The image and the network stay (jobs use the network). */
export async function labDown(runtime: ContainerRuntime, io: LabIo): Promise<number> {
  const ping = await runtime.ping();
  if (!ping.ok) {
    io.err(`✗ ${ping.error}`);
    return 1;
  }
  const existing = await labContainers(runtime);
  if (existing.length === 0) {
    io.out('✓ the lab is not running');
    return 0;
  }
  for (const c of existing) {
    await runtime.removeContainer(c.id);
    io.out(`✓ removed ${c.name}`);
  }
  io.out('The scope rules you added for the lab are still there; remove them in the Scope panel if you like.');
  return 0;
}

export async function labStatus(runtime: ContainerRuntime, network: NetworkSpec, io: LabIo, dir: string = LAB_DIR): Promise<number> {
  const ping = await runtime.ping();
  if (!ping.ok) {
    io.err(`✗ ${ping.error}`);
    return 1;
  }
  const image = labImage(dir);
  const built = (await runtime.inspectImage(image.ref)) !== null;
  const existing = await labContainers(runtime);
  io.out(`network    ${network.name}  subnet ${network.subnet}  (dynamic ${network.ipRange})`);
  io.out(`image      ${image.ref}  ${built ? 'built' : 'not built (pnpm lab:up builds it)'}`);
  if (existing.length === 0) {
    io.out('container  none (pnpm lab:up)');
    return 0;
  }
  for (const c of existing) {
    const stale = c.labels[LABEL_CONTEXT] === image.hash ? '' : '  (older image: run pnpm lab:up)';
    io.out(`container  ${c.name}  ${c.state}${stale}`);
  }
  io.out(`address    ${labIp(network)}  as ${LAB_HOST}, ${LAB_REDIRECT_HOST}  (no host ports)`);
  io.out(`ports      ${LAB_PORTS.map((p) => `${p}/tcp`).join(', ')}  (tools network only)`);
  io.out('');
  for (const line of scopeHint(network)) io.out(line);
  return 0;
}
