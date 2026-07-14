import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  ControlPullRequestHeadMismatchError,
  reconcileClassification,
  reconcileDcoAdvisory,
  type ControlReadPort,
  type InstallationMutationPort,
  type PullRequestControlRoute,
} from '../packages/control/src/index.js';
import type {
  CheckRunCreate,
  CheckRunUpdate,
  GitHubCheckRun,
  GitHubCommit,
  GitHubIssueComment,
  GitHubPullRequest,
} from '../packages/github/src/index.js';
import {
  canonicalManifestJson,
  type ClassificationConfiguration,
  type LoadedManifest,
  type StewardManifest,
} from '../packages/manifest/src/index.js';

const classification = JSON.parse(await readFile(
  new URL('./fixtures/cadfontautoreplace/classification.json', import.meta.url),
  'utf8',
)) as ClassificationConfiguration;

const runtimeIdentity = {
  appId: 4_243_096,
  clientId: 'Iv23liuSr0qd4WLJdZhH',
  appSlug: 'splrad-steward',
} as const;

function loadedManifest(features: Partial<StewardManifest['features']>): LoadedManifest {
  const enabled = {
    prAutomation: false,
    classification: false,
    dcoAdvisory: false,
    governance: false,
    copilotReview: false,
    release: false,
    webhookRelay: false,
    ...features,
  };
  const manifest: StewardManifest = {
    schemaVersion: 1,
    automation: {
      githubApp: { clientId: runtimeIdentity.clientId, slug: runtimeIdentity.appSlug },
      maintainers: { source: 'users', logins: ['core'] },
      language: 'zh-CN',
    },
    features: enabled,
    ...(enabled.classification ? { classification } : {}),
  };
  const canonicalJson = canonicalManifestJson(manifest);
  return {
    manifest,
    canonicalJson,
    configDigest: createHash('sha256').update(canonicalJson).digest('hex'),
    source: { path: '.github/steward.json', ref: 'main', blobSha: 'manifest-sha' },
  };
}

function pull(body = 'Contributor-owned body', labels: string[] = ['documentation']): GitHubPullRequest {
  return {
    number: 7,
    state: 'open',
    title: 'feat: level-triggered control',
    body,
    user: { login: 'core', type: 'User' },
    labels: labels.map((name) => ({ name })),
    base: { ref: 'main', sha: 'b'.repeat(40) },
    head: { ref: 'feature/control', sha: 'c'.repeat(40) },
    requested_reviewers: [],
  };
}

function route(detail: GitHubPullRequest, attempt = 'test-attempt-1'): PullRequestControlRoute {
  return {
    repository: { id: 1_296_724_484, owner: 'splrad', name: 'steward' },
    pullRequest: { number: detail.number, expectedHeadSha: detail.head.sha },
    attemptId: attempt,
    detailsUrl: 'https://github.com/splrad/steward/actions/runs/123',
  };
}

function checkFromInput(
  id: number,
  input: CheckRunCreate | CheckRunUpdate,
  headSha = 'c'.repeat(40),
): GitHubCheckRun {
  return {
    id,
    head_sha: headSha,
    name: input.name,
    status: input.status,
    conclusion: input.conclusion ?? null,
    external_id: input.externalId ?? null,
    details_url: input.detailsUrl ?? null,
    app: { id: runtimeIdentity.appId, slug: runtimeIdentity.appSlug },
    output: {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    },
  };
}

interface FixtureOptions {
  classificationEnabled?: boolean;
  manifestError?: Error;
  filesError?: Error;
  checkListFailures?: number;
  synchronizeInitialCheckLists?: number;
  bodyAfterLabels?: string;
  supersedeAfterPlanStart?: boolean;
  supersedeBeforeFailureWrite?: boolean;
  wrongLeaseResponse?: 'app' | 'head' | 'id';
  cancelCheckIdFailure?: number;
}

function classificationFixture(options: FixtureOptions = {}) {
  const manifest = loadedManifest({ classification: options.classificationEnabled !== false });
  const detail = pull();
  const checks: GitHubCheckRun[] = [];
  const trace: string[] = [];
  const commits: GitHubCommit[] = [{ sha: 'd'.repeat(40), author: { login: 'core' } }];
  let nextCheckId = 100;
  let checkListCalls = 0;
  let superseded = false;
  let releaseInitialCheckLists: (() => void) | undefined;
  const initialCheckListBarrier = options.synchronizeInitialCheckLists
    ? new Promise<void>((resolve) => { releaseInitialCheckLists = resolve; })
    : null;
  const client = {
    async getRepository() {
      trace.push('repository:get');
      return { id: 1_296_724_484, fullName: 'splrad/steward', defaultBranch: 'main' };
    },
    async getFile() {
      trace.push('manifest:get');
      if (options.manifestError) throw options.manifestError;
      return {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(manifest.canonicalJson).toString('base64'),
        sha: manifest.source.blobSha,
      };
    },
    async getPullRequest() {
      trace.push('pull:get');
      return structuredClone(detail);
    },
    async getUser() {
      trace.push('user:get');
      return { id: 99, login: 'splrad-steward[bot]', type: 'Bot' };
    },
    async listPullRequestCommits() {
      trace.push('commits:list');
      return structuredClone(commits);
    },
    async listPullRequestFiles() {
      trace.push('files:list');
      if (options.filesError) throw options.filesError;
      return [{ filename: 'src/Options.cs' }];
    },
    async listCommitCheckRuns() {
      trace.push('checks:list');
      checkListCalls += 1;
      if (checkListCalls <= (options.checkListFailures ?? 0)) {
        throw new Error('checks unavailable');
      }
      if (initialCheckListBarrier && checkListCalls <= (options.synchronizeInitialCheckLists ?? 0)) {
        const snapshot = structuredClone(checks);
        if (checkListCalls === options.synchronizeInitialCheckLists) releaseInitialCheckLists?.();
        await initialCheckListBarrier;
        return snapshot;
      }
      const current = checks.at(-1);
      if (options.supersedeAfterPlanStart && !superseded
        && current?.output?.title === 'PR 分类同步中'
        && String(current.external_id ?? '').includes(':check:pr-class-lease:')) {
        superseded = true;
        checks.push(checkFromInput(999, {
          name: 'PR Classification Gate',
          status: 'in_progress',
          externalId: `splrad-steward:v1:repo:1296724484:pr:7:head:${detail.head.sha}:check:pr-class-lease:config:${'0'.repeat(64)}:input:${'b'.repeat(64)}`,
          title: 'attempt B',
          summary: 'attempt B owns the lease',
        }));
      }
      return structuredClone(checks);
    },
    async listIssueComments() { return [] as GitHubIssueComment[]; },
    async getRepositoryLabel(_owner: string, _repository: string, name: string) {
      trace.push(`label:get:${name}`);
      return { name, color: '000000', description: '' };
    },
    async createRepositoryLabel(_owner: string, _repository: string, label: { name: string; color: string; description: string }) {
      trace.push(`label:create:${label.name}`);
      return label;
    },
    async addIssueLabels(_owner: string, _repository: string, _number: number, labels: readonly string[]) {
      trace.push(`labels:add:${labels.join(',')}`);
      const current = new Set((detail.labels ?? []).map((label) => String(label.name ?? '').toLowerCase()));
      for (const label of labels) current.add(label.toLowerCase());
      detail.labels = [...current].map((name) => ({ name }));
      if (options.bodyAfterLabels !== undefined) detail.body = options.bodyAfterLabels;
    },
    async removeIssueLabel(_owner: string, _repository: string, _number: number, label: string) {
      trace.push(`label:remove:${label}`);
      detail.labels = (detail.labels ?? []).filter((candidate) => (
        String(candidate.name ?? '').toLowerCase() !== label.toLowerCase()
      ));
    },
    async createCheckRun(_owner: string, _repository: string, input: CheckRunCreate) {
      trace.push(`check:create:${input.status}:${input.conclusion ?? ''}`);
      const check = checkFromInput(nextCheckId++, input, detail.head.sha);
      checks.push(check);
      if (!options.wrongLeaseResponse) return check;
      return {
        ...check,
        ...(options.wrongLeaseResponse === 'id' ? { id: check.id + 500 } : {}),
        ...(options.wrongLeaseResponse === 'head' ? { head_sha: 'e'.repeat(40) } : {}),
        ...(options.wrongLeaseResponse === 'app' ? { app: { id: 1, slug: 'foreign-app' } } : {}),
      };
    },
    async updateCheckRun(_owner: string, _repository: string, checkRunId: number, input: CheckRunUpdate) {
      trace.push(`check:update:${checkRunId}:${input.status}:${input.conclusion ?? ''}`);
      if (options.cancelCheckIdFailure === checkRunId && input.conclusion === 'cancelled') {
        throw new Error('injected duplicate cancellation failure');
      }
      if (options.supersedeBeforeFailureWrite && input.conclusion === 'failure' && !superseded) {
        superseded = true;
        checks.push(checkFromInput(999, {
          name: 'PR Classification Gate',
          status: 'in_progress',
          externalId: `splrad-steward:v1:repo:1296724484:pr:7:head:${detail.head.sha}:check:pr-class-lease:config:${'0'.repeat(64)}:input:${'b'.repeat(64)}`,
          title: 'attempt B',
          summary: 'attempt B owns the lease',
        }));
      }
      const check = checkFromInput(checkRunId, input, detail.head.sha);
      const index = checks.findIndex((candidate) => candidate.id === checkRunId);
      if (index >= 0) checks[index] = check;
      if (!options.wrongLeaseResponse || input.status !== 'in_progress'
        || !String(input.externalId ?? '').includes(':check:pr-class-lease:')) return check;
      return {
        ...check,
        ...(options.wrongLeaseResponse === 'id' ? { id: check.id + 500 } : {}),
        ...(options.wrongLeaseResponse === 'head' ? { head_sha: 'e'.repeat(40) } : {}),
        ...(options.wrongLeaseResponse === 'app' ? { app: { id: 1, slug: 'foreign-app' } } : {}),
      };
    },
    async deleteIssueComment() { throw new Error('unexpected issue comment deletion'); },
  };
  return {
    manifest,
    detail,
    checks,
    trace,
    client: client as unknown as ControlReadPort & InstallationMutationPort,
    addCheck(check: GitHubCheckRun) { checks.push(check); },
  };
}

function oldSuccess(id = 90, externalId = 'legacy-exact-success'): GitHubCheckRun {
  return checkFromInput(id, {
    name: 'PR Classification Gate',
    status: 'completed',
    conclusion: 'success',
    externalId,
    title: 'old success',
    summary: 'old success',
  });
}

function oldPending(id = 80, externalId = 'legacy-pending-lease'): GitHubCheckRun {
  return checkFromInput(id, {
    name: 'PR Classification Gate',
    status: 'in_progress',
    externalId,
    title: 'old pending lease',
    summary: 'old pending lease',
  });
}

function ports(fixture: ReturnType<typeof classificationFixture>) {
  return { identity: runtimeIdentity, read: fixture.client, installation: fixture.client };
}

describe('Classification Control reconcile', () => {
  it('rejects surrounding whitespace in an expected head before any GitHub read', async () => {
    const fixture = classificationFixture();
    const invalidRoute = route(fixture.detail);
    invalidRoute.pullRequest.expectedHeadSha = ` ${fixture.detail.head.sha} `;

    await expect(reconcileClassification(invalidRoute, ports(fixture)))
      .rejects.toThrow('invalid expected pull request head SHA');
    expect(fixture.trace).toEqual([]);
  });

  it('creates a new attempt generation before Manifest/evidence reads without rewriting terminal history', async () => {
    const fixture = classificationFixture();
    fixture.addCheck(oldSuccess());
    const originalBody = fixture.detail.body;

    const result = await reconcileClassification(route(fixture.detail), ports(fixture));

    const firstCheckWrite = fixture.trace.findIndex((entry) => entry.startsWith('check:create:'));
    expect(firstCheckWrite).toBeGreaterThanOrEqual(0);
    expect(firstCheckWrite).toBeLessThan(fixture.trace.indexOf('manifest:get'));
    expect(firstCheckWrite).toBeLessThan(fixture.trace.indexOf('commits:list'));
    expect(firstCheckWrite).toBeLessThan(fixture.trace.indexOf('files:list'));
    expect(fixture.trace[firstCheckWrite]).toBe('check:create:in_progress:');
    expect(fixture.trace).not.toContain('check:update:90:completed:cancelled');
    expect(fixture.trace.at(-1)).toBe('check:update:100:completed:success');
    expect(result.result.state).toBe('passed');
    expect(result.plan.mutations[0]).toMatchObject({ mode: 'update', checkRunId: 100 });
    expect(result.plan.mutations.at(-1)).toMatchObject({ mode: 'update', checkRunId: 100 });
    expect(fixture.detail.body).toBe(originalBody);
    expect(fixture.trace.some((entry) => entry.includes('pull-body'))).toBe(false);
    expect(fixture.checks.find((check) => check.id === 90)?.conclusion).toBe('success');
    expect(fixture.checks.at(-1)?.output?.summary).toContain('Kind: kind:feature');
  });

  it('finishes the leased Check as failure when the default-branch Manifest cannot be read', async () => {
    const fixture = classificationFixture({ manifestError: new Error('manifest unavailable') });
    fixture.addCheck(oldSuccess());

    await expect(reconcileClassification(route(fixture.detail), ports(fixture)))
      .rejects.toThrow('manifest unavailable');

    expect(fixture.trace.indexOf('check:create:in_progress:')).toBeLessThan(fixture.trace.indexOf('manifest:get'));
    expect(fixture.trace).not.toContain('check:update:90:completed:cancelled');
    expect(fixture.trace).toContain('check:update:100:completed:failure');
    expect(fixture.trace).not.toContain('commits:list');
    expect(fixture.trace).not.toContain('files:list');
    expect(fixture.trace.some((entry) => entry.startsWith('labels:') || entry.startsWith('label:remove'))).toBe(false);
  });

  it('creates an emergency failure generation when the initial Check inventory read fails', async () => {
    const fixture = classificationFixture({ checkListFailures: 1 });
    fixture.addCheck(oldSuccess());

    await expect(reconcileClassification(route(fixture.detail), ports(fixture)))
      .rejects.toThrow('checks unavailable');

    expect(fixture.trace.slice(0, 4)).toEqual([
      'repository:get', 'pull:get', 'checks:list', 'check:create:in_progress:',
    ]);
    expect(fixture.trace).not.toContain('manifest:get');
    expect(fixture.checks.find((check) => check.id === 90)?.conclusion).toBe('success');
    expect(fixture.checks.find((check) => check.id === 100)).toMatchObject({
      status: 'completed',
      conclusion: 'failure',
    });
  });

  it('leaves an emergency pending barrier when Check inventory also fails during reporting', async () => {
    const fixture = classificationFixture({ checkListFailures: 2 });
    fixture.addCheck(oldSuccess());

    await expect(reconcileClassification(route(fixture.detail), ports(fixture)))
      .rejects.toThrow('additionally failed to finalize the Classification lease');

    expect(fixture.checks.find((check) => check.id === 100)).toMatchObject({
      status: 'in_progress',
      conclusion: null,
    });
    expect(fixture.checks.find((check) => check.id === 100)?.external_id)
      .toContain(':check:pr-class-lease:');
  });

  it('creates the lease after an enabled Manifest but before expensive evidence and fails closed on files errors', async () => {
    const fixture = classificationFixture({ filesError: new Error('files unavailable') });

    await expect(reconcileClassification(route(fixture.detail), ports(fixture)))
      .rejects.toThrow('files unavailable');

    const create = fixture.trace.findIndex((entry) => entry === 'check:create:in_progress:');
    expect(create).toBeGreaterThan(fixture.trace.indexOf('manifest:get'));
    expect(create).toBeLessThan(fixture.trace.indexOf('files:list'));
    expect(fixture.trace).toContain('check:update:100:completed:failure');
    expect(fixture.trace.some((entry) => entry.startsWith('labels:') || entry.startsWith('label:remove'))).toBe(false);
  });

  it('does not create a Check or read evidence when Classification is disabled and no old Check exists', async () => {
    const fixture = classificationFixture({ classificationEnabled: false });

    const result = await reconcileClassification(route(fixture.detail), ports(fixture));

    expect(result.result.state).toBe('ignored');
    expect(result.plan.mutations).toEqual([]);
    expect(fixture.trace.some((entry) => entry.startsWith('check:'))).toBe(false);
    expect(fixture.trace).not.toContain('commits:list');
    expect(fixture.trace).not.toContain('files:list');
  });

  it('keeps disabled Classification without managed state independent of a mutation capability', async () => {
    const fixture = classificationFixture({ classificationEnabled: false });

    const result = await reconcileClassification(route(fixture.detail), {
      identity: runtimeIdentity,
      read: fixture.client,
    });

    expect(result.result.state).toBe('ignored');
    expect(result.plan.mutations).toEqual([]);
    expect(fixture.trace.some((entry) => entry.startsWith('check:'))).toBe(false);
  });

  it('explicitly completes an old Check as disabled without reading commits or files', async () => {
    const fixture = classificationFixture({ classificationEnabled: false });
    fixture.addCheck(oldSuccess());

    const result = await reconcileClassification(route(fixture.detail), ports(fixture));

    expect(result.result.state).toBe('ignored');
    expect(result.plan.mutations).toHaveLength(1);
    expect(result.plan.mutations[0]).toMatchObject({ mode: 'update', checkRunId: 100 });
    expect(fixture.trace).toContain('check:create:in_progress:');
    expect(fixture.trace).not.toContain('check:update:90:completed:cancelled');
    expect(fixture.trace).toContain('check:update:100:completed:success');
    expect(fixture.trace).not.toContain('commits:list');
    expect(fixture.trace).not.toContain('files:list');
  });

  it('ignores a stale event head before any Check mutation', async () => {
    const fixture = classificationFixture();
    const stale = route(fixture.detail);
    stale.pullRequest.expectedHeadSha = 'e'.repeat(40);

    await expect(reconcileClassification(stale, ports(fixture)))
      .rejects.toBeInstanceOf(ControlPullRequestHeadMismatchError);
    expect(fixture.trace.some((entry) => entry.startsWith('check:'))).toBe(false);
  });

  it('leaves a foreign App Check untouched and creates its own lease', async () => {
    const fixture = classificationFixture();
    fixture.addCheck({
      ...oldSuccess(80),
      app: { id: 1, slug: 'foreign-app' },
    });

    await reconcileClassification(route(fixture.detail), ports(fixture));

    expect(fixture.trace).toContain('check:create:in_progress:');
    expect(fixture.trace.some((entry) => entry.startsWith('check:update:80:'))).toBe(false);
  });

  it('keeps terminal generations immutable and cancels only an older pending lease', async () => {
    const fixture = classificationFixture();
    for (let id = 10; id < 30; id += 1) fixture.addCheck(oldSuccess(id, `old-exact-${id}`));
    fixture.addCheck(oldPending(70, 'old-pending-70'));
    fixture.addCheck(oldSuccess(80, 'old-exact-80'));
    fixture.addCheck(oldSuccess(90, 'old-exact-90'));

    await reconcileClassification(route(fixture.detail), ports(fixture));

    expect(fixture.trace).toContain('check:create:in_progress:');
    expect(fixture.trace.filter((entry) => entry.endsWith(':completed:cancelled')))
      .toEqual(['check:update:70:completed:cancelled']);
    expect(fixture.trace).not.toContain('check:update:80:completed:cancelled');
    expect(fixture.trace).not.toContain('check:update:90:completed:cancelled');
    expect(fixture.checks.find((check) => check.id === 70)?.conclusion).toBe('cancelled');
    expect(fixture.checks.find((check) => check.id === 80)?.conclusion).toBe('success');
    expect(fixture.checks.find((check) => check.id === 90)?.conclusion).toBe('success');
    expect(fixture.checks.find((check) => check.id === 100)?.conclusion).toBe('success');
  });

  it('leaves a trusted pending lease barrier if duplicate cancellation fails', async () => {
    const fixture = classificationFixture({ cancelCheckIdFailure: 80 });
    fixture.addCheck(oldPending(80, 'old-pending-80'));
    fixture.addCheck(oldSuccess(90, 'old-exact-90'));

    await expect(reconcileClassification(route(fixture.detail), ports(fixture)))
      .rejects.toThrow('injected duplicate cancellation failure');

    const lowerGeneration = fixture.checks.find((check) => check.id === 100);
    expect(lowerGeneration?.conclusion).not.toBe('success');
    expect(lowerGeneration?.status === 'in_progress'
      || (lowerGeneration?.status === 'completed' && lowerGeneration?.conclusion === 'cancelled')).toBe(true);
    expect(fixture.checks.find((check) => check.id === 100)?.external_id).toContain(':check:pr-class-lease:');
  });

  it('lets only the higher Check generation proceed when two attempts acquire from the same empty snapshot', async () => {
    const fixture = classificationFixture({ synchronizeInitialCheckLists: 2 });

    const attempts = await Promise.allSettled([
      reconcileClassification(route(fixture.detail, 'concurrent-attempt-a'), ports(fixture)),
      reconcileClassification(route(fixture.detail, 'concurrent-attempt-b'), ports(fixture)),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === 'fulfilled')).toMatchObject({
      value: { result: { state: 'passed' } },
    });
    expect(String((attempts.find((attempt) => attempt.status === 'rejected') as PromiseRejectedResult).reason))
      .toMatch(/superseded|newer Check Run generation/i);
    expect(fixture.trace.filter((entry) => entry === 'check:create:in_progress:')).toHaveLength(2);
    const lowerGeneration = fixture.checks.find((check) => check.id === 100);
    expect(lowerGeneration?.conclusion).not.toBe('success');
    expect(lowerGeneration?.status === 'in_progress'
      || (lowerGeneration?.status === 'completed' && lowerGeneration?.conclusion === 'cancelled')).toBe(true);
    expect(fixture.checks.find((check) => check.id === 101)).toMatchObject({
      status: 'completed',
      conclusion: 'success',
    });
  });

  it('stops before every derived mutation when a newer attempt supersedes the plan lease', async () => {
    const fixture = classificationFixture({ supersedeAfterPlanStart: true });

    await expect(reconcileClassification(route(fixture.detail), ports(fixture)))
      .rejects.toThrow(/superseded|lease/i);

    expect(fixture.trace.some((entry) => entry.startsWith('label:get:')
      || entry.startsWith('label:create:')
      || entry.startsWith('labels:add:')
      || entry.startsWith('label:remove:'))).toBe(false);
    expect(fixture.checks.at(-1)).toMatchObject({ id: 999, status: 'in_progress' });
  });

  it('can finalize only its own generation when a newer attempt appears during failure reporting', async () => {
    const fixture = classificationFixture({
      filesError: new Error('files unavailable'),
      supersedeBeforeFailureWrite: true,
    });

    await expect(reconcileClassification(route(fixture.detail), ports(fixture)))
      .rejects.toThrow('files unavailable');

    expect(fixture.checks.find((check) => check.id === 100)).toMatchObject({
      status: 'completed',
      conclusion: 'failure',
    });
    expect(fixture.checks.at(-1)).toMatchObject({
      id: 999,
      status: 'in_progress',
      conclusion: null,
    });
  });

  it('preserves a concurrent human body edit and refuses the final success', async () => {
    const humanEdit = 'Human edit made while labels were updating';
    const fixture = classificationFixture({ bodyAfterLabels: humanEdit });

    await expect(reconcileClassification(route(fixture.detail), ports(fixture)))
      .rejects.toThrow('no longer matches the Control plan subject');

    expect(fixture.detail.body).toBe(humanEdit);
    expect(fixture.checks.at(-1)?.conclusion).toBe('failure');
    expect(fixture.trace.some((entry) => entry.includes('pull-body'))).toBe(false);
  });

  it('allows legacy marker-only drift while never rewriting the contributor body', async () => {
    const initial = [
      'Contributor-owned body',
      '',
      '<!-- workflow:pr-classification:start',
      'areas=area:runtime',
      'kind=kind:feature',
      'visible-labels=feature',
      'release-labels=security',
      'workflow:pr-classification:end -->',
    ].join('\n');
    const changedMarker = initial.replace('release-labels=security', 'release-labels=feature');
    const fixture = classificationFixture({ bodyAfterLabels: changedMarker });
    fixture.detail.body = initial;

    const result = await reconcileClassification(route(fixture.detail), ports(fixture));

    expect(result.result.state).toBe('passed');
    expect(fixture.detail.body).toBe(changedMarker);
    const details = result.result.details as { evaluation: { presentation: { releaseLabels: string[] } } };
    expect(details.evaluation.presentation.releaseLabels).not.toContain('security');
  });

  it.each(['app', 'head', 'id'] as const)(
    'rejects a lease mutation response outside the bound %s identity',
    async (wrongLeaseResponse) => {
      const fixture = classificationFixture({ wrongLeaseResponse });
      await expect(reconcileClassification(route(fixture.detail), ports(fixture)))
        .rejects.toThrow(/outside its bound identity|superseded before acquisition/);
      expect(fixture.trace.some((entry) => entry.startsWith('labels:') || entry.startsWith('label:remove'))).toBe(false);
      expect(fixture.checks.find((check) => check.id === 100)).toMatchObject({
        status: 'in_progress',
        conclusion: null,
      });
      expect(fixture.checks.find((check) => check.id === 100)?.external_id)
        .toContain(':check:pr-class-lease:');
    },
  );
});

describe('DCO Control reconcile', () => {
  it('loads the default-branch Manifest and deletes only the bound App legacy comment', async () => {
    const manifest = loadedManifest({ dcoAdvisory: true });
    const detail = pull('', []);
    const comments: GitHubIssueComment[] = [{
      id: 10,
      body: '<!-- workflow:dco-signoff-advisory --> old',
      user: { id: 99, login: 'splrad-steward[bot]', type: 'Bot' },
    }];
    const deleted: number[] = [];
    const client = {
      async getRepository() { return { id: 1_296_724_484, fullName: 'splrad/steward', defaultBranch: 'main' }; },
      async getFile() {
        return {
          type: 'file', encoding: 'base64', content: Buffer.from(manifest.canonicalJson).toString('base64'), sha: manifest.source.blobSha,
        };
      },
      async getPullRequest() { return structuredClone(detail); },
      async getUser() { return { id: 99, login: 'splrad-steward[bot]', type: 'Bot' }; },
      async listPullRequestCommits() {
        return [{
          sha: 'd'.repeat(40),
          author: { login: 'core', type: 'User' },
          commit: {
            message: 'feat: signed\n\nSigned-off-by: Core <core@example.com>',
            author: { name: 'Core', email: 'core@example.com' },
          },
        }];
      },
      async listPullRequestFiles() { return []; },
      async listCommitCheckRuns() { return []; },
      async listIssueComments() { return structuredClone(comments); },
      async getRepositoryLabel() { throw new Error('unexpected label read'); },
      async createRepositoryLabel() { throw new Error('unexpected label create'); },
      async addIssueLabels() { throw new Error('unexpected label add'); },
      async removeIssueLabel() { throw new Error('unexpected label remove'); },
      async createCheckRun() { throw new Error('unexpected Check create'); },
      async updateCheckRun() { throw new Error('unexpected Check update'); },
      async deleteIssueComment(_owner: string, _repository: string, commentId: number) {
        deleted.push(commentId);
        comments.splice(comments.findIndex((comment) => comment.id === commentId), 1);
      },
    } as unknown as ControlReadPort & InstallationMutationPort;

    const result = await reconcileDcoAdvisory(route(detail, 'dco-attempt'), {
      identity: runtimeIdentity,
      read: client,
      installation: client,
    });

    expect(result.result.state).toBe('passed');
    expect(deleted).toEqual([10]);
  });
});
