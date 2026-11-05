'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { resolve, join } = require('node:path');
const { readFileSync } = require('node:fs');
const { reportBoundary, fullSync } = require('./entry.cjs');

const upstream = resolve(process.env.STEWARD_SETTINGS_UPSTREAM || 'tools/upstream/safe-settings');
const fromUpstream = createRequire(join(upstream, 'package.json'));
const runtime = import(pathToFileURL(fromUpstream.resolve('probot')).href);
const sha = 'a'.repeat(40), canary = 'PRIVATE-CANARY-PATH-secret-repository';
// Configure the real upstream entry before it reads its module-level environment.
Object.assign(process.env, { GH_ORG: 'splrad', ADMIN_REPO: 'steward', CONFIG_PATH: 'safe-settings', SETTINGS_FILE_PATH: 'settings.yml',
  CREATE_DEFAULT_BRANCH: 'false', CREATE_PR_COMMENT: 'false', CREATE_ERROR_ISSUE: 'false',
  DEPLOYMENT_CONFIG_FILE: resolve('safe-settings/deployment-settings.yml') });
for (const key of ['CRON','WEBHOOK_PROXY_URL','REDIS_URL','GHE_HOST','GH_ENTERPRISE']) delete process.env[key];

function offlineOctokit(Base, fixture) {
  return class extends Base { constructor(options) { super({ ...options, request: { ...options?.request, fetch: fixture.fetch }, retry: { enabled: false }, throttle: { enabled: false } }); } };
}

function fixtures({ failLabel = false, nop = false } = {}) {
  const repositories = ['steward', '.github', canary, 'develop-project', 'empty-project'].map((name, i) => ({ id: i + 1, name, full_name: 'splrad/' + name,
    owner: { login: 'splrad' }, default_branch: i === 3 ? 'develop' : 'main', private: i === 2, archived: false,
    allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true, allow_auto_merge: true,
    squash_merge_commit_title: 'COMMIT_OR_PR_TITLE', squash_merge_commit_message: 'COMMIT_MESSAGES', topics: [] }));
  const calls = [], labels = new Map(repositories.map(r => [r.name, [{ name: 'manual-keep', color: '111111', description: 'manual' }]]));
  const fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url), path = decodeURIComponent(url.pathname);
    const method = options.method ?? 'GET', body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, path, body });
    let data, status = 200;
    if (method === 'GET' && path === '/app/installations') data = [{ id: 8, target_type: 'Organization', account: { login: 'splrad' } }];
    else if (method === 'GET' && path === '/app') data = { id: 9, slug: 'fixture-governance' };
    else if (method === 'GET' && path === '/installation/repositories') data = { total_count: repositories.length, repositories };
    else if (method === 'GET' && path === '/repos/splrad/steward/contents/safe-settings/settings.yml') data = {
      type: 'file', content: Buffer.from(readFileSync('safe-settings/settings.yml')).toString('base64') };
    else if (method === 'GET' && ['/repos/splrad/steward/contents/safe-settings/suborgs', '/repos/splrad/steward/contents/safe-settings/repos', '/repos/splrad/steward/contents/safe-settings'].includes(path)) data = [];
    else if (method === 'GET' && path === '/repos/splrad/steward/commits') data = [{ sha }];
    else if (method === 'POST' && path === '/repos/splrad/steward/check-runs') { status = 201; data = { id: 200, ...body }; }
    else {
      const match = path.match(/^\/repos\/splrad\/([^/]+)(\/labels(?:\/([^/]+))?)?$/);
      const repo = repositories.find(r => r.name === match?.[1]);
      if (match && repo && !match[2] && method === 'GET') data = repo;
      else if (match && repo && !match[2] && method === 'PATCH') { Object.assign(repo, body); data = repo; }
      else if (match && repo && match[2] && method === 'GET') data = labels.get(repo.name);
      else if (match && repo && match[2] && method === 'POST') {
        if (failLabel && repo.private) { status = 422; data = { message: canary }; }
        else { labels.get(repo.name).push(body); data = body; status = 201; }
      } else throw new Error('UNEXPECTED_OFFLINE_ENDPOINT ' + method + ' ' + path);
    }
    const response = new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
  return { fetch, calls, repositories, labels, nop };
}

test('real upstream full-sync apply keeps manual labels, includes .github/non-main/empty, and redacts only reports', async () => {
  const { createProbot, ProbotOctokit } = await runtime, f = fixtures();
  const result = await fullSync({ createProbot, ProbotOctokit: offlineOctokit(ProbotOctokit, f),
    app: fromUpstream('./index.js'), environment: { FULL_SYNC_NOP: 'false' }, runId: 10, overrides: { appId: 9, githubToken: 'fixture' } });
  assert.equal(result.exitCode, 0, JSON.stringify({summary:result.summary,details:result.details,errors:result.reportErrors}));
  for (const repo of f.repositories) { assert.equal(repo.allow_merge_commit, false); assert.equal(f.labels.get(repo.name)[0].name, 'manual-keep'); }
  assert.equal(result.summary.repositories, 5);
  assert.equal(result.details.length, 5);
  assert.ok(result.details.every(detail => detail.entries.some(e => e.entry.plugin === 'native-settings-observation')));
  const report = f.calls.find(c => c.path.endsWith('/check-runs'));
  assert.equal(report.body.conclusion, 'success');
  assert.doesNotMatch(JSON.stringify(report.body), new RegExp(canary));
  assert.ok(!f.calls.some(c => /\/contents\//.test(c.path) && c.method !== 'GET'));
});

test('real upstream failure stays nonzero and failure Check keeps private canary out', async () => {
  const { createProbot, ProbotOctokit } = await runtime, f = fixtures({ failLabel: true });
  const result = await fullSync({ createProbot, ProbotOctokit: offlineOctokit(ProbotOctokit, f),
    app: fromUpstream('./index.js'), environment: { FULL_SYNC_NOP: 'false' }, runId: 11, overrides: { appId: 9, githubToken: 'fixture' } });
  assert.equal(result.exitCode, 1);
  const report = f.calls.find(c => c.path.endsWith('/check-runs'));
  assert.equal(report.body.conclusion, 'failure');
  assert.doesNotMatch(JSON.stringify(report.body), new RegExp(canary));
  assert.match(JSON.stringify(result.details), new RegExp(canary));
  assert.doesNotMatch(JSON.stringify(result.summary), new RegExp(canary));
});

test('real upstream NOP produces complete native differences without changing settings or publishing private details', async () => {
  const { createProbot, ProbotOctokit } = await runtime, f = fixtures({ nop: true });
  const result = await fullSync({ createProbot, ProbotOctokit: offlineOctokit(ProbotOctokit, f),
    app: fromUpstream('./index.js'), environment: { FULL_SYNC_NOP: 'true' }, runId: 12, overrides: { appId: 9, githubToken: 'fixture' } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.repositories, 5);
  assert.match(JSON.stringify(result.details), new RegExp(canary));
  assert.ok(result.details.some(d => d.entries.some(e => e.entry.plugin === 'Repository')));
  assert.ok(f.calls.every(c => c.method === 'GET'));
  assert.equal(result.summary.failures, 0);
  assert.equal(result.summary.reports, 0);
});

test('official plugin preserves business request bytes and rejects unknown reporting interfaces', async () => {
  const { ProbotOctokit } = await runtime, boundary = reportBoundary({ owner: 'splrad', repository: 'steward', runId: 13 });
  const received = [];
  const api = new (ProbotOctokit.plugin(boundary.plugin))({ auth: { token: 'fixture' }, request: { fetch: async (url, options) => {
    received.push({ url, body: options.body }); return new Response('{"id":5}', { status: 201, headers: { 'content-type': 'application/json' } });
  } }, retry: { enabled: false }, throttle: { enabled: false }, log: boundary.log });
  await api.request('PATCH /repos/splrad/example', { allow_merge_commit: false });
  assert.equal(received[0].body, '{"allow_merge_commit":false}');
  for (const route of ['POST /repos/splrad/steward/issues', 'POST /repos/splrad/steward/statuses/' + sha, 'POST /repos/splrad/private/check-runs']) {
    await assert.rejects(api.request(route, { body: canary }), /REPORT_BOUNDARY_UNSUPPORTED/);
  }
  assert.equal(received.length, 1);
});

test('closed Check payload strips annotations and details URL, and fails on new fields', async () => {
  const { ProbotOctokit } = await runtime, boundary = reportBoundary({ owner: 'splrad', repository: 'steward', runId: 14 });
  const bodies = [];
  const api = new (ProbotOctokit.plugin(boundary.plugin))({ auth: { token: 'fixture' }, request: { fetch: async (url, options) => {
    bodies.push(JSON.parse(options.body)); return new Response('{"id":5}', { status: 201, headers: { 'content-type': 'application/json' } });
  } }, retry: { enabled: false }, throttle: { enabled: false }, log: boundary.log });
  const body = { name: 'Safe-Settings', head_sha: sha, status: 'completed', conclusion: 'failure', details_url: 'https://private.invalid/' + canary,
    output: { title: canary, summary: canary, text: canary, annotations: [{ path: canary }] } };
  await api.rest.checks.create({ owner: 'splrad', repo: 'steward', ...body });
  assert.equal(boundary.reports.length, 1, JSON.stringify({errors:boundary.errors,reports:boundary.reports}));
  assert.doesNotMatch(JSON.stringify(bodies), new RegExp(canary));
  await assert.rejects(api.rest.checks.create({ owner: 'splrad', repo: 'steward', ...body, external_id: canary }), /REPORT_BOUNDARY_UNSUPPORTED/);
  for (const key of ['name','head_sha','started_at','completed_at']) {
    await assert.rejects(api.rest.checks.update({ owner: 'splrad', repo: 'steward', check_run_id: 5, ...body, [key]: canary }), /REPORT_BOUNDARY_UNSUPPORTED/);
  }
  assert.equal(bodies.length, 1);
  await api.rest.checks.update({ owner: 'splrad', repo: 'steward', check_run_id: 5, ...body, completed_at: '2026-10-28T00:00:00.000Z' });
  assert.equal(bodies.length, 2);
  assert.doesNotMatch(JSON.stringify(bodies), new RegExp(canary));
});

test('empty installation and upstream exception never become successful synchronization', async () => {
  const { createProbot, ProbotOctokit } = await runtime;
  for (const app of [() => ({ syncInstallation: async () => null }), () => ({ syncInstallation: async () => { throw new Error(canary); } })]) {
    const result = await fullSync({ createProbot, ProbotOctokit, app, environment: { FULL_SYNC_NOP: 'true' }, runId: 15,
      overrides: { appId: 9, githubToken: 'fixture' } });
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(JSON.stringify(result.summary), new RegExp(canary));
  }
});

test('upstream swallowing a failed Check write still fails the parent invocation', async () => {
  const { createProbot, ProbotOctokit } = await runtime, f = fixtures();
  const original = f.fetch;
  f.fetch = async (url, options) => {
    if (String(url).endsWith('/check-runs')) return new Response(JSON.stringify({ message: canary }), { status: 422, headers: { 'content-type': 'application/json' } });
    return original(url, options);
  };
  const result = await fullSync({ createProbot, ProbotOctokit: offlineOctokit(ProbotOctokit,f), app: fromUpstream('./index.js'),
    environment: { FULL_SYNC_NOP: 'false' }, runId: 16, overrides: { appId: 9, githubToken: 'fixture' } });
  assert.equal(result.exitCode, 1);assert.deepEqual(result.reportErrors,['REPORT_WRITE_FAILED']);
  assert.doesNotMatch(JSON.stringify(result.summary),new RegExp(canary));
});
