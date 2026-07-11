import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = await readFile(new URL('../packages/relay/src/index.ts', import.meta.url), 'utf8');
const wrangler = await readFile(new URL('../packages/relay/wrangler.toml', import.meta.url), 'utf8');
const deployWorkflow = await readFile(new URL('../.github/workflows/deploy-relay.yml', import.meta.url), 'utf8');

describe('relay static contract', () => {
  it('does not embed a consumer repository or plaintext target setting', () => {
    expect(source).not.toContain('TARGET_REPOSITORY');
    expect(source).not.toContain('CADFontAutoReplace');
    expect(wrangler).not.toContain('[vars]');
    expect(wrangler).not.toContain('TARGET_REPOSITORY');
  });

  it('uses the stable Worker and SQLite Durable Object identity', () => {
    expect(wrangler).toContain('name = "steward-relay"');
    expect(wrangler).toContain('main = "src/index.ts"');
    expect(wrangler).toContain('name = "DELIVERY_COORDINATOR"');
    expect(wrangler).toContain('class_name = "DeliveryCoordinator"');
    expect(wrangler).toContain('new_sqlite_classes = ["DeliveryCoordinator"]');
  });

  it('keeps deployment scoped to Relay inputs and explicit Cloudflare secrets', () => {
    for (const path of [
      '.github/workflows/deploy-relay.yml',
      'packages/relay/**',
      'packages/manifest/src/**',
      'schema/steward.schema.json',
      'package.json',
      'package-lock.json',
    ]) {
      expect(deployWorkflow).toContain(`- ${path}`);
    }
    expect(deployWorkflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(deployWorkflow).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
    expect(deployWorkflow).not.toContain('secrets: inherit');
  });

  it('does not log webhook bodies or credentials', () => {
    expect(source).not.toMatch(/\bconsole\s*\./);
    expect(source).not.toContain('GITHUB_WEBHOOK_SECRET=');
    expect(source).not.toContain('GITHUB_APP_PRIVATE_KEY=');
  });
});
