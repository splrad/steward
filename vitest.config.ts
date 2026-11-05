import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    ...(process.platform === 'win32' ? { maxWorkers: 2 } : {}),
    reporters: process.platform === 'win32' ? ['verbose'] : ['default'],
    setupFiles: ['packages/runner/test/offline-setup.ts'],
    coverage: { enabled: false },
  },
});
