import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { replaceStewardSha, workflowTemplates } from '../packages/cli/src/init.js';
import { main, parseArguments } from '../packages/cli/src/main.js';
import {
  executeUpgrade,
  prepareUpgrade,
  type UpgradePlan,
} from '../packages/cli/src/upgrade.js';
import { GitHubApiError, type GitHubRequest, type GitHubTransport } from '../packages/github/src/index.js';
import { normalizeManifest, type ClassificationConfiguration, type StewardManifest } from '../packages/manifest/src/index.js';

const baseSha = 'a'.repeat(40);
const baseTreeSha = 'b'.repeat(40);
const treeSha = 'c'.repeat(40);
const currentSha = 'd'.repeat(40);
const targetSha = 'e'.repeat(40);
const branchSha = 'f'.repeat(40);
const templateDirectory = fileURLToPath(new URL('../templates/', import.meta.url));
const schemaContent = await readFile(new URL('../schema/steward.schema.json', import.meta.url), 'utf8');
const classification = JSON.parse(await readFile(
  new URL('./fixtures/cadfontautoreplace/classification.json', import.meta.url),
  'utf8',
)) as ClassificationConfiguration;

function manifest(sha = currentSha): StewardManifest {
  return normalizeManifest({
    $schema: `https://raw.githubusercontent.com/splrad/steward/${sha}/schema/steward.schema.json`,
    schemaVersion: 1,
    automation: {
      githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
      maintainers: { source: 'organization-team', teamSlug: 'maintainers' },
      language: 'zh-CN',
    },
    features: {
      prAutomation: false,
      classification: true,
      dcoAdvisory: false,
      governance: true,
      copilotReview: true,
      release: true,
      webhookRelay: false,
    },
    classification,
    release: {
      triggerPaths: ['src/**'],
      runner: 'ubuntu-latest',
      adapterCommand: ['node', './release-adapter.mjs'],
    },
  });
}

class UpgradeState {
  readonly requests: GitHubRequest[] = [];
  readonly defaultFiles = new Map<string, string>();
  readonly branchFiles = new Map<string, string>();
  readonly sourceFiles = new Map<string, string>();
  branchSha: string | undefined;
  pullRequest: { number: number; html_url: string } | undefined;
  corruptBranch = false;
  comparisonStatus = 'ahead';

  readonly transport: GitHubTransport = {
    request: async <T>(request: GitHubRequest): Promise<T> => {
      this.requests.push(structuredClone(request));
      return this.handle(request) as T;
    },
  };

  static async create(): Promise<UpgradeState> {
    const state = new UpgradeState();
    const currentManifest = manifest();
    state.defaultFiles.set('.github/steward.json', `${JSON.stringify(currentManifest, null, 2)}\n`);
    state.defaultFiles.set('.github/dependabot.yml', await readFile(`${templateDirectory}/init/dependabot.yml`, 'utf8'));
    state.defaultFiles.set('release-adapter.mjs', 'export const projectRelease = true;\n');
    for (const workflow of workflowTemplates(currentManifest)) {
      const content = await readFile(`${templateDirectory}/${workflow.template}`, 'utf8');
      state.defaultFiles.set(workflow.destination, replaceStewardSha(content, currentSha, workflow.template));
      state.sourceFiles.set(`${currentSha}:templates/${workflow.template}`, content);
      state.sourceFiles.set(`${targetSha}:templates/${workflow.template}`, content);
    }
    const dependabot = state.defaultFiles.get('.github/dependabot.yml')!;
    state.sourceFiles.set(`${currentSha}:templates/init/dependabot.yml`, dependabot);
    state.sourceFiles.set(`${targetSha}:templates/init/dependabot.yml`, dependabot);
    state.sourceFiles.set(`${targetSha}:schema/steward.schema.json`, schemaContent);
    return state;
  }

  mutations(): GitHubRequest[] {
    return this.requests.filter((request) => request.method && request.method !== 'GET');
  }

  private notFound(path: string): never {
    throw new GitHubApiError({ status: 404, method: 'GET', path, message: 'Not Found' });
  }

  private contentPath(path: string): string {
    return path.split('/contents/')[1]!.split('/').map(decodeURIComponent).join('/');
  }

  private filePayload(content: string): object {
    return { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64') };
  }

  private handle(request: GitHubRequest): unknown {
    const path = request.path;
    if (path === '/repos/splrad/example') return {
      id: 7,
      full_name: 'splrad/example',
      default_branch: 'main',
      archived: false,
      disabled: false,
      permissions: { admin: true },
    };
    if (path === '/repos/splrad/example/git/ref/heads/main') {
      return { object: { type: 'commit', sha: baseSha } };
    }
    if (path === `/repos/splrad/example/git/commits/${baseSha}`) {
      return { sha: baseSha, tree: { sha: baseTreeSha } };
    }
    if (path === `/repos/splrad/steward/commits/${targetSha}`) return { sha: targetSha };
    if (path === `/repos/splrad/steward/compare/${currentSha}...${targetSha}`) {
      return { status: this.comparisonStatus };
    }
    if (path.startsWith('/repos/splrad/steward/contents/')) {
      const file = this.contentPath(path);
      const ref = String(request.query?.ref ?? '');
      const content = this.sourceFiles.get(`${ref}:${file}`);
      return content === undefined ? this.notFound(path) : this.filePayload(content);
    }
    if (path.startsWith('/repos/splrad/example/contents/')) {
      const file = this.contentPath(path);
      const ref = String(request.query?.ref ?? '');
      const content = ref === branchSha
        ? this.branchFiles.get(file) ?? this.defaultFiles.get(file)
        : this.defaultFiles.get(file);
      return content === undefined ? this.notFound(path) : this.filePayload(content);
    }
    if (path === '/repos/splrad/example/git/ref/heads/steward%2Fupgrade') {
      if (!this.branchSha) return this.notFound(path);
      return { object: { type: 'commit', sha: this.branchSha } };
    }
    if (path === `/repos/splrad/example/commits/${branchSha}`) {
      const files = this.corruptBranch
        ? [{ filename: 'unrelated.txt', status: 'added' }]
        : [...this.branchFiles].map(([filename]) => ({
          filename,
          status: this.defaultFiles.has(filename) ? 'modified' : 'added',
        }));
      return { sha: branchSha, parents: [{ sha: baseSha }], files };
    }
    if (path === '/repos/splrad/example/pulls' && !request.method) {
      return this.pullRequest ? [{
        ...this.pullRequest,
        base: { ref: 'main' },
        head: { ref: 'steward/upgrade', sha: branchSha },
      }] : [];
    }
    if (path === '/repos/splrad/example/git/trees' && request.method === 'POST') {
      const body = request.body as { tree?: Array<{ path: string; content: string }> };
      for (const entry of body.tree ?? []) this.branchFiles.set(entry.path, entry.content);
      return { sha: treeSha };
    }
    if (path === '/repos/splrad/example/git/commits' && request.method === 'POST') return { sha: branchSha };
    if (path === '/repos/splrad/example/git/refs' && request.method === 'POST') {
      this.branchSha = branchSha;
      return { object: { type: 'commit', sha: branchSha } };
    }
    if (path === '/repos/splrad/example/pulls' && request.method === 'POST') {
      this.pullRequest = { number: 12, html_url: 'https://github.com/splrad/example/pull/12' };
      return this.pullRequest;
    }
    throw new Error(`Unexpected request: ${request.method ?? 'GET'} ${path}`);
  }
}

async function readyPlan(state: UpgradeState): Promise<UpgradePlan> {
  const prepared = await prepareUpgrade({
    transport: state.transport,
    owner: 'splrad',
    repository: 'example',
    targetSha,
  });
  if (prepared.status !== 'ready') throw new Error('Expected a ready upgrade plan');
  return prepared.plan;
}

describe('upgrade command', () => {
  it('requires a repository and complete target SHA', () => {
    expect(parseArguments(['upgrade', '--repo', 'splrad/example', '--to', targetSha]))
      .toEqual({ command: 'upgrade', repository: 'splrad/example', targetSha });
    expect(() => parseArguments(['upgrade', '--repo', 'splrad/example', '--to', 'main']))
      .toThrow('complete 40-character');
    expect(() => parseArguments(['upgrade', '--repo', 'splrad/example', '--to', targetSha, '--json']))
      .toThrow('Unknown argument');
  });

  it('prepares a read-only exact plan and preserves the project adapter', async () => {
    const state = await UpgradeState.create();
    const plan = await readyPlan(state);
    expect(plan).toMatchObject({
      currentSchemaSha: currentSha,
      currentPins: [currentSha],
      targetSha,
      sourceSchemaVersion: 1,
      targetSchemaVersion: 1,
      branchStatus: 'create',
      pullRequestStatus: 'create',
      counts: { create: 0, update: 6, unchanged: 1 },
      preservedAdapter: {
        path: 'release-adapter.mjs',
      },
    });
    expect(plan.preservedAdapter?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.files.map((file) => file.path)).not.toContain('release-adapter.mjs');
    expect(plan.files.find((file) => file.path === '.github/steward.json')?.content)
      .toContain(`/splrad/steward/${targetSha}/schema/steward.schema.json`);
    expect(plan.files.find((file) => file.path === '.github/steward.json')?.content)
      .toContain('"./release-adapter.mjs"');
    expect(plan.files.filter((file) => file.path.endsWith('.yml') && file.path.includes('/workflows/'))
      .every((file) => file.content.includes(`@${targetSha}`))).toBe(true);
    expect(state.mutations()).toEqual([]);
    expect(state.requests.filter((request) => request.path.startsWith('/repos/splrad/example/contents/'))
      .every((request) => request.query?.ref === baseSha)).toBe(true);
  });

  it('cancels without mutation and detects adapter drift after confirmation', async () => {
    const cancelled = await UpgradeState.create();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = await main(
      ['upgrade', '--repo', 'splrad/example', '--to', targetSha],
      { GH_TOKEN: 'token' },
      { templateDirectory, transport: cancelled.transport, confirmation: { confirm: async () => false } },
    );
    expect(exit).toBe(1);
    expect(cancelled.mutations()).toEqual([]);

    const drifted = await UpgradeState.create();
    const driftExit = await main(
      ['upgrade', '--repo', 'splrad/example', '--to', targetSha],
      { GH_TOKEN: 'token' },
      {
        templateDirectory,
        transport: drifted.transport,
        confirmation: {
          confirm: async () => {
            drifted.defaultFiles.set('release-adapter.mjs', 'external drift\n');
            return true;
          },
        },
      },
    );
    expect(driftExit).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('plan changed after confirmation'));
    expect(drifted.mutations()).toEqual([]);
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('creates one exact branch commit and pull request, then reuses both without mutation', async () => {
    const state = await UpgradeState.create();
    const plan = await readyPlan(state);
    const report = await executeUpgrade({
      transport: state.transport,
      owner: 'splrad',
      repository: 'example',
      plan,
    });
    expect(report).toMatchObject({
      branchName: 'steward/upgrade',
      branchSha,
      branchStatus: 'create',
      pullRequestNumber: 12,
      pullRequestStatus: 'create',
    });
    expect(state.mutations().map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /repos/splrad/example/git/trees',
      'POST /repos/splrad/example/git/commits',
      'POST /repos/splrad/example/git/refs',
      'POST /repos/splrad/example/pulls',
    ]);
    const tree = state.mutations()[0]!.body as { tree: Array<{ path: string }> };
    expect(tree.tree.map((entry) => entry.path)).not.toContain('release-adapter.mjs');

    state.requests.length = 0;
    const retryPlan = await readyPlan(state);
    expect(retryPlan).toMatchObject({ branchStatus: 'reuse', pullRequestStatus: 'reuse' });
    const retry = await executeUpgrade({
      transport: state.transport,
      owner: 'splrad',
      repository: 'example',
      plan: retryPlan,
    });
    expect(retry.pullRequestNumber).toBe(12);
    expect(state.mutations()).toEqual([]);
  });

  it('recognizes an already-current managed surface without creating a branch', async () => {
    const state = await UpgradeState.create();
    const plan = await readyPlan(state);
    for (const file of plan.files) state.defaultFiles.set(file.path, file.content);
    state.requests.length = 0;
    const prepared = await prepareUpgrade({
      transport: state.transport,
      owner: 'splrad',
      repository: 'example',
      targetSha,
    });
    expect(prepared.status).toBe('current');
    expect(prepared.plan.counts).toEqual({ create: 0, update: 0, unchanged: 7 });
    expect(prepared.plan.branchStatus).toBe('none');
    expect(state.mutations()).toEqual([]);
  });

  it('creates a missing generated caller but refuses to overwrite customized managed files', async () => {
    const missing = await UpgradeState.create();
    missing.defaultFiles.delete('.github/workflows/pr-review-signal.yml');
    const missingPlan = await readyPlan(missing);
    expect(missingPlan.files.find((file) => file.path === '.github/workflows/pr-review-signal.yml')?.status)
      .toBe('create');

    const workflow = await UpgradeState.create();
    workflow.defaultFiles.set(
      '.github/workflows/pr-governance.yml',
      `${workflow.defaultFiles.get('.github/workflows/pr-governance.yml')}# project customization\n`,
    );
    await expect(readyPlan(workflow)).rejects.toThrow('not the Steward-generated template');
    expect(workflow.mutations()).toEqual([]);

    const dependabot = await UpgradeState.create();
    dependabot.defaultFiles.set('.github/dependabot.yml', 'version: 2\n# project customization\n');
    await expect(readyPlan(dependabot)).rejects.toThrow('dependabot.yml is not the Steward-generated template');
    expect(dependabot.mutations()).toEqual([]);
  });

  it('rejects unsupported target schemas and non-exact reusable branches', async () => {
    const future = await UpgradeState.create();
    const schema = JSON.parse(schemaContent) as { properties: { schemaVersion: { const: number } } };
    schema.properties.schemaVersion.const = 2;
    future.sourceFiles.set(`${targetSha}:schema/steward.schema.json`, JSON.stringify(schema));
    await expect(readyPlan(future)).rejects.toThrow('cannot migrate schemaVersion 1 to 2');
    expect(future.mutations()).toEqual([]);

    const branch = await UpgradeState.create();
    const plan = await readyPlan(branch);
    branch.branchSha = branchSha;
    for (const file of plan.files.filter((file) => file.status !== 'unchanged')) {
      branch.branchFiles.set(file.path, file.content);
    }
    branch.corruptBranch = true;
    await expect(readyPlan(branch)).rejects.toThrow('not the exact Steward upgrade commit');
    expect(branch.mutations()).toEqual([]);
  });

  it('refuses to silently skip PR Automation while managing an enabled DCO caller', async () => {
    const unsupported = await UpgradeState.create();
    const automation = JSON.parse(unsupported.defaultFiles.get('.github/steward.json')!) as StewardManifest;
    automation.features.prAutomation = true;
    unsupported.defaultFiles.set('.github/steward.json', `${JSON.stringify(automation, null, 2)}\n`);
    await expect(readyPlan(unsupported)).rejects.toThrow('unsupported enabled features: prAutomation');
    expect(unsupported.mutations()).toEqual([]);

    const managed = await UpgradeState.create();
    const configured = JSON.parse(managed.defaultFiles.get('.github/steward.json')!) as StewardManifest;
    configured.features.dcoAdvisory = true;
    managed.defaultFiles.set('.github/steward.json', `${JSON.stringify(configured, null, 2)}\n`);
    const dcoTemplate = await readFile(`${templateDirectory}/thin-workflows/dco-advisory.yml`, 'utf8');
    managed.sourceFiles.set(`${targetSha}:templates/thin-workflows/dco-advisory.yml`, dcoTemplate);
    const plan = await readyPlan(managed);
    expect(plan.files.find((file) => file.path === '.github/workflows/dco-advisory.yml'))
      .toMatchObject({ status: 'create' });
    expect(managed.mutations()).toEqual([]);
  });

  it('validates the migrated manifest against the complete target schema', async () => {
    const state = await UpgradeState.create();
    const schema = JSON.parse(schemaContent) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    schema.required.push('targetRequired');
    schema.properties.targetRequired = { type: 'string', minLength: 1 };
    state.sourceFiles.set(`${targetSha}:schema/steward.schema.json`, JSON.stringify(schema));
    await expect(readyPlan(state)).rejects.toThrow('invalid for the target Steward schema');
    expect(state.mutations()).toEqual([]);
  });

  it('rejects a target that is behind or diverged from a current pin', async () => {
    for (const status of ['behind', 'diverged']) {
      const state = await UpgradeState.create();
      state.comparisonStatus = status;
      await expect(readyPlan(state)).rejects.toThrow('is not an upgrade from current pin');
      expect(state.mutations()).toEqual([]);
    }
  });
});
