import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { verifyLegacyRuntimeRetirement } from './verify-legacy-runtime-retirement.mjs';

const execute = promisify(execFile);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const maintenanceWorkflow = '.github/workflows/maintenance-validation.yml';
const run = (command, args, options = {}) => execute(command, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options });

// This is a central operator-selected adoption record, not a cryptographic authorization token.
export async function readAdoptionRecord(filename, checkout = process.cwd()) {
  const root = await realpath(checkout), file = await realpath(filename);
  const location = relative(root, file);
  if (!location || (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))) throw new Error('Adoption record must be outside the candidate checkout');
  const r = JSON.parse(await readFile(file, 'utf8'));
  if (r.schemaVersion !== 1 || r.repository !== 'splrad/steward' || !Number.isSafeInteger(r.pullNumber) || r.pullNumber <= 0
    || ![r.reviewedHead, r.deploymentHead, r.reviewedTree, r.deploymentTree, r.policySha, r.evaluatorSha].every(sha)
    || r.reviewedTree !== r.deploymentTree || !/^[a-f0-9]{64}$/.test(r.bundleSha256)
    || r.accountId !== '5efbba9a3813a37ac45e70cfa9f01cb5' || r.workerName !== 'splrad-steward-runtime'
    || !uuid(r.expectedCurrentVersion) || r.window?.status !== 'confirmed' || typeof r.window.reference !== 'string' || !r.window.reference.trim()
    || !Number.isFinite(Date.parse(r.window.expiresAt)) || Date.parse(r.window.expiresAt) <= Date.now()
    || ![r.evidence?.validationRunId, r.evidence?.validationRunAttempt, r.evidence?.validationSourceJobId, r.evidence?.validationFinalJobId, r.evidence?.copilotRunId, r.evidence?.copilotRunAttempt, r.evidence?.copilotReviewId, r.evidence?.copilotCheckRunId, r.evidence?.codexCommentId].every(v => Number.isSafeInteger(v) && v > 0)
    || !sha(r.evidence?.validationWorkflowSha)
    || ![r.evidence?.validationSourceLogSha256, r.evidence?.validationFinalLogSha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
    || !/^[a-f0-9]{64}$/.test(r.evidence?.copilotReviewBodySha256) || !/^[a-f0-9]{64}$/.test(r.evidence?.codexCommentBodySha256)
    || typeof r.evidence?.reviewDecisionReference !== 'string' || !r.evidence.reviewDecisionReference.trim()) throw new Error('Incomplete central adoption record');
  const origin = new URL(r.runtimeOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.search || origin.hash || origin.pathname !== '/' || origin.origin !== r.runtimeOrigin) throw new Error('Noncanonical adoption origin');
  return r;
}

async function evidencePages(api, path, key) {
  const read = async () => {
    const rows = [], ids = new Set();
    let total;
    for (let page = 1; page <= 11; page++) {
      const response = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const items = key ? response?.[key] : response;
      if (!Array.isArray(items) || items.length > 100) throw new Error('Incomplete adoption evidence page');
      if (key) {
        if (!Number.isSafeInteger(response.total_count) || response.total_count < 0 || response.total_count > 1000
          || (total !== undefined && total !== response.total_count)) throw new Error('Unstable or truncated adoption evidence count');
        total = response.total_count;
      }
      for (const item of items) {
        if (!Number.isSafeInteger(item.id) || ids.has(item.id)) throw new Error('Invalid or repeated adoption evidence ID');
        ids.add(item.id); rows.push(item);
      }
      if (rows.length > 1000 || (total !== undefined && rows.length > total)) throw new Error('Adoption evidence exceeds complete read range');
      if (items.length < 100 || rows.length === total) {
        if (total !== undefined && rows.length !== total) throw new Error('Missing adoption evidence page');
        return rows;
      }
    }
    throw new Error('Incomplete adoption evidence pagination');
  };
  const first = await read(), second = await read();
  const fingerprint = rows => JSON.stringify(rows.map(v => [v.id, v.head_sha, v.commit_id, v.path, v.event, v.status, v.conclusion,
    v.run_attempt, v.run_started_at, v.created_at, v.started_at, v.submitted_at, v.state, v.body,
    v.repository?.full_name, v.head_repository?.full_name, v.head_branch, v.workflow_id, v.run_id, v.name, v.user?.login, v.app?.id, v.check_suite_id, v.check_suite?.id,
    v.number, v.merge_commit_sha, v.head?.sha, v.head?.ref, v.head?.repo?.full_name, v.base?.ref, v.base?.repo?.full_name,
    v.pull_requests?.map(p => [p.number, p.head?.sha])]).sort((a, b) => a[0] - b[0]));
  if (fingerprint(first) !== fingerprint(second)) throw new Error('Adoption evidence changed during pagination');
  return second;
}

function latestEvidence(rows, selectedId, timestamp, submitted = false) {
  if (!rows.length || (!submitted && rows.some(row => row.status !== 'completed'))) throw new Error('Current adoption evidence is missing or still running');
  const dated = rows.map(row => ({ row, time: Date.parse(timestamp(row)) }));
  if (dated.some(value => !Number.isFinite(value.time))) throw new Error('Unknown adoption evidence time');
  dated.sort((a, b) => b.time - a.time);
  if ((dated[1] && dated[0].time === dated[1].time) || dated[0].row.id !== selectedId) throw new Error('Newer or ambiguous evidence invalidates central adoption record');
  const latest = dated[0].row;
  if (!submitted && latest.conclusion !== 'success') throw new Error('Latest adoption evidence is not successful');
  return latest;
}

async function verifyMaintenanceJobs(r, api, readLog, headRef) {
  const e = r.evidence;
  const policy = await api(`commits/${e.validationWorkflowSha}`);
  const ancestry = await api(`compare/${e.validationWorkflowSha}...main`);
  if (!sha(e.validationWorkflowSha) || policy.sha !== e.validationWorkflowSha
    || policy.commit?.verification?.verified !== true || policy.commit.verification.reason !== 'valid'
    || !['ahead', 'identical'].includes(ancestry.status) || ancestry.merge_base_commit?.sha !== e.validationWorkflowSha) throw new Error('Maintenance policy is not an adopted signed source');
  const jobs = await evidencePages(api, `actions/runs/${e.validationRunId}/attempts/${e.validationRunAttempt}/jobs`, 'jobs');
  const records = [];
  for (const [phase, id, name, digest] of [
    ['source', e.validationSourceJobId, 'Maintenance source identity', e.validationSourceLogSha256],
    ['final', e.validationFinalJobId, 'SPLRAD Maintenance Validation', e.validationFinalLogSha256],
  ]) {
    const job = jobs.find(value => value.id === id);
    if (!job || job.run_id !== e.validationRunId || job.run_attempt !== e.validationRunAttempt
      || job.head_sha !== r.reviewedHead || job.name !== name || job.status !== 'completed' || job.conclusion !== 'success') throw new Error('Maintenance job is not bound to the selected attempt');
    const log = await readLog(id);
    if (typeof log !== 'string' || createHash('sha256').update(log).digest('hex') !== digest) throw new Error('Maintenance job log digest changed');
    const candidates = log.split(/\r?\n/).flatMap(line => {
      const match = /^\d{4}-\d\d-\d\dT\S+Z (\{.*\})$/.exec(line);
      if (!match) return [];
      try { const value = JSON.parse(match[1]); return value.phase === phase ? [value] : []; } catch { return []; }
    });
    const value = candidates[0];
    if (candidates.length !== 1 || value.repositoryId !== 1296724484 || value.pullNumber !== r.pullNumber
      || value.head !== r.reviewedHead || value.headRef !== headRef || value.policy !== e.validationWorkflowSha
      || value.runId !== String(e.validationRunId) || value.attempt !== String(e.validationRunAttempt)
      || !sha(value.base) || !sha(value.merge) || value.liveMerge !== value.merge
      || value.deployment !== 'NOT_AUTHORIZED') throw new Error('Maintenance job record identity mismatch');
    records.push(value);
  }
  if (records[0].base !== records[1].base || records[0].merge !== records[1].merge) throw new Error('Maintenance source/final merge identity changed');
}

export async function verifyAdoptionSource(r, api, pull, readLog) {
  // Defense against operator mistakes, not a sandbox for candidate code. The central
  // operator must independently approve the protected merged source before starting Node.
  if (pull.repository?.nameWithOwner !== r.repository || pull.number !== r.pullNumber || pull.isDraft || pull.headRefOid !== r.reviewedHead
    || pull.headRepository?.nameWithOwner !== r.repository || pull.baseRefName !== 'maintenance/legacy-runtime-e990eda'
    || pull.state !== 'MERGED' || pull.mergeCommit?.oid !== r.deploymentHead) throw new Error('Adopted PR/head or merge identity changed');
  for (const [commitSha, tree] of [[r.reviewedHead, r.reviewedTree], [r.deploymentHead, r.deploymentTree]]) {
    const commit = await api(`commits/${commitSha}`);
    if (commit.sha !== commitSha || commit.commit?.tree?.sha !== tree || commit.commit?.verification?.verified !== true || commit.commit.verification.reason !== 'valid') throw new Error('Adopted commit/tree/signature mismatch');
  }
  const associations = await evidencePages(api, `commits/${r.reviewedHead}/pulls`);
  const candidates = associations.filter(p => p.head?.sha === r.reviewedHead && p.head?.ref === pull.headRefName
    && p.head?.repo?.full_name === r.repository);
  if (candidates.length !== 1 || !candidates.some(p => p.number === r.pullNumber
    && p.head?.repo?.full_name === r.repository && p.base?.repo?.full_name === r.repository
    && p.base?.ref === pull.baseRefName && p.merge_commit_sha === r.deploymentHead)) throw new Error('Reviewed commit is not associated with the adopted PR');
  let copilotRun;
  // Native merged-PR evidence can have empty associations. Empty arrays are accepted only
  // alongside the independently bound maintenance job records and PR-specific review.
  const boundPull = value => Array.isArray(value.pull_requests) && (value.pull_requests.length === 0
    || value.pull_requests.every(p => p.number === r.pullNumber && p.head?.sha === r.reviewedHead));
  for (const [id, attempt, path] of [[r.evidence.validationRunId, r.evidence.validationRunAttempt, maintenanceWorkflow], [r.evidence.copilotRunId, r.evidence.copilotRunAttempt, 'dynamic/agents/copilot-pull-request-reviewer']]) {
    const evidence = await api(`actions/runs/${id}`);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || evidence.run_attempt !== attempt
      || evidence.head_sha !== r.reviewedHead || evidence.status !== 'completed' || evidence.conclusion !== 'success'
      || evidence.id !== id || evidence.repository?.full_name !== r.repository || evidence.head_repository?.full_name !== r.repository
      || evidence.head_branch !== pull.headRefName || evidence.path !== path || !boundPull(evidence)) throw new Error('Adopted validation/review run is not successful for reviewed head');
    if (id === r.evidence.validationRunId) {
      if (evidence.event !== 'pull_request' || evidence.workflow_id !== 413829468) throw new Error('Unexpected maintenance validation source');
      const suite = await api(`check-suites/${evidence.check_suite_id}`);
      if (suite.id !== evidence.check_suite_id || suite.head_sha !== r.reviewedHead || suite.app?.id !== 15368) throw new Error('Maintenance validation is not a GitHub Actions check suite');
      await verifyMaintenanceJobs(r, api, readLog, pull.headRefName);
    }
    if (id === r.evidence.copilotRunId) {
      if (evidence.event !== 'dynamic') throw new Error('Expected native dynamic Copilot review');
      copilotRun = evidence;
    }
  }
  const check = await api(`check-runs/${r.evidence.copilotCheckRunId}`);
  if (check.name !== 'copilot-pull-request-reviewer' || check.app?.id !== 15368 || check.head_sha !== r.reviewedHead
    || check.status !== 'completed' || check.conclusion !== 'success' || !boundPull(check)
    || !Number.isSafeInteger(copilotRun?.check_suite_id) || check.check_suite?.id !== copilotRun.check_suite_id) throw new Error('Adopted Copilot check is not bound to PR/head/run/App');
  const review = await api(`pulls/${r.pullNumber}/reviews/${r.evidence.copilotReviewId}`);
  if (review.commit_id !== r.reviewedHead || review.user?.login !== 'copilot-pull-request-reviewer[bot]' || !Number.isFinite(Date.parse(review.submitted_at))
    || !['COMMENTED', 'APPROVED'].includes(review.state) || typeof review.body !== 'string'
    || !review.body.includes('<!-- ccr-overview-v2 -->') || !/(?:<sub>Review effort: (?:Lite|Balanced|Max)<\/sub>|\*\*Review effort:\*\* (?:Lite|Balanced|Max)\b)/u.test(review.body)
    || /^>? ?Copilot (?:was |is )?unable to (?:run|review)\b/im.test(review.body)
    || createHash('sha256').update(review.body).digest('hex') !== r.evidence.copilotReviewBodySha256) throw new Error('Adopted Copilot review mismatch');
  const comment = await api(`issues/comments/${r.evidence.codexCommentId}`);
  if (typeof comment.body !== 'string' || createHash('sha256').update(comment.body).digest('hex') !== r.evidence.codexCommentBodySha256) throw new Error('Adopted Codex comment body changed');
  const match = /codex-review-state:v1 (.*?) -->/.exec(comment.body ?? '');
  const state = match && JSON.parse(match[1]);
  if (comment.user?.login !== 'chatgpt-codex-connector[bot]' || comment.issue_url !== `https://api.github.com/repos/${r.repository}/issues/${r.pullNumber}`
    || !['code_review', 'security_review'].every(key => state?.[key]?.commit_sha === r.reviewedHead && state[key].status === 'completed')) throw new Error('Adopted Codex reviews are not terminal for reviewed head');
  const runs = await evidencePages(api, `actions/runs?head_sha=${r.reviewedHead}`, 'workflow_runs');
  // Do not hide a newer same-source run merely because its PR association is absent or conflicting.
  const scopedRuns = runs.filter(value => value.head_sha === r.reviewedHead && value.repository?.full_name === r.repository);
  const currentValidation = latestEvidence(scopedRuns.filter(value => value.path === maintenanceWorkflow), r.evidence.validationRunId, value => value.run_started_at ?? value.created_at);
  const currentCopilot = latestEvidence(scopedRuns.filter(value => value.path === 'dynamic/agents/copilot-pull-request-reviewer' && value.event === 'dynamic'), r.evidence.copilotRunId, value => value.run_started_at ?? value.created_at);
  if (currentValidation.run_attempt !== r.evidence.validationRunAttempt || currentCopilot.run_attempt !== r.evidence.copilotRunAttempt) throw new Error('Current workflow attempt differs from central adoption record');
  const checks = await evidencePages(api, `commits/${r.reviewedHead}/check-runs?filter=all`, 'check_runs');
  const currentCheck = latestEvidence(checks.filter(value => value.name === 'copilot-pull-request-reviewer' && value.app?.id === 15368
    && value.head_sha === r.reviewedHead), r.evidence.copilotCheckRunId, value => value.started_at);
  if (currentCheck.check_suite?.id !== copilotRun.check_suite_id) throw new Error('Current Copilot check/run binding changed');
  const reviews = await evidencePages(api, `pulls/${r.pullNumber}/reviews`);
  const currentReview = latestEvidence(reviews.filter(value => value.commit_id === r.reviewedHead
    && value.user?.login === 'copilot-pull-request-reviewer[bot]' && value.state !== 'PENDING'), r.evidence.copilotReviewId, value => value.submitted_at, true);
  if (!['COMMENTED', 'APPROVED'].includes(currentReview.state) || typeof currentReview.body !== 'string'
    || createHash('sha256').update(currentReview.body).digest('hex') !== r.evidence.copilotReviewBodySha256) throw new Error('Current adopted review content changed');
  // Findings/disagreements are adjudicated in the central adoption record; null never means zero.
}

export function verifyNativeTarget(r, metadata, version = r.expectedCurrentVersion) {
  const active = metadata.deployments?.deployments?.[0]?.versions;
  if (metadata.script?.enabled !== true || typeof metadata.subdomain?.subdomain !== 'string'
    || r.runtimeOrigin !== `https://${r.workerName}.${metadata.subdomain.subdomain}.workers.dev`
    || !Array.isArray(active) || active.length !== 1 || active[0].version_id !== version || active[0].percentage !== 100) throw new Error('Native Worker origin/deployment differs from adoption record');
}

export async function nativeCloudReader(r) {
  // Reuse cf's native OAuth client: no token is extracted, printed or copied into another process.
  // This internal adapter is verified for this cf release; review it when updating cf.
  const binary = (await run(process.platform === 'win32' ? 'where.exe' : 'which', ['cf'])).stdout.trim().split(/\r?\n/)[0];
  const cfRoot = process.platform === 'win32' ? join(dirname(binary), 'node_modules/cf') : dirname(dirname(await realpath(binary)));
  if (JSON.parse(await readFile(join(cfRoot, 'package.json'), 'utf8')).version !== '1.0.0-beta.27') throw new Error('Review native cf adapter for the installed cf version');
  const dist = join(cfRoot, 'dist');
  const entry = (await readdir(dist)).find(name => /^workers-[A-Za-z0-9_]+\.mjs$/.test(name));
  const source = entry && await readFile(join(dist, entry), 'utf8');
  const auth = source && /from"\.\/(auth-[^"]+\.mjs)"/.exec(source)?.[1];
  if (!auth) throw new Error('Native cf client unavailable');
  const client = await (await import(pathToFileURL(join(dist, auth)).href)).n({});
  const root = `/accounts/${r.accountId}/workers`;
  return async () => ({
    subdomain: await client.send({ method: 'GET', path: () => `${root}/subdomain` }, {}),
    script: await client.send({ method: 'GET', path: () => `${root}/scripts/${r.workerName}/subdomain` }, {}),
    deployments: await client.send({ method: 'GET', path: () => `${root}/scripts/${r.workerName}/deployments` }, {}),
  });
}

/** This verifies only the new-request barrier; inflight reconciliation remains separate. */
export async function runDeploymentTransaction(deploy, verify) {
  const identity = await deploy();
  const evidence = await verify(identity);
  if (evidence?.status !== 'verified' || evidence.version !== identity.version) throw new Error('Retirement probe did not verify the deployed version');
  return { status: 'barrier-installed-and-probed', ...identity };
}

export async function readGithubJobLog(repository, id, executeCommand = run) {
  // Older gh releases emit raw API bodies without the newer terminal-safety flag.
  // Always hash the unmodified stdout; never strip control characters or retry with altered text.
  const help = (await executeCommand('gh', ['api', '--help'])).stdout;
  const flags = /(?:^|\s)--allow-escape-sequences(?:\s|$)/m.test(help) ? ['--allow-escape-sequences'] : [];
  return (await executeCommand('gh', ['api', ...flags, `repos/${repository}/actions/jobs/${id}/logs`])).stdout;
}

export async function deployLegacyRuntime(recordPath) {
  const record = await readAdoptionRecord(recordPath);
  const { deploymentHead: expectedHead, bundleSha256: expectedBundleSha256, runtimeOrigin: runtimeUrl, accountId, policySha, evaluatorSha } = record;
  const api = async path => JSON.parse((await run('gh', ['api', `repos/${record.repository}/${path}`])).stdout);
  const readLog = id => readGithubJobLog(record.repository, id);
  const verifySource = async () => {
    const query = 'query($number:Int!){repository(owner:"splrad",name:"steward"){pullRequest(number:$number){number state isDraft headRefOid headRefName baseRefName headRepository{nameWithOwner} repository{nameWithOwner} mergeCommit{oid}}}}';
    const response = JSON.parse((await run('gh', ['api', 'graphql', '-f', `query=${query}`, '-F', `number=${record.pullNumber}`])).stdout);
    await verifyAdoptionSource(record, api, response.data?.repository?.pullRequest ?? {}, readLog);
  };
  await verifySource();
  const readCloud = await nativeCloudReader(record);
  verifyNativeTarget(record, await readCloud());
  const nodeVersion = (await readFile('.node-version', 'utf8')).trim();
  if (process.version !== `v${nodeVersion}`) throw new Error('Use the reviewed source toolchain');
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const installed = JSON.parse(await readFile('node_modules/wrangler/package.json', 'utf8'));
  if (installed.version !== lock.packages['node_modules/wrangler']?.version) throw new Error('Wrangler differs from the reviewed lock');
  const assertSource = async () => {
    if ((await run('git', ['rev-parse', 'HEAD'])).stdout.trim() !== expectedHead
      || (await run('git', ['status', '--porcelain', '--untracked-files=all'])).stdout.trim()) throw new Error('Deployment checkout is not the exact clean reviewed head');
  };
  await assertSource();
  for (const directory of ['.', 'packages/runtime']) {
    if ((await readdir(directory)).some(name => /^\.(?:env|dev\.vars)(?:\.|$)/.test(name))) throw new Error('Local environment files are not permitted in the deployment checkout');
  }
  const output = await mkdtemp(join(tmpdir(), 'legacy-runtime-reviewed-'));
  const cli = resolve('node_modules/wrangler/bin/wrangler.js');
  const config = ['--config', 'packages/runtime/wrangler.toml', '--name', 'splrad-steward-runtime'];
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: 'false' };
  await run(process.execPath, [cli, 'deploy', '--dry-run', ...config, '--outdir', output], { env });
  const bundle = join(output, 'index.js');
  if (createHash('sha256').update(await readFile(bundle)).digest('hex') !== expectedBundleSha256) throw new Error('Rebuilt Worker differs from the reviewed digest');
  await assertSource();
  if (Date.parse(record.window.expiresAt) <= Date.now()) throw new Error('Adoption window expired');
  await verifySource();
  verifyNativeTarget(record, await readCloud());
  if (JSON.stringify(await readAdoptionRecord(recordPath)) !== JSON.stringify(record)) throw new Error('Central adoption record changed');
  // No D1 migrations command and no invocation of the historical deployment workflow.
  return runDeploymentTransaction(async () => {
    const result = await run(process.execPath, [cli, 'deploy', bundle, '--no-bundle', ...config, '--keep-vars',
      '--var', 'LEGACY_RELEASE_RETIRED:true', '--var', `POLICY_SHA:${policySha}`, '--var', `WORKFLOW_EVALUATOR_SHA:${evaluatorSha}`], { env });
    const versions = [...result.stdout.matchAll(/Current Version ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/g)];
    if (versions.length !== 1) throw new Error('Deployment returned no unambiguous version; reconcile before retrying');
    return { version: versions[0][1], policySha, evaluatorSha, head: expectedHead, bundleSha256: expectedBundleSha256 };
  }, async identity => {
    verifyNativeTarget(record, await readCloud(), identity.version);
    return verifyLegacyRuntimeRetirement({ url: runtimeUrl, ...identity });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Provide exactly one central adoption record path');
  console.log(JSON.stringify(await deployLegacyRuntime(process.argv[2])));
}
