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
    || ![r.evidence?.validationRunId, r.evidence?.copilotRunId, r.evidence?.copilotReviewId, r.evidence?.copilotCheckRunId, r.evidence?.codexCommentId].every(v => Number.isSafeInteger(v) && v > 0)
    || !/^[a-f0-9]{64}$/.test(r.evidence?.copilotReviewBodySha256) || typeof r.evidence?.reviewDecisionReference !== 'string' || !r.evidence.reviewDecisionReference.trim()) throw new Error('Incomplete central adoption record');
  const origin = new URL(r.runtimeOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.search || origin.hash || origin.pathname !== '/' || origin.origin !== r.runtimeOrigin) throw new Error('Noncanonical adoption origin');
  return r;
}

export async function verifyAdoptionSource(r, api, pull) {
  if (pull.repository?.nameWithOwner !== r.repository || pull.number !== r.pullNumber || pull.isDraft || pull.headRefOid !== r.reviewedHead
    || !['OPEN', 'MERGED'].includes(pull.state) || (r.deploymentHead !== r.reviewedHead && (pull.state !== 'MERGED' || pull.mergeCommit?.oid !== r.deploymentHead))) throw new Error('Adopted PR/head or merge identity changed');
  for (const [commitSha, tree] of [[r.reviewedHead, r.reviewedTree], [r.deploymentHead, r.deploymentTree]]) {
    const commit = await api(`commits/${commitSha}`);
    if (commit.sha !== commitSha || commit.commit?.tree?.sha !== tree || commit.commit?.verification?.verified !== true || commit.commit.verification.reason !== 'valid') throw new Error('Adopted commit/tree/signature mismatch');
  }
  let copilotRun;
  const boundPull = value => Array.isArray(value.pull_requests) && value.pull_requests.some(p => p.number === r.pullNumber && p.head?.sha === r.reviewedHead);
  for (const [id, path] of [[r.evidence.validationRunId, '.github/workflows/pr-validation.yml'], [r.evidence.copilotRunId, 'dynamic/agents/copilot-pull-request-reviewer']]) {
    const evidence = await api(`actions/runs/${id}`);
    if (evidence.head_sha !== r.reviewedHead || evidence.status !== 'completed' || evidence.conclusion !== 'success'
      || evidence.repository?.full_name !== r.repository || evidence.path !== path || !boundPull(evidence)) throw new Error('Adopted validation/review run is not successful for reviewed head');
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
    || !review.body.includes('<!-- ccr-overview-v2 -->') || !/<sub>Review effort: (?:Lite|Balanced|Max)<\/sub>/.test(review.body)
    || /^>? ?Copilot (?:was |is )?unable to (?:run|review)\b/im.test(review.body)
    || createHash('sha256').update(review.body).digest('hex') !== r.evidence.copilotReviewBodySha256) throw new Error('Adopted Copilot review mismatch');
  const comment = await api(`issues/comments/${r.evidence.codexCommentId}`);
  const match = /codex-review-state:v1 (.*?) -->/.exec(comment.body ?? '');
  const state = match && JSON.parse(match[1]);
  if (comment.user?.login !== 'chatgpt-codex-connector[bot]' || comment.issue_url !== `https://api.github.com/repos/${r.repository}/issues/${r.pullNumber}`
    || !['code_review', 'security_review'].every(key => state?.[key]?.commit_sha === r.reviewedHead && state[key].status === 'completed')) throw new Error('Adopted Codex reviews are not terminal for reviewed head');
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

export async function deployLegacyRuntime(recordPath) {
  const record = await readAdoptionRecord(recordPath);
  const { deploymentHead: expectedHead, bundleSha256: expectedBundleSha256, runtimeOrigin: runtimeUrl, accountId, policySha, evaluatorSha } = record;
  const api = async path => JSON.parse((await run('gh', ['api', `repos/${record.repository}/${path}`])).stdout);
  const verifySource = async () => {
    const query = 'query($number:Int!){repository(owner:"splrad",name:"steward"){pullRequest(number:$number){number state isDraft headRefOid repository{nameWithOwner} mergeCommit{oid}}}}';
    const response = JSON.parse((await run('gh', ['api', 'graphql', '-f', `query=${query}`, '-F', `number=${record.pullNumber}`])).stdout);
    await verifyAdoptionSource(record, api, response.data?.repository?.pullRequest ?? {});
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
