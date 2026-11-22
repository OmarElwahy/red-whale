// tools/lib/psl.py (the tools' Public Suffix List, bundled in tools/dns/data/) and the server's tldts must answer the
// same for every vector in tools/lib/fixtures/psl_vectors.json (test_psl.py checks psl.py against the same file).
// A failure after `pnpm tools:refresh-data` or a tldts bump says which side's list changed for which name.
import { join } from 'node:path';
import { getDomain, parse } from 'tldts';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { REPO_ROOT, readJson } from './fixtures';

const vectorsSchema = z.object({
  vectors: z
    .array(
      z.strictObject({
        name: z.string(),
        registrable: z.string().nullable(),
        private_suffix: z.string().nullable(),
        why: z.string(),
      }),
    )
    .min(20),
});

const { vectors } = vectorsSchema.parse(readJson(join(REPO_ROOT, 'tools/lib/fixtures/psl_vectors.json')));

/** What tldts says, in the vectors' terms. */
function tldts(name: string): { registrable: string | null; private_suffix: string | null } {
  const withPrivate = parse(name, { allowPrivateDomains: true });
  return {
    registrable: getDomain(name, { allowPrivateDomains: false }),
    // strictly below a PRIVATE rule: the prevailing rule is private and there is a label left over (a domain)
    private_suffix: withPrivate.isPrivate === true && withPrivate.domain !== null ? withPrivate.publicSuffix : null,
  };
}

describe('Public Suffix List parity: tldts = psl.py', () => {
  test.each(vectors)('$name ($why)', ({ name, registrable, private_suffix }) => {
    expect(tldts(name)).toEqual({ registrable, private_suffix });
  });
});
