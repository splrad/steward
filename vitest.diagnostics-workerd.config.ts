process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';

import {
  exportJWK,
  generateKeyPair,
} from 'jose';
import {
  createDiagnosticsOutboundService,
  diagnosticsControlService,
  diagnosticsFixture,
} from './workerd-tests/diagnostics-fixture.js';

const { cloudflareTest } = await import(
  '@cloudflare/vitest-pool-workers'
);
const { defineConfig } = await import('vitest/config');

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const { publicKey, privateKey } = await generateKeyPair(
        'RS256',
        { extractable: true },
      );
      const publicJwk = await exportJWK(publicKey);
      const privateJwk = await exportJWK(privateKey);

      return {
        wrangler: {
          configPath: './tests/workerd/diagnostics.wrangler.jsonc',
        },
        miniflare: {
          bindings: {
            ACCESS_TEAM_DOMAIN: diagnosticsFixture.teamDomain,
            ACCESS_POLICY_AUD: diagnosticsFixture.audience,
            ACCESS_EXPECTED_CLIENT_ID: diagnosticsFixture.clientId,
            CLOUDFLARE_ACCOUNT_ID: diagnosticsFixture.accountId,
            CLOUDFLARE_WORKERS_READ_TOKEN:
              diagnosticsFixture.workersToken,
            CLOUDFLARE_QUEUES_READ_TOKEN:
              diagnosticsFixture.queuesToken,
            EVENT_QUEUE_ID: diagnosticsFixture.eventQueueId,
            DEAD_LETTER_QUEUE_ID:
              diagnosticsFixture.deadLetterQueueId,
            TEST_ACCESS_PRIVATE_JWK: JSON.stringify({
              ...privateJwk,
              kid: diagnosticsFixture.keyId,
              alg: 'RS256',
              use: 'sig',
            }),
          },
          serviceBindings: {
            CONTROL: diagnosticsControlService,
          },
          outboundService: createDiagnosticsOutboundService(publicJwk),
        },
      };
    }),
  ],
  test: {
    include: ['workerd-tests/diagnostics.workerd.ts'],
  },
});
