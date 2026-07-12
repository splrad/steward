import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sodium from 'libsodium-wrappers';
import { describe, expect, it, vi } from 'vitest';
import {
  encryptRepositorySecret,
  executeInitApply,
  prepareInitApply,
} from '../packages/cli/src/init-apply.js';
import { parseInitSpec, type InitSpec } from '../packages/cli/src/init.js';
import { main, parseArguments } from '../packages/cli/src/main.js';
import {
  requiredSecretRequirements,
  withSecrets,
  type SecretPrompt,
} from '../packages/cli/src/secret-input.js';
import { GitHubApiError, type GitHubRequest, type GitHubTransport } from '../packages/github/src/index.js';
import type { ClassificationConfiguration, StewardManifest } from '../packages/manifest/src/index.js';

const baseSha = 'a'.repeat(40);
const baseTreeSha = 'b'.repeat(40);
const treeSha = 'c'.repeat(40);
const branchSha = 'd'.repeat(40);
const templateDirectory = fileURLToPath(new URL('../templates/', import.meta.url));
const classification = JSON.parse(await readFile(
  new URL('./fixtures/cadfontautoreplace/classification.json', import.meta.url),
  'utf8',
)) as ClassificationConfiguration;

function spec(): InitSpec {
  const manifest: StewardManifest = {
    schemaVersion: 1,
    automation: {
      githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
      maintainers: { source: 'organization-team', teamSlug: 'maintainers' },
      language: 'zh-CN',
    },
    features: {
      prAutomation: false, classification: true, dcoAdvisory: false, governance: true,
      copilotReview: true, release: false, webhookRelay: false,
    },
    classification,
  };
  return parseInitSpec({ stewardSha: 'e'.repeat(40), manifest });
}

class ScriptedPrompt implements SecretPrompt {
  readonly returned: Buffer[] = [];
  #values: Buffer[];

  constructor(values: Buffer[]) { this.#values = values; }

  async readSecret(): Promise<Buffer> {
    const value = this.#values.shift();
    if (!value) throw new Error('No scripted Secret remains');
    this.returned.push(value);
    return value;
  }
}

function privateKey(): Buffer {
  const { privateKey: key } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return Buffer.from(key.export({ type: 'pkcs8', format: 'pem' }));
}

class RepositoryState {
  readonly requests: GitHubRequest[] = [];
  readonly defaultFiles = new Map<string, string>();
  readonly secrets = new Set<string>();
  readonly variables = new Map<string, string>();
  readonly branchFiles = new Map<string, string>();
  admin = true;
  appInstalled = true;
  branchSha: string | undefined;
  pullRequest: { number: number; html_url: string } | undefined;
  corruptBranch = false;
  failSecretName: string | undefined;
  failedSecretOnce = false;

  readonly transport: GitHubTransport = {
    request: async <T>(request: GitHubRequest): Promise<T> => {
      this.requests.push(structuredClone(request));
      return this.handle(request) as T;
    },
  };

  mutations(): GitHubRequest[] {
    return this.requests.filter((request) => request.method && request.method !== 'GET');
  }

  private notFound(path: string): never {
    throw new GitHubApiError({ status: 404, method: 'GET', path, message: 'Not Found' });
  }

  private filePath(path: string): string {
    return path.split('/contents/')[1]!.split('/').map(decodeURIComponent).join('/');
  }

  private handle(request: GitHubRequest): unknown {
    const path = request.path;
    if (path === '/repos/splrad/example') return {
      id: 7, full_name: 'splrad/example', default_branch: 'main', archived: false, disabled: false,
      permissions: { admin: this.admin }, owner: { login: 'splrad', type: 'Organization' },
    };
    if (path === '/orgs/splrad/installations') return { installations: this.appInstalled ? [{
      id: 9, app_id: 42, app_slug: 'splrad-steward', client_id: 'Iv23liuSr0qd4WLJdZhH',
      repository_selection: 'all', suspended_at: null,
      permissions: {
        checks: 'write', contents: 'write', pull_requests: 'write', issues: 'write', members: 'read', actions: 'write',
      },
    }] : [] };
    if (path === '/repos/splrad/example/git/ref/heads/main') {
      return { ref: 'refs/heads/main', object: { type: 'commit', sha: baseSha } };
    }
    if (path === `/repos/splrad/example/git/commits/${baseSha}`) return { sha: baseSha, tree: { sha: baseTreeSha } };
    if (path.includes('/contents/')) {
      const file = this.filePath(path);
      const ref = String(request.query?.ref ?? '');
      const content = ref === 'main' ? this.defaultFiles.get(file) : this.branchFiles.get(file) ?? this.defaultFiles.get(file);
      if (content === undefined) return this.notFound(path);
      return { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'), sha: 'blob' };
    }
    if (path === '/repos/splrad/example/actions/secrets' && !request.method) {
      return { secrets: [...this.secrets].map((name) => ({ name })) };
    }
    if (path === '/repos/splrad/example/actions/variables' && !request.method) {
      return { variables: [...this.variables].map(([name, value]) => ({ name, value })) };
    }
    if (path === '/repos/splrad/example/git/ref/heads/steward%2Finit') {
      if (!this.branchSha) return this.notFound(path);
      return { ref: 'refs/heads/steward/init', object: { type: 'commit', sha: this.branchSha } };
    }
    if (path === `/repos/splrad/example/commits/${branchSha}`) {
      const files = this.corruptBranch
        ? [{ filename: 'unrelated.txt', status: 'added' }]
        : [...this.branchFiles.keys()].map((filename) => ({ filename, status: 'added' }));
      return { sha: branchSha, parents: [{ sha: baseSha }], files };
    }
    if (path === '/repos/splrad/example/pulls' && !request.method) {
      return this.pullRequest ? [{
        ...this.pullRequest,
        base: { ref: 'main' }, head: { ref: 'steward/init', sha: branchSha },
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
      return { ref: 'refs/heads/steward/init', object: { type: 'commit', sha: branchSha } };
    }
    if (path === '/repos/splrad/example/actions/secrets/public-key') return { key_id: 'key-id', key: 'public-key' };
    if (path.includes('/actions/secrets/') && request.method === 'PUT') {
      const name = decodeURIComponent(path.split('/').at(-1)!);
      if (name === this.failSecretName && !this.failedSecretOnce) {
        this.failedSecretOnce = true;
        throw new GitHubApiError({ status: 500, method: 'PUT', path, message: 'simulated failure' });
      }
      this.secrets.add(name);
      return undefined;
    }
    if (path === '/repos/splrad/example/actions/variables' && request.method === 'POST') {
      const body = request.body as { name: string; value: string };
      this.variables.set(body.name, body.value);
      return { name: body.name, value: body.value };
    }
    if (path === '/repos/splrad/example/pulls' && request.method === 'POST') {
      this.pullRequest = { number: 12, html_url: 'https://github.com/splrad/example/pull/12' };
      return this.pullRequest;
    }
    throw new Error(`Unexpected request: ${request.method ?? 'GET'} ${path}`);
  }
}

async function readyPlan(state: RepositoryState): Promise<Awaited<ReturnType<typeof prepareInitApply>> & { status: 'ready' }> {
  const prepared = await prepareInitApply({
    transport: state.transport, owner: 'splrad', repository: 'example', spec: spec(), templateDirectory,
  });
  if (prepared.status !== 'ready') throw new Error('Expected ready plan');
  return prepared;
}

describe('init --apply', () => {
  it('requires one explicit mutation mode and rejects JSON apply output', () => {
    expect(parseArguments(['init', '--apply', '--repo', 'splrad/example', '--spec', 'init.json']))
      .toEqual({ command: 'init', mode: 'apply', apply: true, repository: 'splrad/example', spec: 'init.json' });
    expect(() => parseArguments(['init', '--apply', '--dry-run', '--repo', 'splrad/example', '--spec', 'init.json']))
      .toThrow('exactly one');
    expect(() => parseArguments(['init', '--apply', '--repo', 'splrad/example', '--spec', 'init.json', '--json']))
      .toThrow('--json is not supported');
  });

  it('prepares with GET requests only and cancels before every mutation', async () => {
    const state = new RepositoryState();
    const prepared = await readyPlan(state);
    expect(prepared.plan).toMatchObject({
      branchStatus: 'create', pullRequestStatus: 'create', variableStatus: 'create',
      missingSecrets: [
        'WORKFLOW_AUTOMATION_APP_PRIVATE_KEY', 'COPILOT_REVIEW_REQUEST_TOKEN', 'CORE_AUTO_APPROVAL_TOKEN',
      ],
    });
    expect(prepared.plan.counts).toEqual({ create: 6, unchanged: 0, conflict: 0 });
    expect(state.mutations()).toEqual([]);

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const specFile = fileURLToPath(new URL('./fixtures/cli/init-minimal.json', import.meta.url));
      const exitCode = await main(
        ['init', '--apply', '--repo', 'splrad/example', '--spec', specFile],
        { GH_TOKEN: 'fake-api-token' },
        {
          templateDirectory,
          transport: state.transport,
          confirmation: { async confirm() { return false; } },
        },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith('Steward init cancelled; no mutations were sent.\n');
      expect(state.mutations()).toEqual([]);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('creates one atomic branch commit, encrypted missing settings, and one PR, then reuses all state', async () => {
    const state = new RepositoryState();
    const prepared = await readyPlan(state);
    const key = privateKey();
    const copilot = Buffer.from('github_pat_COPILOT123456789012345678901234567890');
    const approval = Buffer.from('github_pat_APPROVAL123456789012345678901234567890');
    const prompt = new ScriptedPrompt([key, copilot, approval]);
    const plaintext = [key.toString(), copilot.toString(), approval.toString()];

    const report = await withSecrets(
      requiredSecretRequirements(spec().manifest),
      prompt,
      (vault) => executeInitApply({
        transport: state.transport, owner: 'splrad', repository: 'example', plan: prepared.plan, vault,
        encrypt: async (value) => `sealed-${value.length}`,
      }),
    );

    expect(report).toMatchObject({
      branchName: 'steward/init', branchSha, branchStatus: 'create',
      pullRequestNumber: 12, pullRequestStatus: 'create', variableCreated: true,
    });
    expect(report.secretsCreated).toEqual(prepared.plan.missingSecrets);
    expect(prompt.returned.every((value) => value.every((byte) => byte === 0))).toBe(true);
    const mutations = state.mutations();
    expect(mutations.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /repos/splrad/example/git/trees',
      'POST /repos/splrad/example/git/commits',
      'POST /repos/splrad/example/git/refs',
      'PUT /repos/splrad/example/actions/secrets/WORKFLOW_AUTOMATION_APP_PRIVATE_KEY',
      'PUT /repos/splrad/example/actions/secrets/COPILOT_REVIEW_REQUEST_TOKEN',
      'PUT /repos/splrad/example/actions/secrets/CORE_AUTO_APPROVAL_TOKEN',
      'POST /repos/splrad/example/actions/variables',
      'POST /repos/splrad/example/pulls',
    ]);
    expect(mutations[0]?.body).toMatchObject({ base_tree: baseTreeSha });
    expect(mutations[1]?.body).toEqual({
      message: 'chore: initialize Steward', tree: treeSha, parents: [baseSha],
    });
    const serialized = JSON.stringify(mutations);
    for (const value of plaintext) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('refs/heads/main');

    const mutationCount = mutations.length;
    const retry = await readyPlan(state);
    expect(retry.plan).toMatchObject({
      branchStatus: 'reuse', pullRequestStatus: 'reuse', pullRequestNumber: 12,
      missingSecrets: [], variableStatus: 'unchanged',
    });
    await withSecrets([], new ScriptedPrompt([]), (vault) => executeInitApply({
      transport: state.transport, owner: 'splrad', repository: 'example', plan: retry.plan, vault,
    }));
    expect(state.mutations()).toHaveLength(mutationCount);
  });

  it('reports partial progress and resumes without overwriting completed Secrets or duplicating the branch', async () => {
    const state = new RepositoryState();
    state.failSecretName = 'COPILOT_REVIEW_REQUEST_TOKEN';
    const first = await readyPlan(state);
    const firstPrompt = new ScriptedPrompt([
      privateKey(),
      Buffer.from('github_pat_COPILOT123456789012345678901234567890'),
      Buffer.from('github_pat_APPROVAL123456789012345678901234567890'),
    ]);
    await expect(withSecrets(
      requiredSecretRequirements(spec().manifest),
      firstPrompt,
      (vault) => executeInitApply({
        transport: state.transport, owner: 'splrad', repository: 'example', plan: first.plan, vault,
        encrypt: async (value) => `sealed-${value.length}`,
      }),
    )).rejects.toThrow('completed: branch:steward/init, secret:WORKFLOW_AUTOMATION_APP_PRIVATE_KEY');
    expect(firstPrompt.returned.every((value) => value.every((byte) => byte === 0))).toBe(true);
    expect(state.branchSha).toBe(branchSha);
    expect([...state.secrets]).toEqual(['WORKFLOW_AUTOMATION_APP_PRIVATE_KEY']);
    expect(state.variables.size).toBe(0);
    expect(state.pullRequest).toBeUndefined();

    const retry = await readyPlan(state);
    expect(retry.plan).toMatchObject({
      branchStatus: 'reuse', pullRequestStatus: 'create', variableStatus: 'create',
      missingSecrets: ['COPILOT_REVIEW_REQUEST_TOKEN', 'CORE_AUTO_APPROVAL_TOKEN'],
    });
    const retryRequirements = requiredSecretRequirements(spec().manifest)
      .filter((requirement) => retry.plan.missingSecrets.includes(requirement.name));
    const retryPrompt = new ScriptedPrompt([
      Buffer.from('github_pat_COPILOT123456789012345678901234567890'),
      Buffer.from('github_pat_APPROVAL123456789012345678901234567890'),
    ]);
    await withSecrets(retryRequirements, retryPrompt, (vault) => executeInitApply({
      transport: state.transport, owner: 'splrad', repository: 'example', plan: retry.plan, vault,
      encrypt: async (value) => `sealed-${value.length}`,
    }));
    expect([...state.secrets].sort()).toEqual(first.plan.missingSecrets.toSorted());
    expect(state.pullRequest?.number).toBe(12);
    expect(state.mutations().filter((request) => request.path.endsWith('/WORKFLOW_AUTOMATION_APP_PRIVATE_KEY')))
      .toHaveLength(1);
    expect(state.mutations().filter((request) => request.path.endsWith('/git/refs'))).toHaveLength(1);
  });

  it('refuses to overwrite a Secret that appears after planning', async () => {
    const state = new RepositoryState();
    const prepared = await readyPlan(state);
    state.secrets.add('COPILOT_REVIEW_REQUEST_TOKEN');
    const prompt = new ScriptedPrompt([
      privateKey(),
      Buffer.from('github_pat_COPILOT123456789012345678901234567890'),
      Buffer.from('github_pat_APPROVAL123456789012345678901234567890'),
    ]);
    await expect(withSecrets(
      requiredSecretRequirements(spec().manifest),
      prompt,
      (vault) => executeInitApply({
        transport: state.transport, owner: 'splrad', repository: 'example', plan: prepared.plan, vault,
        encrypt: async (value) => `sealed-${value.length}`,
      }),
    )).rejects.toThrow('Refusing to overwrite Actions Secrets');
    expect(state.mutations().filter((request) => request.method === 'PUT')).toEqual([]);
    expect(prompt.returned.every((value) => value.every((byte) => byte === 0))).toBe(true);
  });

  it('runs the complete interactive command path when the confirmed plan remains unchanged', async () => {
    const state = new RepositoryState();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const specFile = fileURLToPath(new URL('./fixtures/cli/init-minimal.json', import.meta.url));
      const exitCode = await main(
        ['init', '--apply', '--repo', 'splrad/example', '--spec', specFile],
        { GH_TOKEN: 'fake-api-token' },
        {
          templateDirectory,
          transport: state.transport,
          confirmation: { async confirm() { return true; } },
        },
      );
      expect(exitCode).toBe(0);
      expect(stdout.mock.calls.flat().join('')).toContain('Steward init apply complete: splrad/example');
      expect(stderr).not.toHaveBeenCalled();
      expect(state.mutations().map((request) => `${request.method} ${request.path}`)).toEqual([
        'POST /repos/splrad/example/git/trees',
        'POST /repos/splrad/example/git/commits',
        'POST /repos/splrad/example/git/refs',
        'POST /repos/splrad/example/actions/variables',
        'POST /repos/splrad/example/pulls',
      ]);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('revalidates the confirmed plan before sending any mutation', async () => {
    const state = new RepositoryState();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const specFile = fileURLToPath(new URL('./fixtures/cli/init-minimal.json', import.meta.url));
      const exitCode = await main(
        ['init', '--apply', '--repo', 'splrad/example', '--spec', specFile],
        { GH_TOKEN: 'fake-api-token' },
        {
          templateDirectory,
          transport: state.transport,
          confirmation: {
            async confirm() {
              state.variables.set('WORKFLOW_AUTOMATION_APP_CLIENT_ID', 'Iv23liuSr0qd4WLJdZhH');
              return true;
            },
          },
        },
      );
      expect(exitCode).toBe(2);
      expect(stderr.mock.calls.flat().join('')).toContain('plan changed after confirmation');
      expect(state.mutations()).toEqual([]);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('fails closed on default-file, Variable, permission, and existing-branch conflicts', async () => {
    const fileConflict = new RepositoryState();
    fileConflict.defaultFiles.set('.github/steward.json', '{"ownedBy":"consumer"}\n');
    await expect(readyPlan(fileConflict)).rejects.toThrow('generated-file conflicts');
    expect(fileConflict.mutations()).toEqual([]);

    const variableConflict = new RepositoryState();
    variableConflict.variables.set('WORKFLOW_AUTOMATION_APP_CLIENT_ID', 'different-client');
    await expect(readyPlan(variableConflict)).rejects.toThrow('different value');
    expect(variableConflict.mutations()).toEqual([]);

    const denied = new RepositoryState();
    denied.admin = false;
    await expect(readyPlan(denied)).rejects.toThrow('administrator permission');
    expect(denied.requests).toHaveLength(1);

    const branchConflict = new RepositoryState();
    branchConflict.branchSha = branchSha;
    branchConflict.corruptBranch = true;
    await expect(readyPlan(branchConflict)).rejects.toThrow('not the exact Steward init commit');
    expect(branchConflict.mutations()).toEqual([]);
  });

  it('returns the App installation stop result without inventory or mutations', async () => {
    const state = new RepositoryState();
    state.appInstalled = false;
    const prepared = await prepareInitApply({
      transport: state.transport, owner: 'splrad', repository: 'example', spec: spec(), templateDirectory,
    });
    expect(prepared).toMatchObject({
      status: 'blocked',
      preflight: {
        status: 'action-required', reason: 'account-installation-missing',
        actionUrl: 'https://github.com/apps/splrad-steward/installations/new',
      },
    });
    expect(state.requests.map((request) => request.path)).toEqual([
      '/repos/splrad/example', '/orgs/splrad/installations',
    ]);
    expect(state.mutations()).toEqual([]);
  });

  it('uses a real LibSodium sealed box compatible with GitHub repository Secrets', async () => {
    await sodium.ready;
    const pair = sodium.crypto_box_keypair();
    const value = Buffer.from('github_pat_ENCRYPTION123456789012345678901234567890');
    let ciphertext: Uint8Array | undefined;
    let opened: Uint8Array | undefined;
    try {
      const publicKey = sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL);
      const encrypted = await encryptRepositorySecret(value, publicKey);
      ciphertext = sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL);
      opened = sodium.crypto_box_seal_open(ciphertext, pair.publicKey, pair.privateKey);
      expect(Buffer.from(opened).equals(value)).toBe(true);
    } finally {
      value.fill(0);
      if (ciphertext) sodium.memzero(ciphertext);
      if (opened) sodium.memzero(opened);
      sodium.memzero(pair.publicKey);
      sodium.memzero(pair.privateKey);
    }
  });
});
