import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  executeActivate,
  prepareActivate,
  type ActivateRulesetPlan,
} from '../packages/cli/src/activate.js';
import { main, parseArguments } from '../packages/cli/src/main.js';
import { stewardCheckExternalId } from '../packages/core/src/index.js';
import type { GitHubRequest, GitHubTransport } from '../packages/github/src/index.js';
import {
  manifestDigest,
  type ClassificationConfiguration,
  type StewardManifest,
} from '../packages/manifest/src/index.js';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const inputDigest = 'c'.repeat(64);
const classification = JSON.parse(await readFile(
  new URL('./fixtures/cadfontautoreplace/classification.json', import.meta.url),
  'utf8',
)) as ClassificationConfiguration;

function manifest(): StewardManifest {
  return {
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
      release: false,
      webhookRelay: false,
    },
    classification,
  };
}

const otherRule = {
  type: 'pull_request',
  parameters: {
    required_approving_review_count: 1,
    required_review_thread_resolution: true,
    allowed_merge_methods: ['squash'],
  },
};

function requiredChecks(checks: Array<{ context: string; integration_id?: number }>) {
  return {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
      required_status_checks: checks,
    },
  };
}

function dedicatedRequiredChecks() {
  return {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: true,
      required_status_checks: [{ context: 'PR Validation Matrix Gate', integration_id: 42 }],
    },
  };
}

class ActivateState {
  readonly requests: GitHubRequest[] = [];
  admin = true;
  appInstalled = true;
  trustedCheck = true;
  checkAppId = 42;
  checkAppSlug = 'splrad-steward';
  detailsOmitSource = false;
  validCallerPayload = true;
  manifestValue = manifest();
  rulesets: Array<Record<string, unknown>> = [{
    id: 5,
    name: 'main-protection',
    target: 'branch',
    source_type: 'Repository',
    source: 'splrad/example',
    enforcement: 'disabled',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: ['refs/heads/release'] } },
    bypass_actors: [{ actor_id: 4, actor_type: 'Team', actor_name: 'maintainers', bypass_mode: 'pull_request' }],
    rules: [
      { type: 'deletion' },
      otherRule,
      requiredChecks([
        { context: 'Project CI', integration_id: 99 },
        { context: 'Main Authorization Gate', integration_id: 15368 },
        { context: 'Copilot Code Review Gate', integration_id: 42 },
      ]),
      { type: 'non_fast_forward' },
    ],
  }];

  readonly transport: GitHubTransport = {
    request: async <T>(request: GitHubRequest): Promise<T> => {
      this.requests.push(structuredClone(request));
      return this.handle(request) as T;
    },
  };

  mutations(): GitHubRequest[] {
    return this.requests.filter((request) => request.method && request.method !== 'GET');
  }

  private handle(request: GitHubRequest): unknown {
    const path = request.path;
    if (path === '/repos/splrad/example') return {
      id: 7,
      full_name: 'splrad/example',
      default_branch: 'main',
      archived: false,
      disabled: false,
      permissions: { admin: this.admin },
      owner: { login: 'splrad', type: 'Organization' },
    };
    if (path === '/repos/splrad/example/git/ref/heads/main') {
      return { ref: 'refs/heads/main', object: { type: 'commit', sha: baseSha } };
    }
    if (path === '/repos/splrad/example/contents/.github/steward.json') {
      return {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(this.manifestValue)).toString('base64'),
        sha: 'manifest-blob',
      };
    }
    if (path === '/repos/splrad/example/contents/.github/workflows/pr-validation-matrix.yml') {
      if (!this.validCallerPayload) return { type: 'directory' };
      return {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from([
          'on:',
          '  workflow_dispatch:',
          'jobs:',
          '  matrix:',
          `    uses: splrad/steward/.github/workflows/pr-validation-matrix.yml@${'d'.repeat(40)}`,
        ].join('\n')).toString('base64'),
        sha: 'caller-blob',
      };
    }
    if (path === '/repos/splrad/example/pulls/3') return {
      number: 3,
      state: 'open',
      draft: false,
      base: { ref: 'main' },
      head: { sha: headSha },
    };
    if (path === '/orgs/splrad/installations') return { installations: this.appInstalled ? [{
      id: 9,
      app_id: 42,
      app_slug: 'splrad-steward',
      client_id: 'Iv23liuSr0qd4WLJdZhH',
      repository_selection: 'all',
      suspended_at: null,
      permissions: {
        checks: 'write', contents: 'read', pull_requests: 'write', issues: 'write', members: 'read', actions: 'write',
      },
    }] : [] };
    if (path === `/repos/splrad/example/commits/${headSha}/check-runs`) {
      return { check_runs: this.trustedCheck ? [{
        id: 8,
        name: 'PR Validation Matrix Gate',
        status: 'completed',
        conclusion: 'failure',
        app: { id: this.checkAppId, slug: this.checkAppSlug },
        external_id: stewardCheckExternalId({
          repositoryId: 7,
          prNumber: 3,
          headSha,
          checkId: 'validation-matrix',
          configDigest: manifestDigest(this.manifestValue),
          inputDigest,
        }),
      }] : [{
        id: 8,
        name: 'PR Validation Matrix Gate',
        status: 'completed',
        conclusion: 'success',
        app: { id: 15368, slug: 'github-actions' },
        external_id: '',
      }] };
    }
    if (path === '/repos/splrad/example/rulesets' && request.method === 'POST') {
      return { id: 11, ...(request.body as object) };
    }
    if (path === '/repos/splrad/example/rulesets') {
      return this.rulesets.map(({ id, name, target, source_type, source, enforcement }) => (
        { id, name, target, source_type, source, enforcement }
      ));
    }
    const match = path.match(/^\/repos\/splrad\/example\/rulesets\/(\d+)$/);
    if (match && !request.method) {
      const ruleset = structuredClone(this.rulesets.find((candidate) => candidate.id === Number(match[1])));
      if (this.detailsOmitSource && ruleset) {
        delete ruleset.source_type;
        delete ruleset.source;
      }
      return ruleset;
    }
    if (match && request.method === 'PUT') return { id: Number(match[1]), ...(request.body as object) };
    if (path === '/repos/splrad/example/actions/workflows/pr-validation-matrix.yml/dispatches'
      && request.method === 'POST') return { workflow_run_id: 12, html_url: 'https://github.com/splrad/example/actions/runs/12' };
    throw new Error(`Unexpected request: ${request.method ?? 'GET'} ${path}`);
  }
}

describe('activate command', () => {
  it('parses only the explicit interactive command surface', () => {
    expect(parseArguments(['activate', '--repo', 'splrad/example', '--pr', '3'])).toEqual({
      command: 'activate', repository: 'splrad/example', pullRequest: 3,
    });
    expect(() => parseArguments(['activate', '--repo', 'splrad/example'])).toThrow('--pr');
    expect(() => parseArguments(['activate', '--repo', 'splrad/example', '--pr', '3', '--json'])).toThrow('Unknown argument');
  });

  it('dispatches exactly one full Matrix run and does not read or mutate rulesets when the App Check is absent', async () => {
    const state = new ActivateState();
    state.trustedCheck = false;
    const exit = await main(
      ['activate', '--repo', 'splrad/example', '--pr', '3'],
      { GH_TOKEN: 'token' },
      { templateDirectory: '.', transport: state.transport },
    );
    expect(exit).toBe(0);
    expect(state.mutations()).toEqual([{
      method: 'POST',
      path: '/repos/splrad/example/actions/workflows/pr-validation-matrix.yml/dispatches',
      body: { ref: 'main', inputs: { pr_number: '3', head_sha: headSha, scope: 'full', mode: 'enforce' } },
    }]);
    expect(state.requests.some((request) => request.path.includes('/rulesets'))).toBe(false);
  });

  it('preserves every non-Steward check, rule, condition, and bypass actor in the update plan', async () => {
    const state = new ActivateState();
    const prepared = await prepareActivate(state.transport, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(prepared.status).toBe('ready');
    const plan = (prepared as { status: 'ready'; plan: ActivateRulesetPlan }).plan;
    expect(plan.action).toBe('update');
    expect(plan.removedChecks).toEqual(['Main Authorization Gate', 'Copilot Code Review Gate']);
    expect(plan.preservedChecks).toEqual(['Project CI']);
    expect(plan.requestBody).toEqual({
      name: 'main-protection',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [{ actor_id: 4, actor_type: 'Team', bypass_mode: 'pull_request' }],
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: ['refs/heads/release'] } },
      rules: [
        { type: 'deletion' },
        otherRule,
        requiredChecks([
          { context: 'Project CI', integration_id: 99 },
          { context: 'PR Validation Matrix Gate', integration_id: 42 },
        ]),
        { type: 'non_fast_forward' },
      ],
    });
    expect(state.requests.find((request) => request.path.endsWith('/contents/.github/steward.json'))?.query?.ref)
      .toBe(baseSha);
    expect(state.requests.find((request) => request.path.endsWith('/contents/.github/workflows/pr-validation-matrix.yml'))?.query?.ref)
      .toBe(baseSha);
    expect(state.requests.find((request) => request.path.endsWith('/check-runs'))?.query?.filter).toBe('all');
    expect(state.mutations()).toEqual([]);
  });

  it('treats an omitted empty ref exclusion list as empty when matching and preserving a ruleset', async () => {
    const state = new ActivateState();
    state.rulesets[0]!.conditions = { ref_name: { include: ['refs/heads/main'] } };
    const prepared = await prepareActivate(state.transport, {
      owner: 'splrad', repository: 'example', pullRequest: 3,
    });
    expect(prepared.status).toBe('ready');
    const plan = (prepared as { status: 'ready'; plan: ActivateRulesetPlan }).plan;
    expect(plan.action).toBe('update');
    expect(plan.requestBody.conditions).toEqual({
      ref_name: { include: ['refs/heads/main'], exclude: [] },
    });
  });

  it('uses ruleset source metadata from the list response when detail omits it', async () => {
    const state = new ActivateState();
    state.detailsOmitSource = true;
    const prepared = await prepareActivate(state.transport, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(prepared.status).toBe('ready');
    expect((prepared as { status: 'ready'; plan: ActivateRulesetPlan }).plan.action).toBe('update');
  });

  it('preserves ID-less bypass actors and rejects silent identity normalization', async () => {
    const valid = new ActivateState();
    valid.rulesets[0]!.bypass_actors = [
      { actor_id: null, actor_type: 'OrganizationAdmin', bypass_mode: 'always' },
      { actor_type: 'DeployKey', bypass_mode: 'exempt' },
    ];
    const prepared = await prepareActivate(valid.transport, {
      owner: 'splrad', repository: 'example', pullRequest: 3,
    });
    expect(prepared.status).toBe('ready');
    expect((prepared as { status: 'ready'; plan: ActivateRulesetPlan }).plan.requestBody.bypass_actors).toEqual([
      { actor_type: 'OrganizationAdmin', bypass_mode: 'always' },
      { actor_type: 'DeployKey', bypass_mode: 'exempt' },
    ]);

    for (const actorType of ['OrganizationAdmin', 'DeployKey']) {
      const invalid = new ActivateState();
      invalid.rulesets[0]!.bypass_actors = [{ actor_id: 12, actor_type: actorType, bypass_mode: 'always' }];
      await expect(prepareActivate(invalid.transport, {
        owner: 'splrad', repository: 'example', pullRequest: 3,
      })).rejects.toThrow('invalid bypass actor');
      expect(invalid.mutations()).toEqual([]);
    }
  });

  it('creates a dedicated minimal ruleset instead of guessing which unrelated ruleset owns Steward', async () => {
    const state = new ActivateState();
    state.rulesets = [{
      id: 5,
      name: 'project-policy',
      target: 'branch',
      source_type: 'Repository',
      source: 'splrad/example',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      bypass_actors: [],
      rules: [requiredChecks([{ context: 'Project CI', integration_id: 99 }])],
    }];
    const prepared = await prepareActivate(state.transport, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(prepared.status).toBe('ready');
    const plan = (prepared as { status: 'ready'; plan: ActivateRulesetPlan }).plan;
    expect(plan.action).toBe('create');
    expect(plan.requestBody).toEqual({
      name: 'SPLRAD Steward',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [dedicatedRequiredChecks()],
    });
  });

  it('reuses an already active exact Matrix rule without confirmation or mutation', async () => {
    const state = new ActivateState();
    state.rulesets[0] = {
      ...state.rulesets[0],
      enforcement: 'active',
      rules: [otherRule, requiredChecks([
        { context: 'Project CI', integration_id: 99 },
        { context: 'PR Validation Matrix Gate', integration_id: 42 },
      ])],
    };
    let confirmations = 0;
    const exit = await main(
      ['activate', '--repo', 'splrad/example', '--pr', '3'],
      { GH_TOKEN: 'token' },
      {
        templateDirectory: '.',
        transport: state.transport,
        confirmation: { confirm: async () => { confirmations += 1; return true; } },
      },
    );
    expect(exit).toBe(0);
    expect(confirmations).toBe(0);
    expect(state.mutations()).toEqual([]);
  });

  it('requires confirmation, re-reads the exact plan, and then updates one ruleset', async () => {
    const state = new ActivateState();
    const exit = await main(
      ['activate', '--repo', 'splrad/example', '--pr', '3'],
      { GH_TOKEN: 'token' },
      {
        templateDirectory: '.',
        transport: state.transport,
        confirmation: { confirm: async () => true },
      },
    );
    expect(exit).toBe(0);
    expect(state.mutations()).toHaveLength(1);
    expect(state.mutations()[0]?.method).toBe('PUT');
    expect(state.mutations()[0]?.path).toBe('/repos/splrad/example/rulesets/5');
  });

  it('does not mutate after cancellation or after a post-confirmation plan drift', async () => {
    const cancelled = new ActivateState();
    expect(await main(
      ['activate', '--repo', 'splrad/example', '--pr', '3'],
      { GH_TOKEN: 'token' },
      { templateDirectory: '.', transport: cancelled.transport, confirmation: { confirm: async () => false } },
    )).toBe(1);
    expect(cancelled.mutations()).toEqual([]);

    const drifted = new ActivateState();
    expect(await main(
      ['activate', '--repo', 'splrad/example', '--pr', '3'],
      { GH_TOKEN: 'token' },
      {
        templateDirectory: '.',
        transport: drifted.transport,
        confirmation: { confirm: async () => {
          const parameters = (drifted.rulesets[0]!.rules as Array<Record<string, unknown>>)[2]!.parameters as Record<string, unknown>;
          parameters.required_status_checks = [{ context: 'Externally Added', integration_id: 77 }];
          return true;
        } },
      },
    )).toBe(2);
    expect(drifted.mutations()).toEqual([]);
  });

  it('fails closed for ambiguous or inherited Steward-bearing rulesets', async () => {
    const ambiguous = new ActivateState();
    ambiguous.rulesets.push({ ...structuredClone(ambiguous.rulesets[0]), id: 6, name: 'duplicate' });
    await expect(prepareActivate(ambiguous.transport, {
      owner: 'splrad', repository: 'example', pullRequest: 3,
    })).rejects.toThrow('multiple');

    const inherited = new ActivateState();
    inherited.rulesets[0] = { ...inherited.rulesets[0], source_type: 'Organization', source: 'splrad' };
    await expect(prepareActivate(inherited.transport, {
      owner: 'splrad', repository: 'example', pullRequest: 3,
    })).rejects.toThrow('inherited');

    const wrongScope = new ActivateState();
    wrongScope.rulesets = [{
      id: 5,
      name: 'SPLRAD Steward',
      target: 'branch',
      source_type: 'Repository',
      source: 'splrad/example',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/release'], exclude: [] } },
      bypass_actors: [],
      rules: [dedicatedRequiredChecks()],
    }];
    await expect(prepareActivate(wrongScope.transport, {
      owner: 'splrad', repository: 'example', pullRequest: 3,
    })).rejects.toThrow('does not target the default branch');
  });

  it('rejects activation when the Manifest has no PR Matrix feature', async () => {
    const state = new ActivateState();
    const { classification: _classification, ...base } = manifest();
    state.manifestValue = {
      ...base,
      features: {
        prAutomation: false,
        classification: false,
        dcoAdvisory: false,
        governance: false,
        copilotReview: false,
        release: false,
        webhookRelay: false,
      },
    };
    await expect(prepareActivate(state.transport, {
      owner: 'splrad', repository: 'example', pullRequest: 3,
    })).rejects.toThrow('PR Matrix feature');
    expect(state.mutations()).toEqual([]);
  });

  it('identifies an invalid Matrix workflow response without calling it a Manifest error', async () => {
    const state = new ActivateState();
    state.validCallerPayload = false;
    await expect(prepareActivate(state.transport, {
      owner: 'splrad', repository: 'example', pullRequest: 3,
    })).rejects.toThrow('invalid Matrix workflow file response');
    expect(state.mutations()).toEqual([]);
  });

  it('rejects missing admin or App installation before dispatch or ruleset mutation', async () => {
    const noAdmin = new ActivateState();
    noAdmin.admin = false;
    await expect(prepareActivate(noAdmin.transport, {
      owner: 'splrad', repository: 'example', pullRequest: 3,
    })).rejects.toThrow('administrator');
    expect(noAdmin.mutations()).toEqual([]);

    const noApp = new ActivateState();
    noApp.appInstalled = false;
    await expect(prepareActivate(noApp.transport, {
      owner: 'splrad', repository: 'example', pullRequest: 3,
    })).rejects.toThrow('installation');
    expect(noApp.mutations()).toEqual([]);
  });

  it('executes the already prepared create request without changing its body', async () => {
    const state = new ActivateState();
    state.rulesets = [];
    const prepared = await prepareActivate(state.transport, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(prepared.status).toBe('ready');
    const plan = (prepared as { status: 'ready'; plan: ActivateRulesetPlan }).plan;
    const report = await executeActivate(state.transport, plan);
    expect(report).toMatchObject({ action: 'created', rulesetId: 11, rulesetName: 'SPLRAD Steward' });
    expect(state.mutations()).toEqual([{
      method: 'POST', path: '/repos/splrad/example/rulesets', body: plan.requestBody,
    }]);
  });
});
