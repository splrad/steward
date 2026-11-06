import { bindings, defineConfig } from 'cf/config';
import * as entrypoint from './src/index.mjs' with { type: 'cf-worker' };

export default defineConfig({
  accountId: '5efbba9a3813a37ac45e70cfa9f01cb5',
  worker: {
    name: 'splrad-settings-events',
    entrypoint,
    compatibilityDate: '2026-11-06',
    workersDev: true,
    previewUrls: false,
    env: {
      ENABLED: bindings.text('false'),
      WEBHOOK_SECRET: bindings.secret(),
      GOVERNANCE_APP_PRIVATE_KEY: bindings.secret(),
    },
    observability: {enabled: false},
  },
});
