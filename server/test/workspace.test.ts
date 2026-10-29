import { expect, test } from 'vitest';
import { CONTRACT_VERSION } from '../src/index';

test('resolves @redwhale/shared through the workspace', () => {
  expect(CONTRACT_VERSION).toBe(1);
});
