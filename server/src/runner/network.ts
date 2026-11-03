// The tools network (docs/architecture.md §11): every job container joins one user-defined bridge network, so a
// local lab (`pnpm lab:up`) can be reached by name. Not internal: the tools still need the internet.
// Pure: the spec, the subnet rules and the error texts. docker.ts applies them (it is the only file that talks to
// Docker), so everything here is unit-tested without Docker.
import type { NetworkInfo, NetworkSpec } from './runtime';

export const TOOLS_NETWORK = 'redwhale-tools';
export const LABEL_NETWORK = 'redwhale.network';
export const DEFAULT_TOOLS_SUBNET = '172.29.250.0/24';
/** The env var that overrides the subnet (e.g. on a clash with another Docker or VPN network). */
export const SUBNET_ENV = 'REDWHALE_NET_SUBNET';

export class NetworkError extends Error {
  override name = 'NetworkError';
}

interface Subnet {
  text: string;
  /** The network address as a 32-bit number. */
  base: number;
  prefix: number;
}

const ipToInt = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
};

const intToIp = (n: number): string => [24, 16, 8, 0].map((s) => String(Math.floor(n / 2 ** s) % 256)).join('.');

/**
 * An IPv4 CIDR from /16 to /28 (room for the lab's fixed address), host bits zero. Throws NetworkError saying why.
 */
export function parseSubnet(text: string): Subnet {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(text.trim());
  const base = m ? ipToInt(m[1] ?? '') : null;
  const prefix = m ? Number(m[2]) : NaN;
  if (!m || base === null) throw new NetworkError(`${SUBNET_ENV}='${text}' is not an IPv4 CIDR like ${DEFAULT_TOOLS_SUBNET}`);
  if (prefix < 16 || prefix > 28) throw new NetworkError(`${SUBNET_ENV}='${text}': the prefix must be /16 to /28`);
  const size = 2 ** (32 - prefix);
  if (base % size !== 0) {
    throw new NetworkError(`${SUBNET_ENV}='${text}' has host bits set; did you mean ${intToIp(base - (base % size))}/${String(prefix)}?`);
  }
  return { text: `${intToIp(base)}/${String(prefix)}`, base, prefix };
}

/** The address `offset` hosts into the subnet (the lab is .10 of a /24). */
export function hostInSubnet(subnet: string, offset: number): string {
  const s = parseSubnet(subnet);
  if (offset < 1 || offset >= 2 ** (32 - s.prefix) - 1) throw new NetworkError(`host ${String(offset)} is outside ${s.text}`);
  return intToIp(s.base + offset);
}

/** The tools network, with the subnet from REDWHALE_NET_SUBNET or the default. Throws NetworkError on a bad value. */
export function toolsNetwork(env: Record<string, string | undefined> = process.env): NetworkSpec {
  const raw = env[SUBNET_ENV]?.trim();
  return {
    name: TOOLS_NETWORK,
    subnet: parseSubnet(raw === undefined || raw === '' ? DEFAULT_TOOLS_SUBNET : raw).text,
    labels: { [LABEL_NETWORK]: 'tools' },
  };
}

const removeHint = (name: string) =>
  `remove it with "docker network rm ${name}" (stop the lab first: pnpm lab:down) and run again, or set ${SUBNET_ENV}`;

/** Why an existing network of that name can't be used as is; null if it can. */
export function existingNetworkProblem(spec: NetworkSpec, found: NetworkInfo): string | null {
  const ours = Object.entries(spec.labels).every(([k, v]) => found.labels[k] === v);
  if (!ours) return `a Docker network named '${spec.name}' exists but RED WHALE didn't create it; ${removeHint(spec.name)}`;
  if (found.driver !== 'bridge') return `the Docker network '${spec.name}' uses the '${found.driver}' driver, not bridge; ${removeHint(spec.name)}`;
  if (found.internal) return `the Docker network '${spec.name}' is internal (no internet for the tools); ${removeHint(spec.name)}`;
  if (!found.subnets.includes(spec.subnet)) {
    return (
      `the Docker network '${spec.name}' has subnet ${found.subnets.join(', ') || '(none)'}, expected ${spec.subnet}; ` +
      removeHint(spec.name)
    );
  }
  return null;
}

/** Docker's error when creating the network, as something the analyst can act on. */
export function networkCreateError(spec: NetworkSpec, dockerMessage: string): string {
  if (/overlap/i.test(dockerMessage)) {
    return (
      `can't create the Docker network '${spec.name}': subnet ${spec.subnet} overlaps another Docker network or a VPN route. ` +
      `Set ${SUBNET_ENV} to a free range (e.g. 172.30.250.0/24) and restart the server.`
    );
  }
  return `can't create the Docker network '${spec.name}' (${spec.subnet}): ${dockerMessage}`;
}
