import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
const modulePath = '../../../scripts/verify-legacy-runtime-retirement.mjs';
const { verifyLegacyRuntimeRetirement } = await import(modulePath);
const input = { url: 'https://runtime.test/', version: '11111111-1111-4111-8111-111111111111', policySha: 'a'.repeat(40), evaluatorSha: 'b'.repeat(40) };
const health = { status: 'ok', version: input.version, policySha: input.policySha, evaluatorSha: input.evaluatorSha, organizationId: 302208797, appId: 4243096, secretsReady: true };
describe('maintenance deployment retirement probe', () => {
  it.each([
    { ...input, url: 'https://runtime.test:8443/' },
    { ...input, version: 'a'.repeat(36) },
    { ...input, version: '-'.repeat(36) },
  ])('rejects malformed input before network: %j', async invalid => {
    const transport = vi.fn();
    await expect(verifyLegacyRuntimeRetirement(invalid, transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('accepts reordered identity fields and unrelated health metadata', async () => {
    let reads = 0;
    await expect(verifyLegacyRuntimeRetirement(input, async (url: URL) => url.pathname !== '/health'
      ? Response.json({ error: 'LEGACY_RELEASE_RETIRED' }, { status: 410, headers: { 'cache-control': 'no-store' } })
      : Response.json(++reads === 1 ? health : { note: 'additional metadata', ...Object.fromEntries(Object.entries(health).reverse()) })))
      .resolves.toMatchObject({ status: 'verified' });
  });
  it.each(['status', 'policySha', 'evaluatorSha', 'organizationId', 'appId', 'secretsReady'])('rejects changed required health field %s', async field => {
    let reads = 0;
    await expect(verifyLegacyRuntimeRetirement(input, async (url: URL) => url.pathname !== '/health'
      ? Response.json({ error: 'LEGACY_RELEASE_RETIRED' }, { status: 410, headers: { 'cache-control': 'no-store' } })
      : Response.json(++reads === 1 ? health : { ...health, [field]: null }))).rejects.toThrow('changed during');
  });

  it('requires matching identity and effective unauthenticated retired route', async () => {
    const seen: string[] = [];
    const result = await verifyLegacyRuntimeRetirement(input, async (url: URL, init: RequestInit) => {
      seen.push(url.pathname); expect(init.method).toBe('GET'); expect(init.redirect).toBe('error');
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
      return url.pathname === '/health' ? Response.json(health) : Response.json({ error: 'LEGACY_RELEASE_RETIRED' }, { status: 410, headers: { 'cache-control': 'no-store' } });
    });
    expect(result.status).toBe('verified'); expect(seen).toHaveLength(3);
  });
  it.each([200, 401, 403, 404, 500])('rejects old route status %s even with healthy Worker', async status => {
    await expect(verifyLegacyRuntimeRetirement(input, async (url: URL) => url.pathname === '/health' ? Response.json(health) : Response.json({}, { status }))).rejects.toThrow('retirement is not effective');
  });
  it('rejects wrong version and deployment changes', async () => {
    await expect(verifyLegacyRuntimeRetirement(input, async () => Response.json({ ...health, version: 'other' }))).rejects.toThrow('identity mismatch');
    let reads = 0;
    await expect(verifyLegacyRuntimeRetirement(input, async (url: URL) => url.pathname !== '/health'
      ? Response.json({ error: 'LEGACY_RELEASE_RETIRED' }, { status: 410, headers: { 'cache-control': 'no-store' } })
      : Response.json(++reads === 1 ? health : { ...health, version: 'other' }))).rejects.toThrow('changed during');
  });
});

const deployModulePath = '../../../scripts/deploy-legacy-runtime.mjs';
const { runDeploymentTransaction } = await import(deployModulePath);
describe('actual maintenance deployment success path', () => {
  it('never probes or returns success after a failed deployment', async () => {
    const probe = vi.fn();
    await expect(runDeploymentTransaction(async () => { throw new Error('deploy failed'); }, probe)).rejects.toThrow('deploy failed');
    expect(probe).not.toHaveBeenCalled();
  });
  it('does not return success after a failed retirement probe', async () => {
    await expect(runDeploymentTransaction(async () => ({ version: input.version }), async () => { throw new Error('probe failed'); })).rejects.toThrow('probe failed');
  });
  it('rejects missing or mismatched probe evidence', async () => {
    for (const evidence of [undefined, { status: 'verified', version: 'other' }]) {
      await expect(runDeploymentTransaction(async () => ({ version: input.version }), async () => evidence)).rejects.toThrow('did not verify');
    }
  });
  it('returns only a probed barrier, not an inflight handover assertion', async () => {
    expect(await runDeploymentTransaction(async () => ({ version: input.version }), async () => ({ status: 'verified', version: input.version })))
      .toEqual({ status: 'barrier-installed-and-probed', version: input.version });
  });
});


const { readAdoptionRecord, verifyAdoptionSource, verifyNativeTarget } = await import(deployModulePath);
const reviewBody = '<!-- ccr-overview-v2 -->\n### Changes recommended\n<sub>Review effort: Lite</sub>';
const adoption = () => ({
  schemaVersion: 1, repository: 'splrad/steward', pullNumber: 400,
  reviewedHead: 'a'.repeat(40), deploymentHead: 'a'.repeat(40), reviewedTree: 'c'.repeat(40), deploymentTree: 'c'.repeat(40),
  bundleSha256: 'd'.repeat(64), policySha: 'e'.repeat(40), evaluatorSha: 'f'.repeat(40),
  accountId: '5efbba9a3813a37ac45e70cfa9f01cb5', workerName: 'splrad-steward-runtime',
  runtimeOrigin: 'https://splrad-steward-runtime.synthetic.workers.dev', expectedCurrentVersion: input.version,
  evidence: { validationRunId: 1, copilotRunId: 2, copilotReviewId: 3, codexCommentId: 4, copilotCheckRunId: 5, copilotReviewBodySha256: createHash('sha256').update(reviewBody).digest('hex'), reviewDecisionReference: 'SYNTHETIC CENTRAL ADJUDICATION' },
  window: { status: 'confirmed', reference: 'SYNTHETIC TEST ONLY', expiresAt: '2099-01-01T00:00:00Z' },
});
function adoptionFixture() {
  const record = adoption();
  const pull = { number: record.pullNumber, repository: { nameWithOwner: record.repository }, state: 'OPEN', isDraft: false, headRefOid: record.reviewedHead, mergeCommit: { oid: 'b'.repeat(40) } };
  const api = vi.fn(async (path: string): Promise<any> => {
    if (path.startsWith('commits/')) return { sha: path.slice(8), commit: { tree: { sha: record.reviewedTree }, verification: { verified: true, reason: 'valid' } } };
    if (path.startsWith('actions/runs/')) return { repository: { full_name: record.repository }, head_sha: record.reviewedHead, status: 'completed', conclusion: 'success', path: path === 'actions/runs/1' ? '.github/workflows/pr-validation.yml' : 'dynamic/agents/copilot-pull-request-reviewer', event: 'dynamic', check_suite_id: 100, pull_requests: [{ number: record.pullNumber, head: { sha: record.reviewedHead } }] };
    if (path.startsWith('check-runs/')) return { name: 'copilot-pull-request-reviewer', app: { id: 15368 }, head_sha: record.reviewedHead, status: 'completed', conclusion: 'success', check_suite: { id: 100 }, pull_requests: [{ number: record.pullNumber, head: { sha: record.reviewedHead } }] };
    if (path.startsWith('pulls/')) return { state: 'COMMENTED', body: reviewBody, commit_id: record.reviewedHead, user: { login: 'copilot-pull-request-reviewer[bot]' }, submitted_at: '2026-01-01T00:00:00Z' };
    return { user: { login: 'chatgpt-codex-connector[bot]' }, issue_url: `https://api.github.com/repos/${record.repository}/issues/${record.pullNumber}`,
      body: `<!-- codex-review-state:v1 ${JSON.stringify(Object.fromEntries(['code_review', 'security_review'].map(key => [key, { commit_sha: record.reviewedHead, status: 'completed', has_any_findings: null }]))) } -->` };
  });
  return { record, pull, api };
}

describe('central adoption record and native deployment identity', () => {
  it('accepts a future PR reviewed head and its native merged commit only when trees match', async () => {
    const f = adoptionFixture();
    await expect(verifyAdoptionSource(f.record, f.api, f.pull)).resolves.toBeUndefined();
    f.record.deploymentHead = f.pull.mergeCommit.oid; f.pull.state = 'MERGED';
    await expect(verifyAdoptionSource(f.record, f.api, f.pull)).resolves.toBeUndefined();
  });
  it.each(['head', 'merge', 'tree', 'signature', 'ci', 'copilot', 'codex', 'checkApp', 'checkPR', 'checkSuite', 'runPath', 'reviewState', 'reviewBody', 'incompleteReview'])('rejects altered adoption evidence: %s', async mode => {
    const f = adoptionFixture(), original = f.api.getMockImplementation()!;
    if (mode === 'head') f.pull.headRefOid = 'b'.repeat(40);
    if (mode === 'merge') f.record.deploymentHead = 'b'.repeat(40);
    f.api.mockImplementation(async path => {
      const value = await original(path);
      if (mode === 'tree' && path.startsWith('commits/')) value.commit.tree.sha = 'b'.repeat(40);
      if (mode === 'signature' && path.startsWith('commits/')) value.commit.verification.verified = false;
      if (mode === 'ci' && path === 'actions/runs/1') value.conclusion = 'failure';
      if (mode === 'copilot' && path.startsWith('pulls/')) value.commit_id = 'b'.repeat(40);
      if (mode === 'codex' && path.startsWith('issues/')) value.body = value.body.replaceAll('completed', 'running');
      if (mode === 'checkApp' && path.startsWith('check-runs/')) value.app.id = 1;
      if (mode === 'checkPR' && path.startsWith('check-runs/')) value.pull_requests[0].number++;
      if (mode === 'checkSuite' && path.startsWith('check-runs/')) value.check_suite.id++;
      if (mode === 'runPath' && path === 'actions/runs/2') value.path = '.github/workflows/native-review.yml';
      if (mode === 'reviewState' && path.startsWith('pulls/')) value.state = 'DISMISSED';
      if (mode === 'reviewBody' && path.startsWith('pulls/')) value.body = '';
      if (mode === 'incompleteReview' && path.startsWith('pulls/')) {
        value.body += '\nCopilot was unable to run its full agentic suite in this review.';
        f.record.evidence.copilotReviewBodySha256 = createHash('sha256').update(value.body).digest('hex');
      }
      return value;
    });
    await expect(verifyAdoptionSource(f.record, f.api, f.pull)).rejects.toThrow();
  });
  it('binds the native account origin, enabled script and sole 100% active version', () => {
    const r = adoption(), metadata = { subdomain: { subdomain: 'synthetic' }, script: { enabled: true }, deployments: { deployments: [{ versions: [{ version_id: input.version, percentage: 100 }] }] } };
    expect(() => verifyNativeTarget(r, metadata)).not.toThrow();
    expect(() => verifyNativeTarget({ ...r, runtimeOrigin: 'https://splrad-steward-runtime.attacker.workers.dev' }, metadata)).toThrow();
    expect(() => verifyNativeTarget(r, { ...metadata, script: { enabled: false } })).toThrow();
    expect(() => verifyNativeTarget(r, metadata, '22222222-2222-4222-8222-222222222222')).toThrow();
    metadata.deployments.deployments[0]!.versions[0]!.percentage = 50;
    expect(() => verifyNativeTarget(r, metadata)).toThrow();
  });
  it('requires an external record and rejects pending/expired windows or incomplete evidence', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'steward-adoption-test-'));
    const checkout = join(directory, 'candidate'), file = join(directory, 'record.json');
    await mkdir(checkout);
    try {
      const record = adoption(); await writeFile(file, JSON.stringify(record));
      await expect(readAdoptionRecord(file, checkout)).resolves.toMatchObject({ pullNumber: 400 });
      const internal = join(checkout, 'record.json'); await writeFile(internal, JSON.stringify(record));
      await expect(readAdoptionRecord(internal, checkout)).rejects.toThrow('outside');
      for (const invalid of [
        { ...record, window: { ...record.window, status: 'pending' } },
        { ...record, window: { ...record.window, expiresAt: '2020-01-01T00:00:00Z' } },
        { ...record, deploymentTree: 'b'.repeat(40) },
        { ...record, evidence: { ...record.evidence, validationRunId: 0 } },
      ]) {
        await writeFile(file, JSON.stringify(invalid));
        await expect(readAdoptionRecord(file, checkout)).rejects.toThrow();
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
