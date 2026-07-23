import classificationFixture from '../fixtures/cadfontautoreplace/classification.json' with { type: 'json' };
import {
  buildStewardRuntimeDiagnosticsEnvelope,
  canonicalStewardRuntimeDiagnosticsJson,
  canonicalStewardRuntimeDiagnosticsSnapshotJson,
} from '../../packages/core/src/index.js';
import {
  canonicalControlJson,
  controlJsonDigest,
  reconcileClassification,
  reconcileDcoAdvisory,
  type ControlReadPort,
  type InstallationMutationPort,
  type PullRequestControlRoute,
} from '../../packages/control/src/index.js';
import type {
  CheckRunCreate,
  CheckRunUpdate,
  GitHubCheckRun,
  GitHubPullRequest,
} from '../../packages/github/src/index.js';
import {
  canonicalManifestJson,
  encodeBase64Utf8,
  type ClassificationConfiguration,
  type StewardManifest,
} from '../../packages/manifest/src/index.js';

const repository = {
  id: 1_296_724_484,
  owner: 'splrad',
  name: 'steward',
  defaultBranch: 'main',
} as const;
const runtimeIdentity = {
  appId: 4_243_096,
  clientId: 'Iv23liuSr0qd4WLJdZhH',
  appSlug: 'splrad-steward',
} as const;
const manifestBlobSha = 'manifest-workerd-fixed-vector';
const runtimeDiagnostics = buildStewardRuntimeDiagnosticsEnvelope({
  subject: {
    repositoryId: repository.id,
    repositoryFullName: `${repository.owner}/${repository.name}`,
  },
  observedAt: '2026-07-23T00:00:00.000Z',
  diagnostics: {
    controlRevision: {
      stewardCommit: 'a'.repeat(40),
      workerVersionId: 'workerd-version-1',
      workerDeploymentId: 'workerd-deployment-1',
      environment: 'candidate',
    },
    queue: 'ready',
    control: 'ready',
    deadLetterQueue: 'clear',
  },
});

const manifest: StewardManifest = {
  schemaVersion: 1,
  automation: {
    githubApp: {
      clientId: runtimeIdentity.clientId,
      slug: runtimeIdentity.appSlug,
    },
    maintainers: { source: 'organization-team', teamSlug: 'maintainers' },
    language: 'zh-CN',
  },
  features: {
    prAutomation: false,
    classification: true,
    dcoAdvisory: false,
    governance: false,
    copilotReview: false,
    release: false,
    webhookRelay: false,
  },
  classification: classificationFixture as ClassificationConfiguration,
};

const { classification: _classification, ...manifestWithoutClassification } = manifest;
const dcoManifest: StewardManifest = {
  ...manifestWithoutClassification,
  features: {
    ...manifest.features,
    classification: false,
    dcoAdvisory: true,
  },
};

interface MutationTrace {
  kind: string;
  value?: string | number;
}

function materializedCheck(id: number, input: CheckRunCreate | CheckRunUpdate): GitHubCheckRun {
  return {
    id,
    head_sha: 'c'.repeat(40),
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

function inMemoryGitHub(manifestContent: string): {
  port: ControlReadPort & InstallationMutationPort;
  pull: GitHubPullRequest;
  checks: GitHubCheckRun[];
  trace: MutationTrace[];
} {
  const pull: GitHubPullRequest = {
    number: 76,
    state: 'open',
    title: 'feat: workerd classification convergence',
    body: 'Contributor-owned workerd body',
    user: { login: 'core', type: 'User' },
    labels: [{ name: 'documentation' }],
    base: { ref: repository.defaultBranch, sha: 'b'.repeat(40) },
    head: { ref: 'feature/workerd-control', sha: 'c'.repeat(40) },
  };
  const checks: GitHubCheckRun[] = [];
  const trace: MutationTrace[] = [];
  const port: ControlReadPort & InstallationMutationPort = {
    async getRepository() {
      return {
        id: repository.id,
        fullName: `${repository.owner}/${repository.name}`,
        defaultBranch: repository.defaultBranch,
      };
    },
    async getFile() {
      return {
        type: 'file',
        encoding: 'base64',
        content: encodeBase64Utf8(manifestContent),
        sha: manifestBlobSha,
      };
    },
    async getPullRequest() {
      return structuredClone(pull);
    },
    async getUser() {
      return { id: 99, login: `${runtimeIdentity.appSlug}[bot]`, type: 'Bot' };
    },
    async listPullRequestCommits() {
      return [{ sha: 'd'.repeat(40), author: { login: 'core', type: 'User' } }];
    },
    async listPullRequestFiles() {
      return [{ filename: 'src/Options.cs', status: 'modified', sha: 'e'.repeat(40), additions: 3, deletions: 1 }];
    },
    async listCommitCheckRuns() {
      return structuredClone(checks);
    },
    async listIssueComments() {
      return [];
    },
    async getRepositoryLabel(_owner, _name, label) {
      trace.push({ kind: 'repository-label.ensure', value: label });
      return { name: label, color: '000000', description: '' };
    },
    async createRepositoryLabel(_owner, _name, label) {
      trace.push({ kind: 'repository-label.create', value: label.name });
      return { ...label };
    },
    async addIssueLabels(_owner, _name, _number, labels) {
      trace.push({ kind: 'issue-labels.add', value: labels.join(',') });
      const names = new Set((pull.labels ?? []).map((label) => String(label.name ?? '').toLowerCase()));
      for (const label of labels) names.add(label.toLowerCase());
      pull.labels = [...names].sort().map((name) => ({ name }));
    },
    async removeIssueLabel(_owner, _name, _number, label) {
      trace.push({ kind: 'issue-label.remove', value: label });
      pull.labels = (pull.labels ?? []).filter((candidate) => (
        String(candidate.name ?? '').toLowerCase() !== label.toLowerCase()
      ));
    },
    async createCheckRun(_owner, _name, input) {
      trace.push({ kind: 'check-run.create' });
      const check = materializedCheck(100 + checks.length, input);
      checks.push(check);
      return structuredClone(check);
    },
    async updateCheckRun(_owner, _name, checkRunId, input) {
      trace.push({ kind: 'check-run.update', value: checkRunId });
      const check = materializedCheck(checkRunId, input);
      const index = checks.findIndex((candidate) => candidate.id === checkRunId);
      if (index >= 0) checks[index] = check;
      return structuredClone(check);
    },
    async deleteIssueComment() {
      throw new Error('Classification smoke must not delete issue comments');
    },
  };
  return { port, pull, checks, trace };
}

async function fixedVectorResponse(): Promise<Response> {
  const canonicalManifest = canonicalManifestJson(manifest);
  const fixture = inMemoryGitHub(canonicalManifest);
  const originalBody = fixture.pull.body;
  const route = (attemptId: string): PullRequestControlRoute => ({
    repository: { id: repository.id, owner: repository.owner, name: repository.name },
    pullRequest: { number: fixture.pull.number, expectedHeadSha: fixture.pull.head.sha },
    attemptId,
    detailsUrl: 'https://github.com/splrad/steward/actions/runs/76',
  });
  const ports = {
    identity: runtimeIdentity,
    read: fixture.port,
    installation: fixture.port,
  };
  const first = await reconcileClassification(route('workerd-attempt-1'), ports);
  const second = await reconcileClassification(route('workerd-attempt-2'), ports);
  const canonicalPlan = canonicalControlJson(first.plan);
  const dcoCanonicalManifest = canonicalManifestJson(dcoManifest);
  const dcoFixture = inMemoryGitHub(dcoCanonicalManifest);
  const dcoComments = [{
    id: 10,
    user: { id: 99, login: `${runtimeIdentity.appSlug}[bot]`, type: 'Bot' },
    performed_via_github_app: { id: runtimeIdentity.appId, slug: runtimeIdentity.appSlug },
    body: '<!-- workflow:dco-signoff-advisory --> legacy',
  }];
  dcoFixture.port.listPullRequestCommits = async () => [{
    sha: 'd'.repeat(40),
    author: { login: 'core', type: 'User' },
    commit: {
      message: 'feat: signed\n\nSigned-off-by: Core <core@example.com>',
      author: { name: 'Core', email: 'core@example.com' },
    },
  }];
  dcoFixture.port.listIssueComments = async () => structuredClone(dcoComments);
  dcoFixture.port.deleteIssueComment = async (_owner, _name, commentId) => {
    dcoFixture.trace.push({ kind: 'issue-comment.delete', value: commentId });
    const index = dcoComments.findIndex((comment) => comment.id === commentId);
    if (index >= 0) dcoComments.splice(index, 1);
  };
  const dco = await reconcileDcoAdvisory({
    repository: { id: repository.id, owner: repository.owner, name: repository.name },
    pullRequest: { number: dcoFixture.pull.number, expectedHeadSha: dcoFixture.pull.head.sha },
    attemptId: 'workerd-dco-attempt',
    detailsUrl: 'https://github.com/splrad/steward/actions/runs/77',
  }, {
    identity: runtimeIdentity,
    read: dcoFixture.port,
    installation: dcoFixture.port,
  });

  return Response.json({
    runtimeDiagnostics: {
      envelope: JSON.parse(canonicalStewardRuntimeDiagnosticsJson(runtimeDiagnostics)),
      snapshot: JSON.parse(canonicalStewardRuntimeDiagnosticsSnapshotJson(runtimeDiagnostics)),
    },
    canonicalPlan,
    canonicalPlanDigest: await controlJsonDigest(first.plan),
    manifestDigest: first.plan.subject.manifest.configDigest,
    first: {
      planId: first.plan.planId,
      snapshotDigest: first.plan.snapshotDigest,
      pullRequestDigest: first.plan.pullRequestDigest,
      mutations: first.plan.mutations.map((mutation) => ({
        key: mutation.key,
        type: mutation.type,
        ...('mode' in mutation ? { mode: mutation.mode } : {}),
      })),
      receipts: first.receipts.map((receipt) => ({
        key: receipt.key,
        state: receipt.state,
        ...(receipt.resourceId === undefined ? {} : { resourceId: receipt.resourceId }),
      })),
    },
    second: {
      planId: second.plan.planId,
      mutationCount: second.plan.mutations.length,
      receiptCount: second.receipts.length,
    },
    dco: {
      state: dco.result.state,
      mutationKeys: dco.plan.mutations.map((mutation) => mutation.key),
      receipts: dco.receipts.map((receipt) => ({ key: receipt.key, state: receipt.state })),
      remainingComments: dcoComments.length,
      trace: dcoFixture.trace,
    },
    final: {
      labels: (fixture.pull.labels ?? []).map((label) => String(label.name ?? '')).sort(),
      bodyUnchanged: fixture.pull.body === originalBody,
      checks: fixture.checks.map((check) => ({
        id: check.id,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion ?? null,
        appId: check.app?.id ?? null,
      })),
      trace: fixture.trace,
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/smoke') {
      return new Response('Not Found', { status: 404 });
    }
    return await fixedVectorResponse();
  },
};
