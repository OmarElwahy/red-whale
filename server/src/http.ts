// Small HTTP helpers shared by the routes: typed errors and Zod-validated input.
import { formatIssues } from '@redwhale/shared';
import type { z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly issues?: string[],
  ) {
    super(message);
  }
}

export function notFound(what: string): HttpError {
  return new HttpError(404, `${what} not found`);
}

/** Parses request input; anything that doesn't match is a 400 with one line per issue. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, 'invalid request', formatIssues(result.error));
  return result.data;
}

/** A JSON object column. The database only ever holds objects here, but check rather than cast blindly. */
export function jsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected a JSON object');
  return value as Record<string, unknown>;
}
