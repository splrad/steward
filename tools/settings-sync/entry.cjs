'use strict';

const { createRequire } = require('node:module');
const { resolve, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { writeFileSync } = require('node:fs');

const fail = code => { throw new Error(code); };
const integer = value => Number.isSafeInteger(value) && value > 0;

/** Official Octokit extension: business requests pass through unchanged. */
function reportBoundary({ owner, repository, runId }) {
  if (owner !== 'splrad' || repository !== 'steward' || !integer(runId)) fail('SETTINGS_IDENTITY');
  const central = `/repos/${owner}/${repository}`;
  const runUrl = `https://github.com/${owner}/${repository}/actions/runs/${runId}`;
  const errors = [], repositories = new Map(), reports = [], observations = [], checks = new Set();
  const counts = { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 };
  const log = { level: 'error' };
  for (const level of Object.keys(counts)) log[level] = () => { counts[level]++; };
  log.child = () => log;
  function plugin(octokit) {
    octokit.hook.wrap('request', async (request, options) => {
      const endpoint = octokit.request.endpoint(options);
      const url = new URL(endpoint.url), method = endpoint.method.toUpperCase();
      if (url.origin !== 'https://api.github.com') fail('SETTINGS_API_ORIGIN');
      const path = decodeURIComponent(url.pathname);
      const reporting = /\/(?:check-runs|check-suites|statuses|issues(?:\/\d+(?:\/comments)?)?|pulls(?:\/.*)?|deployments)(?:\/|$)/.test(path);
      if (!['GET', 'HEAD'].includes(method) && reporting && !/\/issues\/[^/]+\/labels(?:\/|$)/.test(path)) {
        try {
          const create = method === 'POST' && path === central + '/check-runs';
          const update = method === 'PATCH' && new RegExp(`^${central}/check-runs/[1-9][0-9]*$`).test(path);
          if ((!create && !update) || url.search) fail('REPORT_BOUNDARY_UNSUPPORTED');
          const body = typeof endpoint.body === 'string' ? JSON.parse(endpoint.body) : endpoint.body;
          const keys = ['name','head_sha','status','started_at','conclusion','completed_at','output','details_url'];
          if (!body || Object.keys(body).some(key => !keys.includes(key)) || body.status !== 'completed'
            || !['success','failure'].includes(body.conclusion) || create && (body.name !== 'Safe-Settings' || !/^[a-f0-9]{40}$/.test(body.head_sha))
            || body.name !== undefined && body.name !== 'Safe-Settings'
            || body.head_sha !== undefined && !/^[a-f0-9]{40}$/.test(body.head_sha)
            || ['started_at','completed_at'].some(key => body[key] !== undefined
              && (body[key] instanceof Date ? !Number.isFinite(body[key].getTime())
                : typeof body[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(body[key]) || !Number.isFinite(Date.parse(body[key]))))
            || update && !checks.has(Number(path.split('/').at(-1)))) fail('REPORT_BOUNDARY_UNSUPPORTED');
          reports.push(structuredClone(body));
          const summary = body.conclusion === 'failure' ? '仓库设置同步失败；详情保存在对应仓库。' : '仓库设置同步完成；详情保存在对应仓库。';
          // Rebuild the reporting payload so fields introduced upstream cannot bypass redaction.
          const safe = { status: body.status, conclusion: body.conclusion, output: { title: '仓库设置同步', summary, text: `运行记录：${runUrl}` }, details_url: runUrl };
          for (const key of ['name','head_sha','started_at','completed_at']) if (body[key] !== undefined) safe[key] = body[key];
          // before-after-hook binds this same options object through the inner hooks.
          for (const key of Object.keys(options)) if (!['headers','request','mediaType','baseUrl'].includes(key)) delete options[key];
          Object.assign(options, { method, url: url.origin + path, ...safe });
          const response = await request(options);
          if (create && !integer(response.data?.id)) fail('REPORT_READBACK_INVALID');
          if (create) checks.add(response.data.id);
          return response;
        } catch (error) {
          errors.push(error.message === 'REPORT_BOUNDARY_UNSUPPORTED' ? error.message : 'REPORT_WRITE_FAILED');
          throw new Error(errors.at(-1));
        }
      }
      const response = await request(options);
      if (method === 'GET') {
        const values = path === '/installation/repositories' ? response.data?.repositories
          : /^\/repos\/[^/]+\/[^/]+$/.test(path) ? [response.data] : [];
        for (const repo of values ?? []) {
          if (integer(repo.id) && repo.owner?.login === owner && repo.full_name === `${owner}/${repo.name}`
            && typeof repo.default_branch === 'string' && typeof repo.private === 'boolean') repositories.set(repo.id, {
              id: repo.id, name: repo.name, full_name: repo.full_name, default_branch: repo.default_branch, private: repo.private,
            });
        }
      }
      const target = path.match(/^\/repos\/splrad\/([^/]+)(\/labels(?:\/[^/]+)?)?$/);
      if (target && [...repositories.values()].some(repo => repo.name === target[1])) {
        let value;
        if (method === 'GET' && !target[2]) value = Object.fromEntries(['allow_squash_merge','allow_merge_commit','allow_rebase_merge','allow_auto_merge',
          'squash_merge_commit_title','squash_merge_commit_message','default_branch','archived'].filter(key => response.data[key] !== undefined).map(key => [key,response.data[key]]));
        else if (method === 'GET' && Array.isArray(response.data)) value = response.data.map(label => ({ name: label.name, color: label.color, description: label.description }));
        else if (['POST','PATCH','DELETE'].includes(method)) value = typeof endpoint.body === 'string' ? JSON.parse(endpoint.body) : endpoint.body ?? null;
        if (value !== undefined) observations.push({ owner: 'splrad', repo: target[1], plugin: 'native-settings-observation', method, path, status: response.status, value });
      }
      return response;
    });
  }
  return { plugin, log, counts, errors, repositories, reports, observations };
}

/** Keep upstream discovery, plugins, configuration loading, diffing and retries intact. */
async function fullSync({ createProbot, ProbotOctokit, app, environment, runId, overrides = {} }) {
  const boundary = reportBoundary({ owner: 'splrad', repository: 'steward', runId });
  const Octokit = ProbotOctokit.plugin(boundary.plugin);
  const probot = await createProbot({ env: environment, overrides: { ...overrides, Octokit, log: boundary.log } }).ready();
  let result, exception = false;
  try { result = await app(probot, {}).syncInstallation(environment.FULL_SYNC_NOP === 'true'); }
  catch { exception = true; }
  const failures = (result?.errors?.length ?? 0) + boundary.errors.length + (exception || result == null ? 1 : 0);
  const byRepository = new Map();
  const unresolved = [];
  for (const settings of result?.results ?? []) {
    for (const [kind, entries] of [['result', settings.results], ['error', settings.errors]]) {
      for (const entry of entries ?? []) {
        if (!entry) continue;
        const matches = [...boundary.repositories.values()].filter(repo => repo.name === entry.repo && (!entry.owner || entry.owner === 'splrad'));
        if (matches.length !== 1) { unresolved.push({ kind, entry }); continue; }
        const repo = matches[0];
        if (!byRepository.has(repo.id)) byRepository.set(repo.id, { repository: repo, entries: [] });
        byRepository.get(repo.id).entries.push({ kind, entry });
      }
    }
  }
  for (const entry of boundary.observations) {
    const repo = [...boundary.repositories.values()].find(repo => repo.name === entry.repo);
    if (!byRepository.has(repo.id)) byRepository.set(repo.id, { repository: repo, entries: [] });
    byRepository.get(repo.id).entries.push({ kind: 'result', entry });
  }
  // Upstream may swallow report errors; they must still fail this invocation.
  const summary = { mode: environment.FULL_SYNC_NOP === 'true' ? 'NOP' : 'APPLY', installations: result?.results?.length ?? 0,
    repositories: boundary.repositories.size, failures: failures + (boundary.counts.error || boundary.counts.fatal ? 1 : 0),
    reports: boundary.reports.length, unresolved: unresolved.length };
  return { summary, details: [...byRepository.values()], unresolved, reportErrors: boundary.errors,
    rawReports: boundary.reports, exitCode: summary.failures ? 1 : 0 };
}

async function main() {
  const env = process.env;
  if (env.GITHUB_REPOSITORY !== 'splrad/steward' || env.GITHUB_REPOSITORY_ID !== '1296724484'
    || env.GITHUB_REF !== `refs/heads/${env.STEWARD_DEFAULT_BRANCH}` || !/^[a-f0-9]{40}$/.test(env.STEWARD_CONTROLLER_SHA ?? '')
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !['true','false'].includes(env.FULL_SYNC_NOP)
    || env.GH_ORG !== 'splrad' || env.ADMIN_REPO !== 'steward' || env.CONFIG_PATH !== 'safe-settings'
    || env.SETTINGS_FILE_PATH !== 'settings.yml' || env.CREATE_DEFAULT_BRANCH !== 'false'
    || env.CREATE_PR_COMMENT !== 'false' || env.CREATE_ERROR_ISSUE !== 'false'
    || ['CRON','WEBHOOK_PROXY_URL','REDIS_URL','GHE_HOST','GH_ENTERPRISE'].some(key => env[key])) fail('SETTINGS_ENVIRONMENT');
  if (!/^[1-9][0-9]*$/.test(env.APP_ID ?? '') || !env.PRIVATE_KEY) fail('SETTINGS_AUTH_MISSING');
  const upstream = resolve('tools/upstream/safe-settings');
  const upstreamRequire = createRequire(join(upstream, 'package.json'));
  const { createProbot, ProbotOctokit } = await import(pathToFileURL(upstreamRequire.resolve('probot')).href);
  const result = await fullSync({ createProbot, ProbotOctokit, app: upstreamRequire('./index.js'), environment: env, runId: Number(env.GITHUB_RUN_ID) });
  // Only the parent owns this private temporary path. No artifact upload or raw stdout replay.
  writeFileSync(env.STEWARD_SETTINGS_RESULT, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  process.exitCode = result.exitCode;
}

module.exports = { reportBoundary, fullSync };
if (require.main === module) main().catch(() => { process.stderr.write('SETTINGS_UNAVAILABLE\n'); process.exitCode = 1; });
