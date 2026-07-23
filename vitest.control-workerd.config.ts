process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';

import { controlRuntimeVersionMetadata } from './workerd-tests/control-runtime-fixture.js';

const { cloudflareTest } = await import(
  '@cloudflare/vitest-pool-workers'
);
const { defineConfig } = await import('vitest/config');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './tests/workerd/control-runtime.wrangler.jsonc',
      },
      miniflare: {
        // Miniflare's local versionMetadata plugin generates an empty tag and
        // does not accept fixture values. Supply the production binding's
        // exact JSON shape so the strict steward-<commit> contract is testable.
        bindings: {
          CF_VERSION_METADATA: controlRuntimeVersionMetadata,
        },
      },
    }),
  ],
  test: {
    include: ['workerd-tests/control-runtime.workerd.ts'],
  },
});
