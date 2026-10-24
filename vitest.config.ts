import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['packages/runner/test/offline-setup.ts'],
    coverage: { enabled: false },
  },
});
