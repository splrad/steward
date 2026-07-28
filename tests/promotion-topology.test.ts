import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../', import.meta.url);
const config = JSON.parse(await readFile(
  new URL('packages/promotion/wrangler.jsonc', repositoryRoot),
  'utf8',
)) as Record<string, unknown>;
const readme = await readFile(
  new URL('packages/promotion/README.md', repositoryRoot),
  'utf8',
);

describe('protected runtime promotion topology', () => {
  it('isolates one Access-protected promotion entry and SQLite ledger', () => {
    expect(config).toMatchObject({
      name: 'steward-promotion',
      main: 'src/entrypoint.ts',
      workers_dev: true,
      preview_urls: false,
      keep_vars: false,
      durable_objects: {
        bindings: [{
          name: 'RUNTIME_PROMOTION_LEDGER',
          class_name: 'RuntimePromotionLedger',
        }],
      },
      exports: {
        RuntimePromotionLedger: {
          type: 'durable-object',
          storage: 'sqlite',
        },
      },
      vars: {
        CLOUDFLARE_ACCOUNT_ID: '5efbba9a3813a37ac45e70cfa9f01cb5',
      },
      secrets: {
        required: [
          'ACCESS_TEAM_DOMAIN',
          'ACCESS_POLICY_AUD',
          'ACCESS_EXPECTED_CLIENT_ID',
          'CLOUDFLARE_WORKERS_WRITE_TOKEN',
        ],
      },
    });
    expect(config).not.toHaveProperty('route');
    expect(config).not.toHaveProperty('routes');
    expect(config).not.toHaveProperty('services');
    expect(config).not.toHaveProperty('queues');
    expect(config).not.toHaveProperty('kv_namespaces');
    expect(config).not.toHaveProperty('d1_databases');
    expect(config).not.toHaveProperty('r2_buckets');
    expect(JSON.stringify(config.vars)).not.toContain('TOKEN');
  });

  it('manages only existing allowlisted versions and cannot promote itself', () => {
    for (const worker of [
      'steward-control',
      'steward-recovery',
      'steward-coordinator',
      'steward-diagnostics',
      'steward-ingress',
    ]) {
      expect(readme).toContain(worker);
    }
    expect(readme).toContain('`steward-promotion` is deliberately absent');
    expect(readme).toContain('requires a reviewed full SQLite Durable Object deployment');
    expect(readme).toContain('only manages versions that already exist');
    expect(readme).toContain('never sends `force`');
    expect(readme).toContain('POST /v1/runtime-promotion/resolve-unknown');
    expect(readme).toContain('never abandoned automatically');
    expect(readme).toContain('no compare-and-swap field');
    expect(readme).toContain('live-canary both stable-100');
  });
});
