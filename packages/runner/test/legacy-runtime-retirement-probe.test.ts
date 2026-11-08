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
  reviewedHead: 'a'.repeat(40), deploymentHead: 'b'.repeat(40), reviewedTree: 'c'.repeat(40), deploymentTree: 'c'.repeat(40),
  bundleSha256: 'd'.repeat(64), policySha: 'e'.repeat(40), evaluatorSha: 'f'.repeat(40),
  accountId: '5efbba9a3813a37ac45e70cfa9f01cb5', workerName: 'splrad-steward-runtime',
  runtimeOrigin: 'https://splrad-steward-runtime.synthetic.workers.dev', expectedCurrentVersion: input.version,
  evidence: { validationRunId: 1, copilotRunId: 2, copilotReviewId: 3, codexCommentId: 4, copilotCheckRunId: 5, copilotReviewBodySha256: createHash('sha256').update(reviewBody).digest('hex'), reviewDecisionReference: 'SYNTHETIC CENTRAL ADJUDICATION' },
  window: { status: 'confirmed', reference: 'SYNTHETIC TEST ONLY', expiresAt: '2099-01-01T00:00:00Z' },
});
function adoptionFixture() {
  const record = adoption();
  const pull = { number: record.pullNumber, repository: { nameWithOwner: record.repository }, headRepository: { nameWithOwner: record.repository }, baseRefName: 'maintenance/legacy-runtime-e990eda', state: 'MERGED', isDraft: false, headRefOid: record.reviewedHead, mergeCommit: { oid: record.deploymentHead } };
  const api = vi.fn(async (path: string): Promise<any> => {
    if (path.startsWith('actions/runs?')) return { total_count: 2, workflow_runs: [await api('actions/runs/1'), await api('actions/runs/2')] };
    if (path.includes('/check-runs?')) return { total_count: 1, check_runs: [await api('check-runs/5')] };
    if (path.includes('/reviews?')) return [await api(`pulls/${record.pullNumber}/reviews/3`)];
    if (path.startsWith('commits/')) return { sha: path.slice(8), commit: { tree: { sha: record.reviewedTree }, verification: { verified: true, reason: 'valid' } } };
    if (path.startsWith('actions/runs/')) return { id: Number(path.split('/').at(-1)), created_at: '2026-01-01T00:00:00Z', run_started_at: '2026-01-01T00:00:00Z', repository: { full_name: record.repository }, head_sha: record.reviewedHead, status: 'completed', conclusion: 'success', path: path === 'actions/runs/1' ? '.github/workflows/pr-validation.yml' : 'dynamic/agents/copilot-pull-request-reviewer', event: 'dynamic', check_suite_id: 100, pull_requests: [{ number: record.pullNumber, head: { sha: record.reviewedHead } }] };
    if (path.startsWith('check-runs/')) return { id: 5, started_at: '2026-01-01T00:00:00Z', name: 'copilot-pull-request-reviewer', app: { id: 15368 }, head_sha: record.reviewedHead, status: 'completed', conclusion: 'success', check_suite: { id: 100 }, pull_requests: [{ number: record.pullNumber, head: { sha: record.reviewedHead } }] };
    if (path.startsWith('pulls/')) return { id: 3, state: 'COMMENTED', body: reviewBody, commit_id: record.reviewedHead, user: { login: 'copilot-pull-request-reviewer[bot]' }, submitted_at: '2026-01-01T00:00:00Z' };
    return { user: { login: 'chatgpt-codex-connector[bot]' }, issue_url: `https://api.github.com/repos/${record.repository}/issues/${record.pullNumber}`,
      body: `<!-- codex-review-state:v1 ${JSON.stringify(Object.fromEntries(['code_review', 'security_review'].map(key => [key, { commit_sha: record.reviewedHead, status: 'completed', has_any_findings: null }]))) } -->` };
  });
  return { record, pull, api };
}

describe('central adoption record and native deployment identity', () => {
  it.each(['<sub>Review effort: Lite</sub>', '🧠 **Review effort:** Balanced', '**Review effort:** Max'])('accepts the bound overview format %s', async effort => {
    const f = adoptionFixture(), original = f.api.getMockImplementation()!;
    const body = `<!-- ccr-overview-v2 -->\n### Changes recommended\n${effort}`;
    f.record.evidence.copilotReviewBodySha256 = createHash('sha256').update(body).digest('hex');
    f.api.mockImplementation(async path => {
      const value = await original(path);
      if (/^pulls\/\d+\/reviews\/\d+$/.test(path)) value.body = body;
      return value;
    });
    await expect(verifyAdoptionSource(f.record, f.api, f.pull)).resolves.toBeUndefined();
    f.record.evidence.copilotReviewBodySha256 = '0'.repeat(64);
    await expect(verifyAdoptionSource(f.record, f.api, f.pull)).rejects.toThrow('review mismatch');
  });
  it.each(['**Review effort:** Unknown', '**Review effort:** BalancedExtra', '<sub>Review effort: Lite', 'Review effort: Balanced', '**Review effort:** Balanced\nCopilot was unable to review this pull request.'])('rejects invalid or incomplete overview format %s', async effort => {
    const f = adoptionFixture(), original = f.api.getMockImplementation()!;
    const body = `<!-- ccr-overview-v2 -->\n${effort}`;
    f.record.evidence.copilotReviewBodySha256 = createHash('sha256').update(body).digest('hex');
    f.api.mockImplementation(async path => {
      const value = await original(path);
      if (/^pulls\/\d+\/reviews\/\d+$/.test(path)) value.body = body;
      return value;
    });
    await expect(verifyAdoptionSource(f.record, f.api, f.pull)).rejects.toThrow('review mismatch');
  });
  it('accepts a same-repository PR native merged commit with the reviewed tree', async () => {
    const f = adoptionFixture();
    await expect(verifyAdoptionSource(f.record, f.api, f.pull)).resolves.toBeUndefined();
  });
  it.each(['open', 'closed', 'fork', 'base', 'unmergedHead', 'draft'])('rejects an unadoptable source: %s', async mode => {
    const f = adoptionFixture();
    if (mode === 'open') f.pull.state = 'OPEN';
    if (mode === 'closed') f.pull.state = 'CLOSED';
    if (mode === 'fork') f.pull.headRepository.nameWithOwner = 'other/steward';
    if (mode === 'base') f.pull.baseRefName = 'main';
    if (mode === 'unmergedHead') f.record.deploymentHead = f.record.reviewedHead;
    if (mode === 'draft') f.pull.isDraft = true;
    await expect(verifyAdoptionSource(f.record, f.api, f.pull)).rejects.toThrow('merge identity changed');
    expect(f.api).not.toHaveBeenCalled();
  });
  it.each(['head', 'merge', 'tree', 'signature', 'ci', 'copilot', 'codex', 'checkApp', 'checkPR', 'checkSuite', 'runPath', 'reviewState', 'reviewBody', 'incompleteReview'])('rejects altered adoption evidence: %s', async mode => {
    const f = adoptionFixture(), original = f.api.getMockImplementation()!;
    if (mode === 'head') f.pull.headRefOid = 'b'.repeat(40);
    if (mode === 'merge') f.record.deploymentHead = 'd'.repeat(40);
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
  it.each(['copilotRunning', 'checkRunning', 'newReview', 'validationFailure', 'validationRunning', 'unknownTime', 'tiedTime'])('rejects superseded or uncertain evidence: %s', async mode => {
    const f = adoptionFixture(), original = f.api.getMockImplementation()!;
    f.api.mockImplementation(async path => {
      const value = await original(path);
      if (path.startsWith('actions/runs?') && ['copilotRunning', 'validationFailure', 'validationRunning'].includes(mode)) {
        const newer = { ...value.workflow_runs[mode === 'copilotRunning' ? 1 : 0], id: 20, run_started_at: '2026-01-02T00:00:00Z', status: mode === 'validationFailure' ? 'completed' : 'queued', conclusion: mode === 'validationFailure' ? 'failure' : null };
        value.workflow_runs.push(newer); value.total_count++;
      }
      if (path.includes('/check-runs?') && mode === 'checkRunning') {
        value.check_runs.push({ ...value.check_runs[0], id: 21, started_at: null, status: 'queued' }); value.total_count++;
      }
      if (path.includes('/reviews?') && ['newReview', 'unknownTime', 'tiedTime'].includes(mode)) value.push({ ...value[0], id: 22,
        submitted_at: mode === 'unknownTime' ? null : mode === 'tiedTime' ? value[0].submitted_at : '2026-01-02T00:00:00Z' });
      return value;
    });
    await expect(verifyAdoptionSource(f.record, f.api, f.pull)).rejects.toThrow();
  });
  it('permits earlier failed rounds replaced by the selected successful round and ignores unrelated scope', async () => {
    const f = adoptionFixture(), original = f.api.getMockImplementation()!;
    f.api.mockImplementation(async path => {
      const value = await original(path);
      if (path.startsWith('actions/runs?')) {
        value.workflow_runs.push(...value.workflow_runs.map((v: any, i: number) => ({ ...v, id: 30 + i, run_started_at: '2025-01-01T00:00:00Z', conclusion: 'failure' })),
          { ...value.workflow_runs[0], id: 32, status: 'queued', pull_requests: [{ number: 999, head: { sha: f.record.reviewedHead } }] });
        value.total_count = value.workflow_runs.length;
      }
      if (path.includes('/check-runs?')) {
        value.check_runs.push({ ...value.check_runs[0], id: 33, started_at: '2025-01-01T00:00:00Z', conclusion: 'failure' },
          { ...value.check_runs[0], id: 34, status: 'queued', app: { id: 999 } }); value.total_count = value.check_runs.length;
      }
      if (path.includes('/reviews?')) value.push({ ...value[0], id: 35, submitted_at: '2025-01-01T00:00:00Z', state: 'DISMISSED' },
        { ...value[0], id: 36, submitted_at: '2027-01-01T00:00:00Z', commit_id: 'b'.repeat(40) });
      return value;
    });
    await expect(verifyAdoptionSource(f.record, f.api, f.pull)).resolves.toBeUndefined();
  });
  it.each(['newRun', 'newCheck', 'newReview', 'missing', 'duplicate', 'overLimit'])('reads complete evidence pages and rejects %s', async mode => {
    const f = adoptionFixture(), original = f.api.getMockImplementation()!;
    f.api.mockImplementation(async path => {
      const value = await original(path);
      const endpoint = mode === 'newCheck' ? '/check-runs?' : mode === 'newReview' ? '/reviews?' : 'actions/runs?';
      if (!path.includes(endpoint)) return value;
      const key = mode === 'newCheck' ? 'check_runs' : mode === 'newReview' ? undefined : 'workflow_runs';
      const selected = key ? value[key][key === 'workflow_runs' ? 1 : 0] : value[0];
      const selectedRows = key ? value[key] : value;
      const page1 = [...selectedRows, ...Array.from({ length: 100 - selectedRows.length }, (_, i) => ({ ...selected, id: 1000 + i, head_sha: 'b'.repeat(40), commit_id: 'b'.repeat(40) }))];
      const rows = path.endsWith('page=1') ? page1 : mode === 'missing' ? [] : [{ ...selected, id: mode === 'duplicate' ? 1000 : 2000,
        run_started_at: '2027-01-01T00:00:00Z', started_at: '2027-01-01T00:00:00Z', submitted_at: '2027-01-01T00:00:00Z' }];
      return key ? { total_count: mode === 'overLimit' ? 1001 : 101, [key]: rows } : rows;
    });
    await expect(verifyAdoptionSource(f.record, f.api, f.pull)).rejects.toThrow();
    if (!['overLimit'].includes(mode)) expect(f.api.mock.calls.some(([path]) => path.endsWith('page=2'))).toBe(true);
  });
  it('accepts stable complete multi-page run, check and review collections', async () => {
    const f = adoptionFixture(), original = f.api.getMockImplementation()!;
    f.api.mockImplementation(async path => {
      const value = await original(path);
      const key = path.startsWith('actions/runs?') ? 'workflow_runs' : path.includes('/check-runs?') ? 'check_runs' : undefined;
      if (!key && !path.includes('/reviews?')) return value;
      const selected = key ? value[key] : value;
      const other = (id: number) => ({ ...selected[0], id, head_sha: 'b'.repeat(40), commit_id: 'b'.repeat(40) });
      const rows = path.endsWith('page=1') ? [...selected, ...Array.from({ length: 100 - selected.length }, (_, i) => other(1000 + i))] : [other(2000)];
      return key ? { total_count: 101, [key]: rows } : rows;
    });
    await expect(verifyAdoptionSource(f.record, f.api, f.pull)).resolves.toBeUndefined();
    expect(f.api.mock.calls.filter(([path]) => path.endsWith('page=2'))).toHaveLength(6);
  });
  it('rejects a collection changing between complete reads even if its count stays equal', async () => {
    const f = adoptionFixture(), original = f.api.getMockImplementation()!; let reads = 0;
    f.api.mockImplementation(async path => {
      const value = await original(path);
      if (path.startsWith('actions/runs?') && ++reads === 2) value.workflow_runs[1].run_attempt = 2;
      return value;
    });
    await expect(verifyAdoptionSource(f.record, f.api, f.pull)).rejects.toThrow('changed during pagination');
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
