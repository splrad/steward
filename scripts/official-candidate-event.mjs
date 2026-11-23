import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import apiVersion from '../config/github-api.json' with { type: 'json' };
import { pathToFileURL } from 'node:url';
import { GitHub, Manifest, VERSION } from 'release-please-official';
import { downloadNativeArtifact, NativeEvidenceReader, nativeEvidenceTransport, nativeReleaseApp } from '../packages/runner/dist/index.js';
import { entryGuard } from './bounded-release-entry.mjs';
import { releaseParticipation } from './release-coordinator.mjs';
import { assertReleaseUnpaused, releaseIsPaused } from './release-pause-policy.mjs';
import { bodyDigest, defaultHead, fitsOfficialEvent, hasLabel, officialConfig, officialPending, officialRef, officialRootSettings, officialTagged,
  pages, pullBinding, readOfficialConfig, readOfficialManifest, renderOfficialPull, requireCandidate,
  verifyOfficialPull } from './official-release-candidate.mjs';

const central = 'splrad/steward';
const botId = 301115370;
const templatePath = new URL('../templates/repository/.github/release-template.md.mustache', import.meta.url);
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const inputs = {
  push: 'kind,repositoryId,sourceSha',
  'official-edit': 'bodyDigest,head,kind,prNumber,repositoryId,titleDigest',
  'official-refresh': 'head,kind,prNumber,releasedSha,repositoryId',
};
const fetchJson = async (token, path, method = 'GET', data) => {
  const result = await fetch('https://api.github.com' + path, { method, redirect: 'error',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'X-GitHub-Api-Version': apiVersion.version },
    ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(60_000) });
  requireCandidate(result.ok, 'HTTP_' + result.status);
  return result.json();
};

const stateDirectory = '.official-candidate';
const stateFile = name => join(stateDirectory, name + '.json');
const write = (name, data) => writeFile(stateFile(name), JSON.stringify(data) + '\n', { flag: 'wx' });

export function candidateEvent(event, requestKey) {
  requireCandidate(event && Object.keys(event).sort().join(',') === inputs[event.kind] &&
    positive(event.repositoryId), 'EVENT');
  const locator = event.kind === 'push' && validSha(event.sourceSha)
    ? [event.sourceSha]
    : event.kind === 'official-edit' && positive(event.prNumber) && validSha(event.head) &&
      /^[a-f0-9]{64}$/.test(event.bodyDigest) && /^[a-f0-9]{64}$/.test(event.titleDigest)
      ? [event.prNumber, event.head, event.bodyDigest, event.titleDigest]
      : event.kind === 'official-refresh' && positive(event.prNumber) && validSha(event.head) && validSha(event.releasedSha)
        ? [event.prNumber, event.head, event.releasedSha] : null;
  requireCandidate(locator && bodyDigest(JSON.stringify([event.repositoryId, event.kind, ...locator])) === requestKey, 'EVENT_KEY');
  return event;
}

function target(repository, id) {
  requireCandidate(repository.id === id && repository.owner?.id === 302208797
    && /^splrad\/[A-Za-z0-9_.-]+$/.test(repository.full_name) && repository.private === false
    && repository.visibility === 'public' && repository.archived === false && repository.disabled === false
    && repository.fork === false && /^[A-Za-z0-9._/-]+$/.test(repository.default_branch), 'REPOSITORY');
  return { id, name: repository.full_name, defaultBranch: repository.default_branch };
}

export function officialCandidateRoute(event, settings, enabled, trialId) {
  requireCandidate(typeof settings?.['separate-pull-requests'] === 'boolean', 'ROUTE');
  const official = officialConfig(settings);
  if (!event.kind) return official ? { result: 'official_candidate_adopted' } : { route: 'legacy' };
  if (!official) return { result: event.kind === 'push' ? 'legacy_cycle_route' : 'legacy_product' };
  if (enabled !== 'true' && String(event.repositoryId) !== trialId) return { result: 'official_candidate_disabled' };
  requireCandidate(officialRootSettings(settings), 'ROOT_CONFIG');
  return { route: 'official' };
}

async function identify(env) {
  const supplied = JSON.parse(env.BOUNDED_EVENT_JSON);
  const event = supplied?.kind ? candidateEvent(supplied, env.BOUNDED_REQUEST_KEY) : supplied;
  const legacy = event && Object.keys(event).sort().join(',') === 'eventId,prNumber,repositoryId' &&
    positive(event.repositoryId) && positive(event.eventId) && positive(event.prNumber);
  requireCandidate((event?.kind || legacy) && /^[a-f0-9]{64}$/.test(env.BOUNDED_REQUEST_KEY)
    && env.GITHUB_ACTOR_ID === String(botId)
    && env.STEWARD_CONTROLLER_SHA === env.BOUNDED_POLICY_SHA
    && (legacy || event.kind === 'official-refresh' ? validSha(env.BOUNDED_SOURCE_SHA) :
      env.BOUNDED_SOURCE_SHA === (event.sourceSha ?? event.head)), 'ENTRY');
  const io = nativeEvidenceTransport(env.STEWARD_CENTRAL_TOKEN);
  const centralReader = new NativeEvidenceReader(io, central);
  const config = JSON.parse(await readFile(new URL('../config/bounded-recheck.json', import.meta.url), 'utf8'));
  const run = await entryGuard(env, path => centralReader.json(path.slice(('/repos/' + central).length).replace(/^\//, '')), config);
  requireCandidate(run.actor?.id === botId && run.display_title === 'Candidate event ' + env.BOUNDED_REQUEST_KEY, 'CONTROLLER');
  const repositoryPath = '/repositories/' + event.repositoryId;
  let response = await io.request('GET', repositoryPath);
  if ([403, 404].includes(response.status)) response = await io.anonymous().request('GET', repositoryPath);
  requireCandidate(response.status === 200, 'REPOSITORY');
  const repository = JSON.parse(response.bytes);
  const product = target(repository, event.repositoryId);
  const app = await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY ?? '');
  const identity = { event, product, sourceSha: env.BOUNDED_SOURCE_SHA, controllerSha: run.head_sha,
    requestKey: env.BOUNDED_REQUEST_KEY, runId: run.id };
  const finish = async result => {
    // The bounded legacy consumer can only validate its original Git-backed receipt.
    requireCandidate(!legacy, result === 'paused' ? 'PAUSED' : 'ROUTE');
    await writeFile('result.json', JSON.stringify({ schemaVersion: 1, ...identity, result }) + '\n', { flag: 'wx' });
    await appendFile(env.GITHUB_OUTPUT, 'route=complete\n');
  };
  if (await releaseIsPaused(app, product.id)) return finish('paused');
  const route = await app.forCandidateReadRepository(product.id, async token => {
    const reader = new NativeEvidenceReader(nativeEvidenceTransport(token), product.name);
    const get = path => reader.json(path);
    const source = await defaultHead(get, product.defaultBranch);
    const settings = await readOfficialConfig(get, source);
    requireCandidate(await defaultHead(get, product.defaultBranch) === source, 'SOURCE_CHANGED');
    return officialCandidateRoute(event, settings,
      env.STEWARD_OFFICIAL_CANDIDATES_ENABLED, env.STEWARD_OFFICIAL_RELEASE_TRIAL_REPOSITORY_ID);
  });
  if (route.result) return finish(route.result);
  if (route.route === 'legacy') return appendFile(env.GITHUB_OUTPUT, 'route=legacy\n');
  requireCandidate((await centralReader.json('git/ref/heads/steward/validated-controller')).object?.sha === run.head_sha, 'CONTROLLER');
  await mkdir(stateDirectory);
  await write('identity', identity);
  await appendFile(env.GITHUB_OUTPUT, 'route=official\nrepo=' + product.name.split('/')[1] + '\nbranch=' + product.defaultBranch + '\n');
}

async function assertCandidateUnpaused(env, repositoryId) {
  const app = await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY ?? '');
  await assertReleaseUnpaused(app, repositoryId);
}

async function scopedReader(token, product) {
  const scope = await fetchJson(token, '/installation/repositories?per_page=100');
  requireCandidate(scope.total_count === 1 && scope.repositories?.length === 1, 'TOKEN_SCOPE');
  const actual = target(scope.repositories[0], product.id);
  requireCandidate(actual.name === product.name && actual.defaultBranch === product.defaultBranch, 'TOKEN_SCOPE');
  const reader = new NativeEvidenceReader(nativeEvidenceTransport(token), product.name);
  return {
    get: path => reader.json(path),
    patch: (number, body) => fetchJson(token, '/repos/' + product.name + '/pulls/' + number, 'PATCH', { body }),
  };
}

const onOfficialBranch = (pull, product) => {
  const ref = pull.head?.ref;
  return pull.head?.repo?.id === product.id && (officialRef(ref, product.defaultBranch) ||
    (typeof ref === 'string' && ref.startsWith('release-please--branches--' + product.defaultBranch + '--components--')));
};

async function openOfficialPulls(get, product) {
  const pulls = await pages(get, 'pulls?state=open&base=' + encodeURIComponent(product.defaultBranch));
  const official = pulls.filter(pull => onOfficialBranch(pull, product));
  for (const pull of official) pullBinding(pull, product, pull.number, botId);
  requireCandidate(new Set(official.map(pr => pr.head.ref)).size === official.length, 'AMBIGUOUS_BRANCH');
  return official;
}

async function inspectWaiting(get, product) {
  const pending = await pages(get, 'issues?state=closed&labels=' + encodeURIComponent(officialPending));
  const pulls = await Promise.all(pending.filter(issue => issue.pull_request).map(issue => get('pulls/' + issue.number)));
  return pulls.filter(pr => pr.merged === true && pr.base?.ref === product.defaultBranch &&
    onOfficialBranch(pr, product)).map(pr => {
    pullBinding(pr, product, pr.number, botId);
    requireCandidate(hasLabel(pr, officialPending), 'PENDING_CHANGED');
    return pr.number;
  });
}

async function downloadCheckpoint(centralReader, env, identity, name) {
  const artifacts = await centralReader.pages('actions/runs/' + identity.runId + '/artifacts?name=' +
    encodeURIComponent('official-candidate-' + name + '-' + identity.runId), 'artifacts');
  if (!artifacts.length) return false;
  requireCandidate(artifacts.length === 1 && artifacts[0].expired === false, 'CHECKPOINT');
  const artifact = artifacts[0], directory = join(stateDirectory, 'previous-' + name);
  requireCandidate(artifact.workflow_run?.id === identity.runId && artifact.workflow_run?.head_sha === identity.controllerSha, 'CHECKPOINT_RUN');
  await downloadNativeArtifact({ fullName: central, artifactId: artifact.id, digest: artifact.digest,
    names: [name + '.json'], directory, policyDirectory: process.cwd(), home: stateDirectory }, env.STEWARD_CENTRAL_TOKEN);
  const stored = JSON.parse(await readFile(join(directory, name + '.json'), 'utf8'));
  requireCandidate(stored.runId === identity.runId && stored.requestKey === identity.requestKey &&
    stored.controllerSha === identity.controllerSha && stored.sourceSha === identity.sourceSha, 'CHECKPOINT_INPUT');
  await write(name, stored);
  return true;
}

export async function officialActionWasSkipped(readJobs, runId, runAttempt) {
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 2) return false;
  for (let attempt = 1; attempt < runAttempt; attempt++) {
    const jobs = await readJobs(attempt);
    if (jobs.length !== 1) return false;
    const [job] = jobs;
    if (job.run_id !== runId || job.run_attempt !== attempt || job.name !== 'event' || job.status !== 'completed') return false;
    if (job.conclusion === 'skipped' && (!job.steps || job.steps.length === 0)) continue;
    const steps = job.steps?.filter(step => step.name === 'Refresh the official candidate');
    if (steps?.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'skipped') return false;
  }
  return true;
}

export async function prepareOfficialPush({ identity, get, prepareParticipation, restore, checkBranch, actionWasSkipped = async () => false }) {
  const { product, event, runId, requestKey, controllerSha, sourceSha } = identity;
  if (await defaultHead(get, product.defaultBranch) !== sourceSha) return { result: 'source_changed' };
  const [state, settings, manifest] = await Promise.all([
    prepareParticipation(), readOfficialConfig(get, sourceSha), readOfficialManifest(get, sourceSha),
  ]);
  requireCandidate(state.status === 'APPLICABLE' && state.sourceSha === sourceSha && officialRootSettings(settings), 'ROOT_CONFIG');
  requireCandidate(await defaultHead(get, product.defaultBranch) === sourceSha, 'SOURCE_CHANGED');
  const reserved = await restore('before');
  if (reserved && await restore('after')) return { mode: 'resume' };
  if (reserved) requireCandidate(await actionWasSkipped(), 'ACTION_RESULT_UNKNOWN');
  if (event.kind === 'official-refresh') {
    const released = await get('pulls/' + event.prNumber);
    pullBinding(released, product, event.prNumber, botId);
    requireCandidate(released.state === 'closed' && released.merged === true && released.head.sha === event.head &&
      released.merge_commit_sha === event.releasedSha && hasLabel(released, officialTagged) &&
      !hasLabel(released, officialPending), 'REFRESH_ORIGIN');
  }
  const waiting = await inspectWaiting(get, product);
  if (waiting.length) return { result: 'merged_pending', waiting };
  const open = await openOfficialPulls(get, product);
  const initial = await Promise.all(open.map(async pr => {
    const commit = await get('git/commits/' + pr.head.sha);
    requireCandidate(commit.sha === pr.head.sha && commit.parents?.length === 1, 'PR_PARENT');
    return { number: pr.number, head: pr.head.sha, sourceSha: commit.parents[0].sha };
  }));
  if (initial.length === 1 && initial[0].sourceSha === sourceSha) return { result: 'candidate_unchanged' };
  await checkBranch();
  requireCandidate(await defaultHead(get, product.defaultBranch) === sourceSha, 'SOURCE_CHANGED');
  if (reserved) return { mode: 'action', reservation: 'existing' };
  return { mode: 'action', reservation: 'new', checkpoint: { runId, requestKey, controllerSha, sourceSha,
    configDigest: bodyDigest(JSON.stringify(settings)), manifestDigest: bodyDigest(JSON.stringify(manifest)), initial } };
}

async function requireRootBranch(product, token) {
  requireCandidate(VERSION === '17.6.0', 'CORE_VERSION');
  const [owner, repo] = product.name.split('/');
  const github = await GitHub.create({ owner, repo, token, defaultBranch: product.defaultBranch });
  const manifest = await Manifest.fromManifest(github, product.defaultBranch);
  const strategies = await manifest.getStrategiesByPath();
  requireCandidate(Object.keys(strategies).length === 1 && strategies['.'] &&
    !(await strategies['.'].getBranchComponent()), 'ROOT_BRANCH');
}

export function officialActionResult(outputs, before) {
  const values = JSON.parse(outputs || '[]');
  requireCandidate(Array.isArray(values) && values.every(x => positive(x.number) && typeof x.body === 'string' &&
    typeof x.headBranchName === 'string' && typeof x.baseBranchName === 'string') &&
    new Set(values.map(x => x.number)).size === values.length, 'ACTION_OUTPUT');
  return { ...before, output: values.map(({number, body, headBranchName, baseBranchName}) =>
    ({ number, upstreamDigest: bodyDigest(body), headBranchName, baseBranchName })) };
}

export async function captureOfficialAction({ checkpoint, product, get }) {
  const { output: values, ...before } = checkpoint;
  const pulls = [];
  for (const value of values) {
    const pull = await get('pulls/' + value.number);
    pullBinding(pull, product, value.number, botId);
    requireCandidate(pull.head.ref === value.headBranchName && value.baseBranchName === product.defaultBranch, 'ACTION_PR');
    if (pull.state !== 'open' || pull.merged === true) continue;
    if (before.initial.some(pr => pr.number === pull.number && pr.head === pull.head.sha)) continue;
    requireCandidate(hasLabel(pull, officialPending), 'ACTION_PR');
    const commit = await get('git/commits/' + pull.head.sha);
    requireCandidate(commit.sha === pull.head.sha && commit.parents?.length === 1 &&
      commit.parents[0].sha === before.sourceSha, 'ACTION_BASE_MOVED');
    pulls.push({ number: pull.number, head: pull.head.sha, upstreamDigest: value.upstreamDigest });
  }
  return { ...before, pulls };
}

export async function finishOfficialPull({ product, get, patch, sourceSha, checkpoint, template, admit, render = renderOfficialPull }) {
  let pull = await get('pulls/' + checkpoint.number);
  pullBinding(pull, product, checkpoint.number, botId);
  if (pull.state !== 'open' || pull.merged === true || pull.head.sha !== checkpoint.head ||
      await defaultHead(get, product.defaultBranch) !== sourceSha) return { number: pull.number, status: 'superseded' };
  requireCandidate(hasLabel(pull, officialPending), 'ACTION_PR');
  const validateEdit = async current => {
    const [settings, manifest] = await Promise.all([readOfficialConfig(get, sourceSha), readOfficialManifest(get, current.head.sha)]);
    const notes = verifyOfficialPull(current, product, current.number, botId, settings, manifest);
    return { number: current.number, head: current.head.sha, status: 'body_retained', bodyDigest: notes.bodyDigest };
  };
  if (bodyDigest(pull.body) !== checkpoint.upstreamDigest) return validateEdit(pull);
  const proposal = await render(pull, product, get, botId, sourceSha, template);
  await admit();
  if (await defaultHead(get, product.defaultBranch) !== sourceSha) return { number: pull.number, status: 'superseded' };
  pull = await get('pulls/' + checkpoint.number);
  pullBinding(pull, product, checkpoint.number, botId);
  if (pull.state !== 'open' || pull.merged === true || pull.head.sha !== checkpoint.head) return { number: pull.number, status: 'superseded' };
  if (bodyDigest(pull.body) !== checkpoint.upstreamDigest) return validateEdit(pull);
  try { await patch(pull.number, proposal.body); } catch { /* Read native state after an unknown PATCH response. */ }
  const actual = await get('pulls/' + pull.number);
  pullBinding(actual, product, pull.number, botId);
  requireCandidate(actual.head.sha === checkpoint.head && actual.state === 'open' && actual.merged !== true
    && actual.body === proposal.body, 'BODY_WRITE_UNKNOWN');
  return { number: pull.number, head: checkpoint.head, status: 'rendered', templateDigest: proposal.templateDigest,
    bodyDigest: proposal.notes.bodyDigest };
}

async function checkEdited(identity, get) {
  const { event, product } = identity;
  const pull = await get('pulls/' + event.prNumber);
  pullBinding(pull, product, event.prNumber, botId);
  if (pull.state !== 'open' || pull.merged === true || pull.head.sha !== event.head ||
    typeof pull.body !== 'string' || bodyDigest(pull.body) !== event.bodyDigest ||
    bodyDigest(pull.title) !== event.titleDigest) return { status: 'superseded' };
  requireCandidate(fitsOfficialEvent(pull.body), 'BODY_LIMIT');
  const sourceSha = await defaultHead(get, product.defaultBranch);
  const [settings, manifest] = await Promise.all([readOfficialConfig(get, sourceSha), readOfficialManifest(get, event.head)]);
  const notes = verifyOfficialPull(pull, product, event.prNumber, botId, settings, manifest);
  return { status: 'verified', number: pull.number, head: event.head, bodyDigest: notes.bodyDigest };
}

export async function main(stage, env = process.env) {
  if (stage === 'identify') return identify(env);
  const identity = JSON.parse(await readFile(stateFile('identity'), 'utf8'));
  if (stage === 'capture') {
    const before = JSON.parse(await readFile(stateFile('before'), 'utf8'));
    return write('after', officialActionResult(env.OFFICIAL_ACTION_PRS, before));
  }
  const token = env.STEWARD_CANDIDATE_TOKEN;
  const { get, patch } = await scopedReader(token, identity.product);
  const { event, product } = identity;
  if (stage === 'prepare') {
    const centralReader = new NativeEvidenceReader(nativeEvidenceTransport(env.STEWARD_CENTRAL_TOKEN), central);
    const plan = event.kind === 'official-edit' ? { result: await checkEdited(identity, get) }
      : await prepareOfficialPush({ identity, get, restore: name => Number(env.GITHUB_RUN_ATTEMPT) > 1 &&
        downloadCheckpoint(centralReader, env, identity, name),
      actionWasSkipped: () => officialActionWasSkipped(attempt =>
        centralReader.pages('actions/runs/' + identity.runId + '/attempts/' + attempt + '/jobs', 'jobs'),
        identity.runId, Number(env.GITHUB_RUN_ATTEMPT)),
      checkBranch: () => requireRootBranch(product, token),
      prepareParticipation: () => releaseParticipation({ id: product.id, full_name: product.name,
        default_branch: product.defaultBranch }, nativeEvidenceTransport(token), { requireWorkflowGitHubDelivery: true }) });
    if (plan.checkpoint) await write('before', plan.checkpoint);
    await write('plan', { mode: plan.mode ?? null, result: plan.result ?? null, waiting: plan.waiting ?? [] });
    await appendFile(env.GITHUB_OUTPUT, 'mode=' + (plan.mode ?? 'complete') + '\nreservation=' + (plan.reservation ?? '') + '\n');
    return;
  }
  if (stage === 'check-action-source') {
    requireCandidate(await defaultHead(get, product.defaultBranch) === identity.sourceSha, 'SOURCE_CHANGED');
    await assertCandidateUnpaused(env, product.id);
    return;
  }
  requireCandidate(stage === 'finish', 'STAGE');
  const plan = JSON.parse(await readFile(stateFile('plan'), 'utf8'));
  let result = plan.result, pulls = [], waiting = plan.waiting;
  if (plan.mode) {
    const checkpoint = JSON.parse(await readFile(stateFile('after'), 'utf8'));
    const after = await captureOfficialAction({ checkpoint, product, get });
    const template = await readFile(templatePath, 'utf8');
    const admit = () => assertCandidateUnpaused(env, product.id);
    for (const checkpoint of after.pulls) pulls.push(await finishOfficialPull({
      product, get, patch, sourceSha: identity.sourceSha, checkpoint, template, admit,
    }));
    if (!pulls.length && !checkpoint.output.length) waiting = await inspectWaiting(get, product);
    result = pulls.length ? 'candidate_observed' : waiting.length ? 'merged_pending' : 'no_candidate_change';
  }
  await writeFile('result.json', JSON.stringify({ schemaVersion: 1, ...identity, result, pulls, waiting,
    templateDigest: pulls.length ? bodyDigest(await readFile(templatePath)) : null }) + '\n', { flag: 'wx' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => {
    console.error(/^OFFICIAL_CANDIDATE_[A-Z_0-9]+$/.test(error?.message) ||
      ['RELEASE_REPOSITORY_PAUSED','RELEASE_PAUSE_POLICY_UNAVAILABLE'].includes(error?.message) ? error.message : 'OFFICIAL_CANDIDATE_STOPPED');
    process.exitCode = 1;
  });
}
