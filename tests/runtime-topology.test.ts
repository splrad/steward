import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

async function runtimeSurface(packageName: 'ingress' | 'coordinator'): Promise<string> {
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
const relayWorkflowSource = await readFile(
  new URL('.github/workflows/deploy-relay.yml', repositoryRoot),
  'utf8',
);
const relayWorkflow = parse(relayWorkflowSource) as {
  on?: unknown;
};

describe('central runtime deployment topology', () => {
  it('keeps all three Workers private until an explicit route activation', () => {
    for (const config of [ingress, coordinator, control]) expectNoPublicRoute(config);
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
    expect(control.version_metadata).toEqual({
      binding: 'CF_VERSION_METADATA',
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
});

describe('legacy Relay isolation', () => {
  it('deploys only by an explicit operator dispatch, never a lockfile change', () => {
    expect(relayWorkflow.on).toEqual({ workflow_dispatch: null });
    expect(relayWorkflowSource).not.toContain('package-lock.json');
    expect(relayWorkflowSource).not.toMatch(/^\s{2}(?:push|pull_request|workflow_run|repository_dispatch):/m);
  });
});
