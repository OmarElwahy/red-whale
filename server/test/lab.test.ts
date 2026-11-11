// The local lab (docs/architecture.md §11, lab/README.md): its container spec (pure) and lab:up/down/status through
// the fake runtime. The real container is exercised by the httpx end-to-end test (needs Docker).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { LABEL_CONTEXT } from '../src/runner/catalog';
import {
  LABEL_LAB,
  LAB_CONTAINER,
  LAB_DIR,
  LAB_FILES,
  LAB_PORTS,
  LAB_HOST,
  LAB_REDIRECT_HOST,
  labDown,
  labImage,
  labIp,
  labSpec,
  labStatus,
  labUp,
  type LabIo,
} from '../src/runner/lab';
import { toolsNetwork } from '../src/runner/network';
import { FakeRuntime } from './fakeRuntime';

const network = toolsNetwork({});

function io(): LabIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

describe('lab container spec', () => {
  const image = labImage();
  const spec = labSpec(image, network);
  const h = spec.body.HostConfig;

  test('on the tools network as lab.redwhale.test and elsewhere.redwhale.test, at the fixed .10', () => {
    expect(labIp(network)).toBe('172.29.250.10');
    expect(h.NetworkMode).toBe('redwhale-tools');
    expect(spec.body.NetworkingConfig.EndpointsConfig).toEqual({
      'redwhale-tools': { Aliases: [LAB_HOST, LAB_REDIRECT_HOST], IPAMConfig: { IPv4Address: '172.29.250.10' } },
    });
    expect(labIp(toolsNetwork({ REDWHALE_NET_SUBNET: '10.77.0.0/16' }))).toBe('10.77.0.10');
  });

  test('the fixed address is outside the range Docker gives job containers', () => {
    expect(network.ipRange).toBe('172.29.250.128/25');
  });

  test('publishes no host ports', () => {
    expect(h.PortBindings).toEqual({});
    expect(h.PublishAllPorts).toBe(false);
    expect(JSON.stringify(spec)).not.toMatch(/HostPort|HostIp/);
  });

  test('hardened: not root, read-only root, no capabilities, small limits, no mounts', () => {
    expect(spec.body.User).toBe('101:101');
    expect(h.ReadonlyRootfs).toBe(true);
    expect(h.CapDrop).toEqual(['ALL']);
    expect(h.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(h.Privileged).toBe(false);
    expect(h.Memory).toBe(128 * 1024 * 1024);
    expect(h.MemorySwap).toBe(h.Memory);
    expect(h.Sysctls).toEqual({ 'net.ipv4.ip_unprivileged_port_start': '0' });
    expect(Object.keys(h.Tmpfs).sort()).toEqual(['/tmp', '/var/cache/nginx']);
    expect(JSON.stringify(spec)).not.toMatch(/Binds|docker\.sock|CapAdd/);
  });

  test('labelled redwhale.lab, with the image build it runs', () => {
    expect(spec.name).toBe(LAB_CONTAINER);
    expect(spec.body.Labels).toEqual({ [LABEL_LAB]: 'lab', [LABEL_CONTEXT]: image.hash });
    expect(image.ref).toMatch(/^redwhale-lab:[0-9a-f]{12}$/);
  });
});

describe('lab:up / lab:down / lab:status', () => {
  test('up: network, build, container started; prints the scope rules and adds none', async () => {
    const rt = new FakeRuntime();
    const out = io();
    expect(await labUp(rt, network, out)).toBe(0);
    expect(rt.networks.get('redwhale-tools')).toEqual(network);
    expect(rt.builds).toHaveLength(1);
    expect(rt.builds[0]).toMatchObject({ tag: labImage().ref, dockerfile: 'Dockerfile', files: [...LAB_FILES] });
    expect(rt.services).toHaveLength(1);
    expect([...rt.containers.values()].map((c) => c.state)).toEqual(['running']);
    expect(out.lines).toContain('  include  domain  lab.redwhale.test');
    expect(out.lines).toContain('  include  ip      172.29.250.10');
    expect(out.errors).toEqual([]);
  });

  test('up again: nothing rebuilt or recreated', async () => {
    const rt = new FakeRuntime();
    await labUp(rt, network, io());
    const out = io();
    expect(await labUp(rt, network, out)).toBe(0);
    expect(rt.builds).toHaveLength(1);
    expect(rt.services).toHaveLength(1);
    expect(out.lines).toContain('✓ the lab is already up (redwhale-lab)');
  });

  test('up with a stopped (or older) lab container replaces it', async () => {
    const rt = new FakeRuntime();
    await labUp(rt, network, io());
    const [first] = rt.containers.values();
    first?.exit(0);
    expect(await labUp(rt, network, io())).toBe(0);
    expect(rt.services).toHaveLength(2);
    expect([...rt.containers.values()].map((c) => c.state)).toEqual(['running']);
  });

  test('up reports a network clash or a failed build, and fails', async () => {
    const rt = new FakeRuntime();
    rt.networkError = 'subnet 172.29.250.0/24 overlaps another Docker network';
    const out = io();
    expect(await labUp(rt, network, out)).toBe(1);
    expect(out.errors).toEqual(['✗ subnet 172.29.250.0/24 overlaps another Docker network']);
    expect(rt.services).toEqual([]);

    const rt2 = new FakeRuntime();
    rt2.buildError = 'pull access denied';
    const out2 = io();
    expect(await labUp(rt2, network, out2)).toBe(1);
    expect(out2.errors).toEqual(['✗ pull access denied']);
  });

  test('up without Docker says to start it', async () => {
    const rt = new FakeRuntime();
    rt.reachable = false;
    const out = io();
    expect(await labUp(rt, network, out)).toBe(1);
    expect(out.errors[0]).toMatch(/Start Docker Desktop/);
  });

  test('down removes the container, keeps the image and the network', async () => {
    const rt = new FakeRuntime();
    await labUp(rt, network, io());
    const out = io();
    expect(await labDown(rt, out)).toBe(0);
    expect(rt.containers.size).toBe(0);
    expect(rt.images.has(labImage().ref)).toBe(true);
    expect(rt.networks.has('redwhale-tools')).toBe(true);
    expect(await labDown(rt, io())).toBe(0);
  });

  test('status: image, container, address', async () => {
    const rt = new FakeRuntime();
    const before = io();
    await labStatus(rt, network, before);
    expect(before.lines).toContain('container  none (pnpm lab:up)');
    await labUp(rt, network, io());
    const after = io();
    expect(await labStatus(rt, network, after)).toBe(0);
    expect(after.lines).toContain(`image      ${labImage().ref}  built`);
    expect(after.lines).toContain('container  redwhale-lab  running');
    expect(after.lines).toContain('address    172.29.250.10  as lab.redwhale.test, elsewhere.redwhale.test  (no host ports)');
    expect(after.lines).toContain('ports      80/tcp, 443/tcp, 8080/tcp  (tools network only)');
  });

  test('nginx listens on exactly the ports the lab reports', () => {
    const conf = readFileSync(join(LAB_DIR, 'nginx.conf'), 'utf8');
    const listens = [...conf.matchAll(/^\s*listen\s+(\d+)/gm)].map((m) => Number(m[1]));
    expect(listens).toEqual([...LAB_PORTS]);
  });
});
