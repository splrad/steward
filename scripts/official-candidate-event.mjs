import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import apiVersion from '../config/github-api.json' with { type: 'json' };
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copilotReleaseClient, NativeEvidenceReader, nativeEvidenceTransport, nativeReleaseApp } from '../packages/runner/dist/index.js';
import { entryGuard } from './bounded-release-entry.mjs';
import { fetchState, releaseParticipation } from './release-coordinator.mjs';
import { assertReleaseUnpaused, releaseIsPaused } from './release-pause-policy.mjs';
import { compatibleExistingCandidate, openOfficialPull, verifyCandidateDraft, writeOfficialCandidate } from './official-candidate-write.mjs';
import { bodyDigest, candidateBaseline, computeOfficialCandidate, defaultHead, draftOfficialCandidate, fitsOfficialEvent,
  hasLabel, officialCandidateEvidence, officialCandidateRoundId, officialConfig, officialPending, officialRef, officialRootSettings, officialTagged,
  pages, pullBinding, readOfficialConfig, readOfficialManifest, requireCandidate,
  verifyOfficialPull } from './official-release-candidate.mjs';

const central = 'splrad/steward';
const botId = 301115370;
const botIdentity = { name: 'splrad-steward[bot]', email: '301115370+splrad-steward[bot]@users.noreply.github.com' };
const controllerDirectory = fileURLToPath(new URL('../', import.meta.url));
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
  if (!result.ok) throw Object.assign(new Error('OFFICIAL_CANDIDATE_HTTP_' + result.status), { status: result.status });
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

export function officialCandidateRoute(settings, enabled) {
  requireCandidate(typeof settings?.['separate-pull-requests'] === 'boolean', 'ROUTE');
  const official = officialConfig(settings);
  if (!official) return { result: 'official_candidate_not_adopted' };
  if (enabled !== 'true') return { result: 'official_candidate_disabled' };
  requireCandidate(officialRootSettings(settings), 'ROOT_CONFIG');
  return { route: 'official' };
}

async function identify(env) {
  const event = candidateEvent(JSON.parse(env.BOUNDED_EVENT_JSON), env.BOUNDED_REQUEST_KEY);
  requireCandidate(env.GITHUB_ACTOR_ID === String(botId)
    && env.STEWARD_CONTROLLER_SHA === env.BOUNDED_POLICY_SHA
    && (event.kind === 'official-refresh' ? validSha(env.BOUNDED_SOURCE_SHA) :
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
    return officialCandidateRoute(settings, env.STEWARD_OFFICIAL_CANDIDATES_ENABLED);
  });
  if (route.result) return finish(route.result);
  requireCandidate((await centralReader.json('git/ref/heads/steward/validated-controller')).object?.sha === run.head_sha, 'CONTROLLER');
  await mkdir(stateDirectory);
  await write('identity', identity);
  await appendFile(env.GITHUB_OUTPUT, 'route=official\nrepo=' + product.name.split('/')[1] + '\nbranch=' + product.defaultBranch + '\n');
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

async function inspectWaiting(get, product) {
  const pending = await pages(get, 'issues?state=closed&labels=' + encodeURIComponent(officialPending));
  const pulls = await Promise.all(pending.filter(issue => issue.pull_request).map(issue => get('pulls/' + issue.number)));
  return pulls.filter(pr => pr.merged === true && pr.base?.ref === product.defaultBranch &&
    pr.head?.repo?.id === product.id && officialRef(pr.head.ref, product.defaultBranch)).map(pr => {
    pullBinding(pr, product, pr.number, botId);
    requireCandidate(validSha(pr.merge_commit_sha) && hasLabel(pr, officialPending), 'PENDING_MERGE');
    return { number: pr.number, head: pr.head.sha, sourceSha: pr.merge_commit_sha };
  });
}

export async function prepareOfficialCandidate({ identity, get, store, token, prepareParticipation,
  buildCandidate = computeOfficialCandidate, collectEvidence = officialCandidateEvidence }) {
  const { product, event, sourceSha } = identity;
  if (await defaultHead(get, product.defaultBranch) !== sourceSha) return { result: 'source_changed' };
  const [participation, configuration, versions] = await Promise.all([
    prepareParticipation(), readOfficialConfig(get, sourceSha), readOfficialManifest(get, sourceSha),
  ]);
  requireCandidate(participation.status === 'APPLICABLE' && participation.sourceSha === sourceSha &&
    officialRootSettings(configuration), 'ROOT_CONFIG');
  if (event.kind === 'official-refresh') {
    const released = await get('pulls/' + event.prNumber);
    pullBinding(released, product, event.prNumber, botId);
    requireCandidate(released.state === 'closed' && released.merged === true && released.head.sha === event.head &&
      released.merge_commit_sha === event.releasedSha && hasLabel(released, officialTagged) &&
      !hasLabel(released, officialPending), 'REFRESH_ORIGIN');
  }
  const waiting = await inspectWaiting(get, product);
  if (waiting.length) return { result: 'merged_pending', waiting };
  const baseline = await candidateBaseline(get, product, sourceSha, configuration, versions);
  let round = await store.find(sourceSha, baseline);
  let roundId = round?.roundId;
  if (!round) {
    const candidate = await buildCandidate({ product, sourceSha, configuration, get, token });
    if (!candidate) return { result: 'no_candidate_change' };
    roundId = officialCandidateRoundId(product, { baseline, candidate });
    round = await store.read(roundId);
    if (!round.source) {
      const pull = await openOfficialPull(get, product, botId);
      const prior = pull && { number: pull.number, head: pull.head.sha };
      round = await store.save(roundId, 'source', { sourceSha, baseline, candidate, prior });
    } else if (round.source.sourceSha !== sourceSha) {
      requireCandidate(officialCandidateRoundId(product, round.source) === roundId, 'ROUND_IDENTITY');
      requireCandidate(await defaultHead(get, product.defaultBranch) === sourceSha, 'C2_SOURCE_CHANGED');
      await store.bind(roundId, sourceSha);
    }
  }
  requireCandidate(round.source && officialCandidateRoundId(product, round.source) === roundId, 'ROUND_IDENTITY');
  if (round.pull) return { result: 'candidate_unchanged', roundId, pulls: [round.pull] };
  const { candidate } = round.source;

  // On cutover an already rendered official PR can be carried forward unchanged
  // when the computed files and candidate version still identify the same change.
  if ((!round.draft || round.draft.templateDigest === null) && round.source.prior) {
    const prior = await get('pulls/' + round.source.prior.number);
    const legacy = prior.state === 'open' && prior.head?.sha === round.source.prior.head &&
      await compatibleExistingCandidate({ get, pull: prior, product, botId, candidate, configuration });
    if (legacy) {
      for (const phase of ['draft', 'branch', 'pull']) {
        if (!round[phase]) await store.save(roundId, phase, legacy[phase]);
      }
      return { result: 'candidate_unchanged', roundId, pulls: [legacy.pull] };
    }
    requireCandidate(!round.draft, 'ADOPTED_PULL_DRIFT');
  }
  const evidence = round.draft ? null : await collectEvidence({ product, sourceSha, baseline, candidate, get });
  return { roundId, candidate, mode: round.draft ? 'write' : 'draft', evidence };
}

async function withCandidateState(env, identity, operation) {
  const app = await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY ?? '');
  const { product } = identity;
  const repository = { id: product.id, full_name: product.name, default_branch: product.defaultBranch };
  const root = await mkdtemp(join(tmpdir(), 'steward-candidate-state-'));
  try {
    return await app.forCandidateRepository(product.id, async (writeToken, readToken) => {
      const reader = new NativeEvidenceReader(nativeEvidenceTransport(readToken), product.name);
      const get = path => reader.json(path);
      const admit = () => assertReleaseUnpaused(app, product.id);
      const record = await import('./release-record.mjs');
      let snapshotDirectory;
      const directory = () => snapshotDirectory ??= fetchState(root, repository, writeToken).then(state => state.directory);
      const writeCheckpoint = async (method, fields) => {
        const result = await method({
          directory: await directory(), writeDirectory: await mkdtemp(join(root, 'write-')), repository: product.name,
          repositoryId: product.id, defaultBranch: product.defaultBranch, identity: botIdentity, ...fields,
        }, { token: writeToken, admit });
        snapshotDirectory = undefined;
        return result;
      };
      const store = {
        find: async (sourceSha, baseline) => record.findOfficialCandidateRound({
          directory: await directory(), repositoryId: product.id, defaultBranch: product.defaultBranch, sourceSha, baseline,
        }),
        read: async roundId => record.readOfficialCandidateRound({
          directory: await directory(), repositoryId: product.id, roundId,
        }),
        save: (roundId, phase, data) => writeCheckpoint(record.writeOfficialCandidateCheckpoint, { roundId, phase, data }),
        bind: (roundId, sourceSha) => writeCheckpoint(record.recordOfficialCandidateSource, { roundId, sourceSha }),
      };
      return operation({ get, store, token: readToken, admit, prepareParticipation: () =>
        releaseParticipation(repository, nativeEvidenceTransport(readToken), { requireWorkflowGitHubDelivery: true }) });
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

const stateRead = async name => JSON.parse(await readFile(stateFile(name), 'utf8'));
const finish = (identity, result) => writeFile('result.json', JSON.stringify({ schemaVersion: 1, ...identity, ...result }) + '\n', { flag: 'wx' });

export async function main(stage, env = process.env) {
  if (stage === 'identify') return identify(env);
  const identity = await stateRead('identity');
  const { product, sourceSha } = identity;
  if (stage === 'prepare' && identity.event.kind === 'official-edit') {
    const app = await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY ?? '');
    const result = await app.forCandidateReadRepository(product.id, async token => {
      const reader = new NativeEvidenceReader(nativeEvidenceTransport(token), product.name);
      return checkEdited(identity, path => reader.json(path));
    });
    return finish(identity, { result });
  }
  if (stage === 'prepare') {
    const plan = await withCandidateState(env, identity, options => prepareOfficialCandidate({ ...options, identity }));
    if (plan.result) return finish(identity, plan);
    await write('plan', plan);
    return appendFile(env.GITHUB_OUTPUT, 'mode=' + plan.mode + '\n');
  }
  const plan = await stateRead('plan');
  const { roundId, candidate } = plan;
  if (stage === 'generate') {
    const template = await readFile(templatePath, 'utf8');
    const client = copilotReleaseClient(controllerDirectory, env.STEWARD_COPILOT_TOKEN ?? '');
    return write('draft', await draftOfficialCandidate({
      roundId, candidate, context: plan.evidence, product, sourceSha, template, call: client.call,
    }));
  }
  if (stage === 'check') {
    return withCandidateState(env, identity, async ({ get, store, admit }) => {
      const round = await store.read(roundId);
      requireCandidate(round.source && officialCandidateRoundId(product, round.source) === roundId, 'ROUND_IDENTITY');
      const draft = round.draft ?? await stateRead('draft');
      verifyCandidateDraft(candidate, draft, roundId);
      if (!round.draft) await store.save(roundId, 'draft', draft);
      await admit();
      const currentSourceSha = await defaultHead(get, product.defaultBranch);
      if (currentSourceSha !== sourceSha) return finish(identity, { result: 'source_changed', roundId, currentSourceSha });
      return appendFile(env.GITHUB_OUTPUT, 'mode=write\n');
    });
  }
  requireCandidate(stage === 'write', 'STAGE');
  const productToken = env.STEWARD_CANDIDATE_TOKEN;
  const scope = await fetchJson(productToken, '/installation/repositories?per_page=100');
  requireCandidate(scope.total_count === 1 && scope.repositories?.length === 1, 'TOKEN_SCOPE');
  const actual = target(scope.repositories[0], product.id);
  requireCandidate(actual.name === product.name && actual.defaultBranch === product.defaultBranch, 'TOKEN_SCOPE');
  return withCandidateState(env, identity, async ({ get, store, admit }) => {
    const round = await store.read(roundId);
    requireCandidate(round.source && officialCandidateRoundId(product, round.source) === roundId, 'ROUND_IDENTITY');
    const configuration = await readOfficialConfig(get, sourceSha);
    const pull = await writeOfficialCandidate({ get, product, botId, round, roundId, sourceSha, configuration, admit,
      request: (method, path, data) => fetchJson(productToken, '/repos/' + product.name + '/' + path, method, data),
      save: (phase, data) => store.save(roundId, phase, data),
    });
    return finish(identity, { result: 'candidate_observed', roundId, pulls: [pull] });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => {
    const message = error?.message;
    console.error(/^(OFFICIAL_CANDIDATE|RELEASE|CONTENT)_[A-Z_0-9]+$/.test(message) ||
      ['WAIT_AUTH', 'WAIT_QUOTA', 'RESPONSE_UNKNOWN'].includes(message) ? message : 'OFFICIAL_CANDIDATE_STOPPED');
    process.exitCode = 1;
  });
}
