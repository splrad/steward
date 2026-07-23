import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  AUTHENTICATED_RUNTIME_DIAGNOSTICS_ENDPOINT,
} from '../packages/cli/src/runtime-diagnostics.js';

const repositoryRoot = new URL('../', import.meta.url);

type JsonObject = Record<string, unknown>;

async function readJsonObject(path: string): Promise<JsonObject> {
  const value: unknown = JSON.parse(await readFile(new URL(path, repositoryRoot), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must contain one JSON object`);
  }
  return value as JsonObject;
}

async function sourceFiles(directory: URL): Promise<URL[]> {
  const files: URL[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (entry.name.endsWith('.ts')) files.push(child);
  }
  return files;
}

async function runtimeSurface(packageName: 'ingress' | 'coordinator' | 'diagnostics'): Promise<string> {
  const packageRoot = new URL(`packages/${packageName}/`, repositoryRoot);
  const files = [
    new URL('wrangler.jsonc', packageRoot),
    ...await sourceFiles(new URL('src/', packageRoot)),
  ];
  return (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
}

function expectNoPublicRoute(config: JsonObject): void {
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
  expect(config).not.toHaveProperty('route');
  expect(config).not.toHaveProperty('routes');
  expect(config).not.toHaveProperty('workers_dev_routes');
}

const ingress = await readJsonObject('packages/ingress/wrangler.jsonc');
const coordinator = await readJsonObject('packages/coordinator/wrangler.jsonc');
const control = await readJsonObject('packages/control-runtime/wrangler.jsonc');
const diagnostics = await readJsonObject('packages/diagnostics/wrangler.jsonc');
const relayWorkflowSource = await readFile(
  new URL('.github/workflows/deploy-relay.yml', repositoryRoot),
  'utf8',
);
const relayWorkflow = parse(relayWorkflowSource) as {
  on?: unknown;
};

describe('central runtime deployment topology', () => {
  it('keeps the webhook execution plane private', () => {
    for (const config of [ingress, coordinator, control]) expectNoPublicRoute(config);
  });

  it('exposes only the Access-protected diagnostics gateway on its fixed workers.dev origin', () => {
    expect(diagnostics.name).toBe('steward-diagnostics');
    expect(diagnostics.main).toBe('src/index.ts');
    expect(diagnostics.workers_dev).toBe(true);
    expect(diagnostics.preview_urls).toBe(false);
    expect(diagnostics.keep_vars).toBe(false);
    expect(diagnostics).not.toHaveProperty('route');
    expect(diagnostics).not.toHaveProperty('routes');
    expect(diagnostics).not.toHaveProperty('workers_dev_routes');
    const endpoint = new URL(AUTHENTICATED_RUNTIME_DIAGNOSTICS_ENDPOINT);
    expect(endpoint.protocol).toBe('https:');
    expect(endpoint.hostname).toBe(
      `${String(diagnostics.name)}.alearner-5ef.workers.dev`,
    );
    expect(endpoint.pathname).toBe('/v1/runtime-diagnostics');
    expect(endpoint.search).toBe('');
    expect(diagnostics.services).toEqual([
      {
        binding: 'CONTROL',
        service: 'steward-control',
      },
    ]);
    expect(diagnostics.vars).toEqual({
      CLOUDFLARE_ACCOUNT_ID: '5efbba9a3813a37ac45e70cfa9f01cb5',
      EVENT_QUEUE_ID: 'b957c244a4bf478887da90ad3fe10909',
      DEAD_LETTER_QUEUE_ID: '7fb7d65f37774837ae7a22f71f7dde4c',
    });
    expect(diagnostics.secrets).toEqual({
      required: [
        'ACCESS_TEAM_DOMAIN',
        'ACCESS_POLICY_AUD',
        'ACCESS_EXPECTED_CLIENT_ID',
        'CLOUDFLARE_WORKERS_READ_TOKEN',
        'CLOUDFLARE_QUEUES_READ_TOKEN',
      ],
    });
    for (const forbiddenBinding of [
      'queues',
      'durable_objects',
      'exports',
      'migrations',
      'kv_namespaces',
      'r2_buckets',
      'd1_databases',
      'hyperdrive',
      'vectorize',
      'dispatch_namespaces',
      'pipelines',
    ]) {
      expect(diagnostics).not.toHaveProperty(forbiddenBinding);
    }
  });

  it('gives Ingress only the webhook secret and event Queue producer', () => {
    expect(ingress.name).toBe('steward-ingress');
    expect(ingress.main).toBe('src/index.ts');
    expect(ingress.secrets).toEqual({
      required: ['GITHUB_WEBHOOK_SECRET'],
    });
    expect(ingress.queues).toEqual({
      producers: [
        {
          binding: 'EVENT_QUEUE',
          queue: 'steward-events',
        },
      ],
    });
    for (const forbiddenBinding of [
      'vars',
      'services',
      'durable_objects',
      'exports',
      'migrations',
      'kv_namespaces',
      'r2_buckets',
      'd1_databases',
      'hyperdrive',
      'vectorize',
      'dispatch_namespaces',
      'pipelines',
    ]) {
      expect(ingress).not.toHaveProperty(forbiddenBinding);
    }
  });

  it('binds Coordinator to one SQLite Durable Object, private Control, and a bounded retry Queue', () => {
    expect(coordinator.name).toBe('steward-coordinator');
    expect(coordinator.main).toBe('src/entrypoint.ts');
    expect(coordinator.keep_vars).toBe(false);
    expect(coordinator.durable_objects).toEqual({
      bindings: [
        {
          name: 'PR_COORDINATOR',
          class_name: 'PullRequestCoordinator',
        },
      ],
    });
    expect(coordinator.exports).toEqual({
      PullRequestCoordinator: {
        type: 'durable-object',
        storage: 'sqlite',
      },
    });
    expect(coordinator.services).toEqual([
      {
        binding: 'CONTROL',
        service: 'steward-control',
      },
    ]);
    expect(coordinator.queues).toEqual({
      producers: [
        {
          binding: 'EVENT_QUEUE',
          queue: 'steward-events',
        },
      ],
      consumers: [
        {
          queue: 'steward-events',
          max_batch_size: 10,
          max_batch_timeout: 1,
          max_retries: 3,
          retry_delay: 5,
          dead_letter_queue: 'steward-events-dlq',
        },
      ],
    });
  });

  it('keeps gradual deployment metadata on Control and Durable Object exports off it', () => {
    expect(control.name).toBe('steward-control');
    expect(control.main).toBe('src/index.ts');
    expect(control.keep_vars).toBe(false);
    expect(control.version_metadata).toEqual({
      binding: 'CF_VERSION_METADATA',
    });
    expect(control.vars).toEqual({
      STEWARD_ORGANIZATION_ID: 302208797,
      STEWARD_ORGANIZATION_LOGIN: 'splrad',
    });
    expect(control.secrets).toEqual({
      required: [
        'GITHUB_APP_ID',
        'GITHUB_APP_PRIVATE_KEY',
      ],
    });
    expect(control).not.toHaveProperty('durable_objects');
    expect(control).not.toHaveProperty('exports');
    expect(control).not.toHaveProperty('migrations');
  });
});

describe('central runtime credential boundary', () => {
  it('keeps App, human, and deployment credentials out of Ingress and Coordinator', async () => {
    const forbiddenCredentialPatterns = [
      /\b[A-Z0-9_]*APP_(?:ID|CLIENT_ID|PRIVATE_KEY|INSTALLATION_ID)\b/,
      /\b(?:GH|GITHUB|COPILOT_REVIEW_REQUEST|CORE_AUTO_APPROVAL|STEWARD_APP_USER|STEWARD_ORGANIZATION_[A-Z0-9_]+|CLOUDFLARE_API)_TOKEN\b/,
      /\bCLOUDFLARE_ACCOUNT_ID\b/,
    ];

    for (const packageName of ['ingress', 'coordinator'] as const) {
      const surface = await runtimeSurface(packageName);
      for (const pattern of forbiddenCredentialPatterns) {
        expect(surface.match(pattern), `${packageName} must not bind ${pattern}`).toBeNull();
      }
    }
  });

  it('gives Diagnostics only independent Cloudflare read credentials and no GitHub authority', async () => {
    const surface = await runtimeSurface('diagnostics');
    for (const forbiddenPattern of [
      /\b[A-Z0-9_]*APP_(?:ID|CLIENT_ID|PRIVATE_KEY|INSTALLATION_ID)\b/,
      /\b(?:GH|GITHUB|COPILOT_REVIEW_REQUEST|CORE_AUTO_APPROVAL|STEWARD_APP_USER|STEWARD_ORGANIZATION_[A-Z0-9_]+)_TOKEN\b/,
      /\bCLOUDFLARE_API_TOKEN\b/,
      /\bGITHUB_WEBHOOK_SECRET\b/,
      /\bcloudflare-workers-version-overrides\b/,
    ]) {
      expect(surface.match(forbiddenPattern), `diagnostics must not bind ${forbiddenPattern}`).toBeNull();
    }
    expect(surface).toContain('CLOUDFLARE_WORKERS_READ_TOKEN');
    expect(surface).toContain('CLOUDFLARE_QUEUES_READ_TOKEN');
  });
});

describe('legacy Relay isolation', () => {
  it('deploys only by an explicit operator dispatch, never a lockfile change', () => {
    expect(relayWorkflow.on).toEqual({ workflow_dispatch: null });
    expect(relayWorkflowSource).not.toContain('package-lock.json');
    expect(relayWorkflowSource).not.toMatch(/^\s{2}(?:push|pull_request|workflow_run|repository_dispatch):/m);
  });
});
