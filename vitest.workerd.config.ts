process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';

const { cloudflareTest } = await import(
  '@cloudflare/vitest-pool-workers'
);
const { defineConfig } = await import('vitest/config');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './tests/workerd/coordinator.wrangler.jsonc',
      },
    }),
  ],
  test: {
    include: ['workerd-tests/coordinator.workerd.ts'],
  },
});
