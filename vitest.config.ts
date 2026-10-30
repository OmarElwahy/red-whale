import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// web/ imports its own modules as '@/…' (shadcn convention); mirror web/vite.config.ts.
const alias = { '@': fileURLToPath(new URL('./web/src', import.meta.url)) };

export default defineConfig({
  test: {
    projects: ['shared', 'server', 'web'].map((name) => ({
      ...(name === 'web' ? { resolve: { alias } } : {}),
      test: { name, root: `./${name}`, include: ['test/**/*.test.ts'] },
    })),
  },
});
