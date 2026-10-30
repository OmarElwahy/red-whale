// Where the API listens: 127.0.0.1 only (CLAUDE.md rule 8). Only the port can change (REDWHALE_PORT).
import { DEFAULT_PORT } from './app';

export const HOST = '127.0.0.1';

export function listenOptions(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const raw = env.REDWHALE_PORT;
  const port = raw === undefined ? DEFAULT_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`REDWHALE_PORT '${raw ?? ''}' is not a port`);
  return { host: HOST, port };
}
