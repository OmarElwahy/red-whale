// The tools network (docs/architecture.md §11): subnet rules, the existing-network check and the error texts. Pure.
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_TOOLS_SUBNET,
  LABEL_NETWORK,
  NetworkError,
  TOOLS_NETWORK,
  existingNetworkProblem,
  hostInSubnet,
  networkCreateError,
  parseSubnet,
  toolsNetwork,
} from '../src/runner/network';
import type { NetworkInfo } from '../src/runner/runtime';

describe('subnet', () => {
  test('default, and the REDWHALE_NET_SUBNET override (canonicalized)', () => {
    expect(toolsNetwork({})).toEqual({ name: TOOLS_NETWORK, subnet: '172.29.250.0/24', labels: { [LABEL_NETWORK]: 'tools' } });
    expect(toolsNetwork({ REDWHALE_NET_SUBNET: '' }).subnet).toBe(DEFAULT_TOOLS_SUBNET);
    expect(toolsNetwork({ REDWHALE_NET_SUBNET: ' 10.77.0.0/16 ' }).subnet).toBe('10.77.0.0/16');
  });

  test.each([
    ['nope', 'not an IPv4 CIDR'],
    ['172.29.250.0', 'not an IPv4 CIDR'],
    ['300.1.1.0/24', 'not an IPv4 CIDR'],
    ['01.2.3.0/24', 'not an IPv4 CIDR'],
    ['fd00::/64', 'not an IPv4 CIDR'],
    ['10.0.0.0/8', '/16 to /28'],
    ['10.0.0.0/30', '/16 to /28'],
    ['172.29.250.5/24', 'did you mean 172.29.250.0/24?'],
  ])('%s is refused (%s)', (value, why) => {
    expect(() => toolsNetwork({ REDWHALE_NET_SUBNET: value })).toThrow(NetworkError);
    expect(() => parseSubnet(value)).toThrow(why);
  });

  test('a host inside the subnet (the lab is .10)', () => {
    expect(hostInSubnet('172.29.250.0/24', 10)).toBe('172.29.250.10');
    expect(hostInSubnet('10.77.0.0/16', 10)).toBe('10.77.0.10');
    expect(hostInSubnet('192.168.5.16/28', 10)).toBe('192.168.5.26');
    expect(() => hostInSubnet('192.168.5.16/28', 15)).toThrow('outside');
  });
});

describe('an existing network', () => {
  const spec = toolsNetwork({});
  const good: NetworkInfo = { driver: 'bridge', internal: false, subnets: ['172.29.250.0/24'], labels: { [LABEL_NETWORK]: 'tools' } };

  test('ours, bridge, not internal, same subnet: used as is', () => {
    expect(existingNetworkProblem(spec, good)).toBeNull();
  });

  test.each([
    [{ labels: {} }, "RED WHALE didn't create it"],
    [{ driver: 'overlay' }, "'overlay' driver"],
    [{ internal: true }, 'internal'],
    [{ subnets: ['172.30.0.0/24'] }, 'has subnet 172.30.0.0/24, expected 172.29.250.0/24'],
  ])('%o is refused, with how to fix it', (patch, why) => {
    const problem = existingNetworkProblem(spec, { ...good, ...patch });
    expect(problem).toContain(why);
    expect(problem).toContain('docker network rm redwhale-tools');
  });
});

test('a subnet clash on create says to set REDWHALE_NET_SUBNET', () => {
  const spec = toolsNetwork({});
  expect(networkCreateError(spec, 'Pool overlaps with other one on this address space')).toMatch(
    /subnet 172\.29\.250\.0\/24 overlaps .* Set REDWHALE_NET_SUBNET/,
  );
  expect(networkCreateError(spec, 'boom')).toBe("can't create the Docker network 'redwhale-tools' (172.29.250.0/24): boom");
});
