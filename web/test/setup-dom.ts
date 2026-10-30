// Setup for the jsdom project (vitest.config.ts): unmount rendered components after each test.
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
