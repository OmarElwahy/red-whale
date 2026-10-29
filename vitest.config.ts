import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['shared', 'server', 'web'].map((name) => ({
      test: { name, root: `./${name}`, include: ['test/**/*.test.ts'] },
    })),
  },
});
