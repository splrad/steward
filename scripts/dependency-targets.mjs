import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeReleaseApp } from '../packages/runner/dist/index.js';

const fail = code => { throw Error(`UPDATE_TARGET_${code}`); };
const validId = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function updateSlot(runId, repositoryId) {
  if (!validId(runId) || !validId(repositoryId)) fail('IDENTITY');
  return createHash('sha256').update(`${runId}:${repositoryId}`).digest('hex');
}

/** Only the native repository config declares a Renovate scope. No central repository catalog. */
export async function readUpdateTarget(repository, get) {
  if (!validId(repository.id) || !/^splrad\/[A-Za-z0-9_.-]+$/.test(repository.full_name)) fail('IDENTITY');
  const path = `/repos/${repository.full_name}`;
  const actual = await get(path);
  if (actual.id !== repository.id || actual.full_name !== repository.full_name || actual.owner?.id !== 302208797
    || !/^[A-Za-z0-9_.-]+$/.test(actual.name ?? '') || actual.full_name !== `splrad/${actual.name}`) fail('IDENTITY');
  if (actual.archived || actual.disabled) return null;
  if (typeof actual.default_branch !== 'string' || !actual.default_branch) fail('BRANCH');
  const head = await get(`${path}/commits/${encodeURIComponent(actual.default_branch)}`);
  if (!sha(head.sha)) fail('SOURCE');
  const file = await get(`${path}/contents/.github/renovate.json?ref=${head.sha}`, true);
  if (file === null) return null;
  if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || !sha(file.sha)
    || !Number.isSafeInteger(file.size) || file.size < 2 || file.size > 65536) fail('CONFIG');
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.length !== file.size || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== file.sha
    || !Buffer.from(bytes.toString('utf8')).equals(bytes)) fail('CONFIG_BYTES');
  const config = JSON.parse(bytes.toString('utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('CONFIG');
  if (config.enabled === false) return null;
  if (config.enabled !== undefined && config.enabled !== true) fail('CONFIG');
  const managers = config.enabledManagers;
  if (!Array.isArray(managers) || new Set(managers).size !== managers.length
    || !managers.every(manager => ['mise', 'github-actions', 'custom.regex'].includes(manager))) fail('MANAGERS');
  if (!managers.length) return null;
  // A 404 config is only absence after the repository and its current head were read successfully.
  const latest = await get(`${path}/commits/${encodeURIComponent(actual.default_branch)}`);
  if (latest.sha !== head.sha) fail('SOURCE_MOVED');
  return { id: actual.id, fullName: actual.full_name, repository: actual.name, sourceSha: head.sha };
}

export async function discoverUpdateTargets(app, runId, slot, getWithToken) {
  if (slot !== undefined && !/^[a-f0-9]{64}$/.test(slot)) fail('SLOT');
  const repositories = await app.discover();
  if (new Set(repositories.map(repo => repo.id)).size !== repositories.length) fail('DUPLICATE');
  const include = []; let selected = null, failed = 0;
  for (const repository of repositories) {
    if (repository.archived || repository.disabled) continue;
    const key = updateSlot(runId, repository.id);
    if (slot !== undefined && key !== slot) continue;
    try {
      const target = await app.forUpdateReadRepository(repository.id, token => readUpdateTarget(repository, getWithToken(token)));
      if (target) { include.push({ slot: key }); selected = target; }
    } catch (error) {
      if (slot !== undefined) throw error;
      failed++;
    }
  }
  // An uninstalled or manually disabled target becomes a NOP; no replacement target is chosen.
  return slot === undefined ? { include, failed } : selected;
}

export async function main(env = process.env, transport = fetch, appFactory = nativeReleaseApp) {
  const runId = Number(env.GITHUB_RUN_ID), controller = env.STEWARD_CONTROLLER_SHA;
  if (env.GITHUB_REPOSITORY !== 'splrad/steward' || env.GITHUB_REPOSITORY_ID !== '1296724484'
    || env.GITHUB_REF !== 'refs/heads/main' || !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
    || !validId(runId) || !sha(controller) || !env.GITHUB_OUTPUT) fail('ENTRY');
  const getWithToken = token => async (path, absent = false) => {
    const response = await transport(`https://api.github.com${path}`, { redirect: 'error',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } });
    if (response.status === 404 && absent) return null;
    if (!response.ok) fail('READ_UNAVAILABLE');
    return response.json();
  };
  const get = getWithToken(env.GITHUB_TOKEN), run = await get(`/repos/splrad/steward/actions/runs/${runId}`);
  const workflow = await get('/repos/splrad/steward/actions/workflows/update-dependencies.yml');
  if (run.id !== runId || run.workflow_id !== workflow.id || workflow.path !== '.github/workflows/update-dependencies.yml'
    || run.repository?.id !== 1296724484 || run.head_repository?.id !== 1296724484 || run.head_branch !== 'main'
    || run.head_sha !== controller || run.event !== env.GITHUB_EVENT_NAME || workflow.state !== 'active') fail('RUN');
  // Prove this is still an adopted central source before acquiring any App credential.
  const head = await get('/repos/splrad/steward/commits/main');
  if (!sha(head.sha)) fail('SOURCE');
  const ancestry = await get(`/repos/splrad/steward/compare/${controller}...${head.sha}`);
  if (!['identical', 'ahead'].includes(ancestry.status) || ancestry.merge_base_commit?.sha !== controller) fail('ANCESTRY');
  const app = await appFactory(env.STEWARD_APP_PRIVATE_KEY ?? '', transport);
  const slot = env.UPDATE_SLOT || undefined;
  const result = await discoverUpdateTargets(app, runId, slot, getWithToken);
  if (slot === undefined) {
    await appendFile(env.GITHUB_OUTPUT, `matrix=${JSON.stringify({include:result.include})}\nhas_targets=${result.include.length > 0}\nfailed=${result.failed}\n`);
    process.stdout.write(`Update targets: ${result.include.length}; unavailable: ${result.failed}\n`);
  } else {
    if (result) {
      if (!/^[A-Za-z0-9_.-]+$/.test(result.repository) || result.fullName !== `splrad/${result.repository}`) fail('IDENTITY');
      if (env.UPDATE_WRITE_TOKEN) {
        const scope = await getWithToken(env.UPDATE_WRITE_TOKEN)('/installation/repositories?per_page=100');
        if (scope.total_count !== 1 || scope.repositories?.length !== 1 || scope.repositories[0]?.id !== result.id
          || scope.repositories[0]?.full_name !== result.fullName) fail('WRITE_SCOPE');
      }
      // Redaction is local to this job; no repository identity crosses a public job matrix.
      for (const value of [String(result.id), result.fullName, result.repository]) process.stdout.write(`::add-mask::${value}\n`);
      await appendFile(env.GITHUB_OUTPUT, `repository=${result.repository}\nfull_name=${result.fullName}\n`);
    }
    await appendFile(env.GITHUB_OUTPUT, `enabled=${result !== null}\n`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { process.stderr.write('UPDATE_TARGET_UNAVAILABLE\n'); process.exitCode = 1; });
