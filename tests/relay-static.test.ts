import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { GITHUB_CLOUD_REST_API_VERSION } from '../packages/github/src/index.js';

const source = await readFile(new URL('../packages/relay/src/index.ts', import.meta.url), 'utf8');
const githubTransport = await readFile(new URL('../packages/github/src/transport.ts', import.meta.url), 'utf8');
const releaseUpload = await readFile(new URL('../packages/github/src/release-upload.ts', import.meta.url), 'utf8');
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

  it('keeps legacy Relay deployment manual and explicitly credentialed', () => {
    expect(deployWorkflow).toContain('workflow_dispatch:');
    expect(deployWorkflow).not.toMatch(/^\s+push:/m);
    expect(deployWorkflow).not.toContain('paths:');
    expect(deployWorkflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(deployWorkflow).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
    expect(deployWorkflow).not.toContain('secrets: inherit');
  });

  it('does not log webhook bodies or credentials', () => {
    expect(source).not.toMatch(/\bconsole\s*\./);
    expect(source).not.toContain('GITHUB_WEBHOOK_SECRET=');
    expect(source).not.toContain('GITHUB_APP_PRIVATE_KEY=');
  });

  it('uses the same supported REST API version as the GitHub adapter', () => {
    expect(GITHUB_CLOUD_REST_API_VERSION).toBe('2026-03-10');
    expect(source).toContain("'x-github-api-version': GITHUB_CLOUD_REST_API_VERSION");
    expect(githubTransport).toContain("'x-github-api-version': restApiVersion");
    expect(releaseUpload).toContain("'x-github-api-version': resolveGitHubRestApiVersion(input.apiBaseUrl, input.apiVersion)");
    for (const implementation of [source, githubTransport, releaseUpload]) {
      expect(implementation).not.toContain("'x-github-api-version': '2022-11-28'");
    }
  });
});
