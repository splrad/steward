import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { stewardCheckExternalId } from '../packages/core/src/index.js';
import { runDoctor } from '../packages/cli/src/doctor.js';
import { parseArguments } from '../packages/cli/src/main.js';
import { GitHubApiError, type GitHubRequest, type GitHubTransport } from '../packages/github/src/index.js';
import { manifestDigest, type ClassificationConfiguration, type StewardManifest } from '../packages/manifest/src/index.js';

const sha = 'a'.repeat(40);
const classification = JSON.parse(await readFile(
  new URL('./fixtures/cadfontautoreplace/classification.json', import.meta.url),
  'utf8',
)) as ClassificationConfiguration;

function manifest(): StewardManifest {
  return {
    $schema: `https://raw.githubusercontent.com/splrad/steward/${sha}/schema/steward.schema.json`,
    schemaVersion: 1,
    automation: {
      githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
      maintainers: { source: 'organization-team', teamSlug: 'maintainers' },
      language: 'zh-CN',
    },
    features: {
      prAutomation: false, classification: true, dcoAdvisory: false, governance: true,
      copilotReview: true, release: true, webhookRelay: true,
    },
    release: { triggerPaths: ['release/version.json'], runner: 'ubuntu-latest', adapterCommand: ['node', '.github/steward/release.mjs'] },
    classification,
  };
}

function transportFor(overrides: Partial<Record<string, unknown>> = {}): { transport: GitHubTransport; requests: GitHubRequest[] } {
  const requests: GitHubRequest[] = [];
  const body = JSON.stringify(manifest());
  const workflow = (name: string) => Buffer.from(`jobs:\n  call:\n    uses: splrad/steward/.github/workflows/${name}@${sha}\n`).toString('base64');
  const handler = (request: GitHubRequest): unknown => {
    if (request.path in overrides) {
      const override = overrides[request.path];
      if (override instanceof Error) throw override;
      return override;
    }
    if (request.path === '/repos/splrad/example') return { id: 7, full_name: 'splrad/example', default_branch: 'main', owner: { login: 'splrad', type: 'Organization' } };
    if (request.path.endsWith('/contents/.github/steward.json')) return { type: 'file', encoding: 'base64', content: Buffer.from(body).toString('base64'), sha: 'blob' };
    const called = request.path.match(/contents\/\.github\/workflows\/(.+)$/)?.[1];
    if (called) return { type: 'file', encoding: 'base64', content: workflow(decodeURIComponent(called)) };
    if (request.path.endsWith('/actions/secrets')) return { secrets: [
      { name: 'WORKFLOW_AUTOMATION_APP_PRIVATE_KEY' }, { name: 'COPILOT_REVIEW_REQUEST_TOKEN' }, { name: 'CORE_AUTO_APPROVAL_TOKEN' },
    ] };
    if (request.path.endsWith('/actions/variables')) return { variables: [{ name: 'WORKFLOW_AUTOMATION_APP_CLIENT_ID', value: 'Iv23liuSr0qd4WLJdZhH' }] };
    if (request.path === '/orgs/splrad/installations') return { installations: [{
      id: 9, app_id: 42, app_slug: 'splrad-steward', client_id: 'Iv23liuSr0qd4WLJdZhH', repository_selection: 'selected', suspended_at: null,
      permissions: { checks: 'write', contents: 'write', pull_requests: 'write', issues: 'write', members: 'read', actions: 'write' },
    }] };
    if (request.path.endsWith('/pulls')) return [{ number: 3, state: 'open', base: { ref: 'main' }, head: { sha } }];
    if (request.path.endsWith(`/commits/${sha}/check-runs`)) return { check_runs: [{
      id: 11, name: 'PR Validation Matrix Gate', status: 'completed', conclusion: 'success', app: { id: 42, slug: 'splrad-steward' },
      external_id: stewardCheckExternalId({ repositoryId: 7, prNumber: 3, headSha: sha, checkId: 'validation-matrix', configDigest: manifestDigest(manifest()), inputDigest: 'c'.repeat(64) }),
    }] };
    if (request.path.endsWith('/rulesets')) return [{ id: 5 }];
    if (request.path.endsWith('/rulesets/5')) return {
      id: 5, target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'PR Validation Matrix Gate', integration_id: 42 }] } }],
    };
    if (request.path.endsWith('/actions/runs')) return { workflow_runs: [{ id: 21, status: 'completed', conclusion: 'success', event: 'repository_dispatch' }] };
    if (request.path.endsWith('/contents/.github/steward/release.mjs')) return { type: 'file' };
    throw new Error(`Unexpected request: ${request.path}`);
  };
  return { requests, transport: { async request<T>(request: GitHubRequest) { requests.push(request); return handler(request) as T; } } };
}

describe('doctor CLI contract', () => {
  it('accepts only the explicit read-only doctor surface', () => {
    expect(parseArguments(['doctor', '--repo', 'splrad/example', '--pr', '3', '--json']))
      .toEqual({ repository: 'splrad/example', pullRequest: 3, json: true });
    expect(() => parseArguments(['activate', '--repo', 'splrad/example'])).toThrow('Usage');
    expect(() => parseArguments(['doctor', '--repo', 'invalid'])).toThrow('OWNER/REPOSITORY');
    expect(() => parseArguments(['doctor', '--repo', 'splrad/example', '--pr', '0'])).toThrow('positive integer');
  });

  it('reports a fully coherent repository without issuing mutations', async () => {
    const releaseSha = 'd'.repeat(40);
    const setup = transportFor({
      '/repos/splrad/example/contents/.github/workflows/release.yml': {
        type: 'file', encoding: 'base64',
        content: Buffer.from(`jobs:\n  call:\n    uses: splrad/steward/.github/workflows/release.yml@${releaseSha}\n`).toString('base64'),
      },
    });
    const report = await runDoctor(setup.transport, { owner: 'splrad', repository: 'example', pullRequest: 3 });
    expect(report.ok).toBe(true);
    expect(report.counts.fail).toBe(0);
    expect(report.findings.map((item) => item.code)).toContain('ruleset.matrix');
    expect(report.findings.map((item) => item.code)).toContain('release.adapter');
    expect(setup.requests.every((request) => !request.method || request.method === 'GET')).toBe(true);
  });

  it('fails on pin, secret, App Check, and ruleset drift with actionable findings', async () => {
    const setup = transportFor({
      '/repos/splrad/example/actions/secrets': { secrets: [] },
      '/repos/splrad/example/contents/.github/workflows/pr-governance.yml': {
        type: 'file', encoding: 'base64',
        content: Buffer.from(`jobs:\n  call:\n    uses: splrad/steward/.github/workflows/pr-governance.yml@${'d'.repeat(40)}\n`).toString('base64'),
      },
      [`/repos/splrad/example/commits/${sha}/check-runs`]: { check_runs: [] },
      '/repos/splrad/example/rulesets/5': { id: 5, target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['refs/heads/main'] } }, rules: [] },
    });
    const report = await runDoctor(setup.transport, { owner: 'splrad', repository: 'example' });
    expect(report.ok).toBe(false);
    expect(report.findings.filter((item) => item.level === 'fail').map((item) => item.code))
      .toEqual(expect.arrayContaining(['actions.secrets', 'workflow.governance-pins', 'checks.current-head', 'ruleset.matrix']));
    expect(report.findings.filter((item) => item.level === 'fail').every((item) => item.remedy)).toBe(true);
  });

  it('lets an explicit default-branch exclusion override a ruleset include', async () => {
    const setup = transportFor({
      '/repos/splrad/example/rulesets/5': {
        id: 5, target: 'branch', enforcement: 'active',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: ['refs/heads/main'] } },
        rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'PR Validation Matrix Gate', integration_id: 42 }] } }],
      },
    });
    const report = await runDoctor(setup.transport, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'ruleset.matrix')?.level).toBe('fail');
  });

  it('never accepts an arbitrary ruleset integration when App ID evidence is absent', async () => {
    const setup = transportFor({
      '/orgs/splrad/installations': { installations: [{
        id: 9, app_slug: 'splrad-steward', client_id: 'Iv23liuSr0qd4WLJdZhH', suspended_at: null,
        permissions: { checks: 'write', contents: 'write', pull_requests: 'write', issues: 'write', members: 'read', actions: 'write' },
      }] },
      '/repos/splrad/example/pulls': [],
    });
    const report = await runDoctor(setup.transport, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'app.installation')?.level).toBe('fail');
    expect(report.findings.find((item) => item.code === 'ruleset.matrix')?.level).toBe('warning');
  });

  it('normalizes a Windows-style adapter argument before reading repository contents', async () => {
    const configured = manifest();
    configured.release = {
      ...configured.release!,
      adapterCommand: ['pwsh', '.github\\steward\\release.ps1'],
    };
    const setup = transportFor({
      '/repos/splrad/example/contents/.github/steward.json': {
        type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(configured)).toString('base64'), sha: 'blob',
      },
      '/repos/splrad/example/contents/.github/steward/release.ps1': { type: 'file' },
    });
    const report = await runDoctor(setup.transport, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'release.adapter')?.level).toBe('pass');
    expect(setup.requests.map((request) => request.path)).toContain('/repos/splrad/example/contents/.github/steward/release.ps1');
  });

  it('reports unavailable Relay run evidence as a warning instead of aborting doctor', async () => {
    const setup = transportFor({
      '/repos/splrad/example/actions/runs': new GitHubApiError({
        status: 403, method: 'GET', path: '/repos/splrad/example/actions/runs', message: 'Resource not accessible',
      }),
    });
    const report = await runDoctor(setup.transport, { owner: 'splrad', repository: 'example' });
    expect(report.findings.find((item) => item.code === 'relay.dispatch')).toMatchObject({ level: 'warning' });
    expect(report.findings.map((item) => item.code)).toContain('release.adapter');
  });
});
