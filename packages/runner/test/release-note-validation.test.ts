import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classificationDigests, classificationInputDigest } from '../../core/src/index.js';
import { classificationFacts } from '../src/classification-facts.js';
import { classificationCheckStateCodec, decodeClassificationCheckState, encodeClassificationCheckState, main } from '../src/index.js';
import * as github from '../../github/src/index.js';
import { GitHubClient } from '../../github/src/index.js';
import { readFragmentBlob, validateRemoteFragments } from '../src/release-note-validation.js';

const identity = { repositoryId: 1, pullRequestNumber: 2, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), policySha: 'c'.repeat(40) };
const profile = { fragmentDirectory: 'fragments', required: ['src/**'], reviewRequired: [], ignored: ['tests/**'] };
const path = 'fragments/new-fact.json';
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, status: 'not-user-facing', reason: 'Only internal test fixtures have changed.' }));
const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const treeSha = 'd'.repeat(40);
const pullFacts = { number: 2, state: 'open', base: { repo: { id: 1 }, sha: identity.baseSha, ref: 'main' },
  head: { repo: { id: 1 }, sha: identity.headSha, ref: 'change' }, user: { login: 'user', type: 'User' }, changed_files: 2, commits: 1 };
const fileFacts = [{ status: 'modified', filename: 'tests/a.ts', additions: 1, deletions: 0, patch: '+test' },
  { status: 'added', filename: path, additions: 1, deletions: 0, patch: '+fragment' }];
const commitFacts = [{ sha: identity.headSha, commit: { message: 'test: update fixtures' } }];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function fixture(options: { drift?: 'base' | 'head'; count?: number; truncated?: boolean; mode?: string; corrupt?: boolean; status?: string; fileStatus?: string; pagination?: boolean; missing?: boolean; checks?: unknown[] } = {}) {
  let pulls = 0;
  const urls: string[] = [];
  const transport: typeof fetch = async url => {
    const endpoint = String(url); urls.push(endpoint);
    let value: unknown;
    if (endpoint.endsWith('/repositories/1')) value = { id: 1, full_name: 'o/r' };
    else if (endpoint.includes('/check-runs?')) value = { check_runs: options.checks ?? [] };
    else if (endpoint.includes('/issues/2/labels')) value = [];
    else if (endpoint.endsWith('/pulls/2')) {
      pulls++;
      value = { ...pullFacts, base: { ...pullFacts.base, sha: options.drift === 'base' && pulls > 1 ? 'e'.repeat(40) : identity.baseSha },
        head: { ...pullFacts.head, sha: options.drift === 'head' && pulls > 1 ? 'e'.repeat(40) : identity.headSha }, changed_files: options.count ?? 2 };
    } else if (endpoint.includes('/files?')) {
      const first = [{ ...fileFacts[0], status: options.fileStatus ?? 'modified' }];
      const second = [{ ...fileFacts[1], status: options.status ?? 'added' }];
      if (options.pagination && !endpoint.includes('page=2')) return new Response(JSON.stringify(first), { headers: { link: '<https://api.github.com/repos/o/r/pulls/2/files?per_page=100&page=2>; rel="next"' } });
      value = options.pagination ? second : [...first, ...second];
    } else if (endpoint.includes('/commits?')) value = commitFacts;
    else if (endpoint.includes('/git/commits/')) value = { sha: endpoint.split('/').at(-1), tree: { sha: endpoint.split('/').at(-1) } };
    else if (endpoint.endsWith(`/trees/${identity.baseSha}`)) value = { sha: identity.baseSha, truncated: false, tree: [] };
    else if (endpoint.endsWith(`/trees/${identity.headSha}`)) value = { sha: identity.headSha, truncated: options.truncated ?? false, tree: [{ path: 'fragments', type: 'tree', mode: '040000', sha: treeSha }] };
    else if (endpoint.endsWith(`/trees/${treeSha}`)) value = { sha: treeSha, truncated: false, tree: options.missing ? [] : [{ path: 'new-fact.json', type: 'blob', mode: options.mode ?? '100644', sha: blobSha }] };
    else if (endpoint.endsWith(`/blobs/${blobSha}`)) value = { sha: blobSha, encoding: 'base64', size: bytes.length, content: options.corrupt ? Buffer.alloc(bytes.length).toString('base64') : bytes.toString('base64') };
    else throw Error(`Unexpected request ${endpoint}`);
    return new Response(JSON.stringify(value));
  };
  const gh = new GitHubClient('test', 'https://api.github.com', transport);
  return { gh, urls, transport, run: () => validateRemoteFragments({ gh, owner: 'o', repo: 'r', identity, profile, classification: async () => null }) };
}
describe('T05-T06 remote fragment validation', () => {
  it('reads all pages, head blobs, and rechecks the PR', async () => {
    const test = fixture({ pagination: true });
    const result = await test.run();
    expect(result.identity).toEqual(identity);
    expect(result.fragment?.status).toBe('not-user-facing');
    expect(result.sources).toEqual([{ path, blobSha, sha256: createHash('sha256').update(bytes).digest('hex') }]);
    expect(test.urls.filter(url => url.endsWith('/pulls/2'))).toHaveLength(2);
    expect(test.urls.some(url => url.includes('page=2'))).toBe(true);
  });
  it.each(['base', 'head'] as const)('rejects %s drift during reads', async drift => {
    await expect(fixture({ drift }).run()).rejects.toThrow('RN_SOURCE_STALE');
  });
  it('rejects classification drift at the final read', async () => {
    const test = fixture();
    const classification = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ primaryKind: 'bug', riskFlags: ['security'] });
    await expect(validateRemoteFragments({ gh: test.gh, owner: 'o', repo: 'r', identity, profile, classification })).rejects.toThrow('RN_SOURCE_STALE');
    expect(classification).toHaveBeenCalledTimes(2);
  });
  it.each([{ count: 3 }, { count: 3001 }, { truncated: true }, { mode: '120000' }, { corrupt: true }, { missing: true }, { status: 'copied' }])('fails closed on incomplete sources %#', async options => {
    await expect(fixture(options).run()).rejects.toThrow('RN_SOURCE_INCOMPLETE');
  });
  it.each(['modified', 'removed'])('rejects historical fragment status %s before reading blobs', async status => {
    const test = fixture({ status });
    await expect(test.run()).rejects.toThrow('RN_FRAGMENT_LIFECYCLE');
    expect(test.urls.some(url => url.includes('/git/'))).toBe(false);
  });
  it('accepts removed ordinary files', async () => {
    await expect(fixture({ fileStatus: 'removed' }).run()).resolves.toMatchObject({ fragment: { status: 'not-user-facing' } });
  });
  it('returns null for a missing path', async () => {
    const test = fixture();
    await expect(readFragmentBlob(test.gh, 'o', 'r', identity.baseSha, path)).resolves.toBeNull();
  });
  it('reports pagination failures with a stable code', async () => {
    const test = fixture();
    vi.spyOn(test.gh, 'listPullFiles').mockRejectedValue(new Error('pagination limit'));
    await expect(test.run()).rejects.toThrow('RN_SOURCE_INCOMPLETE');
  });
});

describe('中央 validate 片段入口', () => {
  it.each(['security', 'breaking-change'])('分类保留人工 %s 风险并传给片段门禁', async risk => {
    const root = await mkdtemp(join(tmpdir(), 'steward-classification-fragments-'));
    try {
      await cp(resolve('config'), join(root, 'config'), { recursive: true });
      const catalogPath = join(root, 'config/repositories.json');
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
      const cfg = structuredClone(catalog.repositories['1296724484']);
      cfg.classification = { profile: 'default', labelDefinitionMode: 'observe', labelAssignmentMode: 'observe', ai: { mode: 'shadow', adoptedPrimaryKinds: [], canaries: [] } };
      catalog.repositories['1'] = { ...cfg, fullName: 'o/r' };
      await writeFile(catalogPath, JSON.stringify(catalog));
      const profilePath = join(root, 'config/profiles/validation/steward.json');
      const validation = JSON.parse(await readFile(profilePath, 'utf8'));
      validation.fragmentGate = { repositories: [1], profile };
      await writeFile(profilePath, JSON.stringify(validation));
      const semantics = JSON.parse(await readFile('config/labels/pr-semantics.json', 'utf8'));
      const classification = JSON.parse(await readFile('config/profiles/classification/default.json', 'utf8'));
      const codec = classificationCheckStateCodec(semantics, classification);
      let check: Record<string, unknown> | undefined;
      const fragmentTransport = fixture().transport;
      vi.spyOn(github, 'createInstallationToken').mockResolvedValue('test');
      vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
        const endpoint = String(url);
        let value: unknown;
        if (endpoint.includes('/check-runs') && ['POST', 'PATCH'].includes(init?.method ?? '')) {
          check = { ...check, ...JSON.parse(String(init?.body)), id: 1, head_sha: identity.headSha, app: { id: 4243096 } };
          value = check;
        } else if (endpoint.includes('/check-runs?')) value = { check_runs: check ? [check] : [] };
        else if (endpoint.endsWith('/pulls/2')) value = { number: 2, state: 'open', title: 'Update tests', body: '', user: { login: 'user', type: 'User' },
          base: { sha: identity.baseSha, ref: 'main', repo: { id: 1 } }, head: { sha: identity.headSha, ref: 'change', repo: { id: 1 } }, changed_files: 2, commits: 1 };
        else if (endpoint.includes('/commits?')) value = [{ sha: identity.headSha, commit: { message: 'test: update fixtures' } }];
        else if (endpoint.includes('/issues/2/labels')) value = [{ name: risk }];
        else if (endpoint.includes('/repos/o/r/labels')) value = [];
        else return fragmentTransport(url, init);
        return new Response(JSON.stringify(value));
      });
      for (const [key, value] of Object.entries({ STEWARD_CONFIG_DIRECTORY: join(root, 'config'), GITHUB_STEP_SUMMARY: join(root, 'summary.md'),
        APP_ID: '1', INSTALLATION_ID: '1', STEWARD_APP_PRIVATE_KEY: 'test', AI_CLASSIFICATION: '',
        VALIDATION_READ_TOKEN: 'test', VALIDATION_PR_NUMBER: '2', VALIDATION_BASE_SHA: identity.baseSha, VALIDATION_HEAD_SHA: identity.headSha, VALIDATION_POLICY_SHA: identity.policySha })) vi.stubEnv(key, value);
      for (let iteration = 0; iteration < 2; iteration++) {
        await main(['pr-classification', '--repository-id', '1', '--pull-request-number', '2', '--event-head-sha', identity.headSha, '--policy-sha', identity.policySha]);
        expect(check?.conclusion).toBe('success');
        expect(decodeClassificationCheckState(check?.external_id, codec, identity)).toMatchObject({ policySha: identity.policySha, ownedRiskFlags: [], riskFlags: [risk] });
      }
      await expect(main(['validate', '--workspace', '.', '--repository-id', '1', '--profile', 'steward', '--fragments-only', 'true'])).rejects.toThrow('RN_FACT_CONFLICT');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(['missing', 'trusted', 'wrong-head', 'wrong-app', 'wrong-policy', 'wrong-policy-sha', 'security', 'human-security', 'human-breaking-change',
    'stale-base', 'stale-files', 'stale-commits', 'incomplete-commits', 'commit-read-failure', 'missing-file-counts',
    'label-added', 'label-removed', 'risk-without-state', 'label-read-failure', 'invalid-label', 'label-drift', 'check-drift', 'label-reordered'] as const)('处理分类来源 %s', async scenario => {
    const root = await mkdtemp(join(tmpdir(), 'steward-fragment-gate-'));
    try {
      await cp(resolve('config'), join(root, 'config'), { recursive: true });
      const catalogPath = join(root, 'config/repositories.json');
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
      const cfg = catalog.repositories['1296724484'];
      catalog.repositories['1'] = { ...cfg, fullName: 'o/r' };
      await writeFile(catalogPath, JSON.stringify(catalog));
      const profilePath = join(root, 'config/profiles/validation/steward.json');
      const validation = JSON.parse(await readFile(profilePath, 'utf8'));
      validation.fragmentGate = { repositories: [1], profile };
      await writeFile(profilePath, JSON.stringify(validation));
      const semantics = JSON.parse(await readFile('config/labels/pr-semantics.json', 'utf8'));
      const classification = JSON.parse(await readFile('config/profiles/classification/default.json', 'utf8'));
      const policy = classificationDigests(semantics, classification, cfg.classification).classificationPolicyDigest;
      const facts = classificationFacts(1, 2, pullFacts, fileFacts, commitFacts);
      if (scenario === 'stale-base') facts.baseSha = 'e'.repeat(40);
      if (scenario === 'stale-files') facts.files[0] = { ...facts.files[0]!, patch: '+old test' };
      if (scenario === 'stale-commits') facts.commits[0] = { ...facts.commits[0]!, message: 'test: old fixtures' };
      const encoded = encodeClassificationCheckState({ v: 4, repositoryId: 1, pullRequestNumber: 2,
        headSha: scenario === 'wrong-head' ? 'e'.repeat(40) : identity.headSha,
        policySha: scenario === 'wrong-policy-sha' ? 'e'.repeat(40) : identity.policySha,
        inputDigest: classificationInputDigest(facts, identity.policySha, policy), decisionDigest: 'b'.repeat(64),
        policy: scenario === 'wrong-policy' ? 'c'.repeat(64) : classificationDigests(semantics, classification, cfg.classification).classificationPolicyDigest,
        mode: 'active', primary: { id: 'bug', source: 'deterministic-fallback', reasonCode: 'primary-fallback-selected' },
        ownedRiskFlags: scenario === 'security' ? ['security'] : [],
        riskFlags: scenario === 'human-breaking-change' ? ['breaking-change'] : ['security', 'human-security', 'label-removed'].includes(scenario) ? ['security'] : [], facets: [], areas: [],
      }, classificationCheckStateCodec(semantics, classification));
      const test = fixture({ checks: ['missing', 'risk-without-state'].includes(scenario) ? [] : [{ name: 'PR Classification Gate', head_sha: identity.headSha,
        app: { id: scenario === 'wrong-app' ? 99 : 4243096 }, status: 'completed', conclusion: 'success', external_id: encoded }] });
      let labelReads = 0;
      let checkReads = 0;
      vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
        const endpoint = String(url);
        if (endpoint.includes('/check-runs?')) {
          checkReads++;
          if (scenario === 'check-drift' && checkReads > 1) {
            const result = await (await test.transport(url, init)).json();
            result.check_runs[0].external_id = encodeClassificationCheckState({ ...decodeClassificationCheckState(encoded, classificationCheckStateCodec(semantics, classification))!, decisionDigest: 'e'.repeat(64) }, classificationCheckStateCodec(semantics, classification));
            return new Response(JSON.stringify(result));
          }
        }
        if (endpoint.includes('/issues/2/labels')) {
          labelReads++;
          if (scenario === 'label-drift' && labelReads > 1) return new Response('[{"name":"security"}]');
          if (scenario === 'label-reordered') return new Response(JSON.stringify((labelReads === 1 ? ['one', 'two'] : ['two', 'one']).map(name => ({ name }))));
          if (scenario === 'label-read-failure') throw new Error('label read failed');
          if (scenario === 'invalid-label') return new Response('[{}]');
          return new Response(JSON.stringify(scenario === 'human-breaking-change' ? [{ name: 'breaking-change' }]
            : ['human-security', 'label-added', 'risk-without-state'].includes(scenario) ? [{ name: 'security' }] : []));
        }
        if (endpoint.includes('/commits?')) {
          if (scenario === 'commit-read-failure') throw new Error('commit read failed');
          if (scenario === 'incomplete-commits') return new Response('[]');
        }
        if (endpoint.includes('/files?') && scenario === 'missing-file-counts') return new Response(JSON.stringify(fileFacts.map(({ additions, ...file }) => file)));
        return test.transport(url, init);
      });
      for (const [key, value] of Object.entries({ STEWARD_CONFIG_DIRECTORY: join(root, 'config'), GITHUB_STEP_SUMMARY: join(root, 'summary.md'),
        VALIDATION_READ_TOKEN: 'test', VALIDATION_PR_NUMBER: '2', VALIDATION_BASE_SHA: identity.baseSha, VALIDATION_HEAD_SHA: identity.headSha, VALIDATION_POLICY_SHA: identity.policySha })) vi.stubEnv(key, value);
      const run = main(['validate', '--workspace', '.', '--repository-id', '1', '--profile', 'steward', '--fragments-only', 'true']);
      if (['security', 'human-security', 'human-breaking-change', 'label-added'].includes(scenario)) await expect(run).rejects.toThrow('RN_FACT_CONFLICT');
      else if (scenario === 'risk-without-state') await expect(run).rejects.toThrow('风险标签需要有效的当前分类结果');
      else if (scenario === 'label-read-failure') await expect(run).rejects.toThrow('label read failed');
      else if (scenario === 'invalid-label') await expect(run).rejects.toThrow('片段分类标签数据不完整');
      else if (['label-drift', 'check-drift'].includes(scenario)) await expect(run).rejects.toThrow('RN_SOURCE_STALE');
      else {
        await run;
        const summary = await readFile(join(root, 'summary.md'), 'utf8');
        expect(summary).toContain(`分类：${['trusted', 'label-removed', 'label-reordered'].includes(scenario) ? 'provided' : 'missing'}`);
        expect(summary).toContain(`要求：${['trusted', 'label-removed', 'label-reordered'].includes(scenario) ? 'review-required' : 'ignored'}`);
        expect(summary).toContain(identity.baseSha);
        expect(summary).toContain(identity.policySha);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
