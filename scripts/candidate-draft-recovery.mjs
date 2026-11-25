import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { NativeEvidenceReader, nativeEvidenceTransport } from '../packages/runner/dist/index.js';
import { verifyCompletion } from './maintenance-event.mjs';
import { assertReleaseWriterProtection, findOfficialCandidateRound, writeReleaseRecords } from './release-record.mjs';
import { fetchState, releaseParticipation } from './release-coordinator.mjs';
import { officialCandidateApp, officialCandidateRoute } from './official-candidate-event.mjs';
import { bodyDigest, candidateBaseline, defaultHead, officialCandidateRoundId, officialPending, pullBinding, hasLabel,
  readOfficialConfig, readOfficialManifest } from './official-release-candidate.mjs';
import { releaseIsPaused } from './release-pause-policy.mjs';

const central = { id: 1296724484, full_name: 'splrad/steward', default_branch: 'main' };
const workflowFile = 'release-candidate-event.yml', workflowId = 421504821, botId = 301115370;
const positive = n => Number.isSafeInteger(n) && n > 0;
const check = (ok, reason) => { if (!ok) throw new Error('CANDIDATE_RECOVERY_' + reason); };
const recoveryKey = (id, sha) => bodyDigest(JSON.stringify([id, 'push', sha]));
const prepare = 'Compute or restore the official candidate', generate = 'Draft the release notes with Copilot';
const writes = ['Record the draft and check body, version and source', 'Issue the product candidate token',
  'Create or refresh the candidate with validated inputs'];

export function failedDraftRun(runs, key) {
  const matches = runs.filter(run => run.display_title === 'Candidate event ' + key &&
    run.repository?.id === central.id && run.head_repository?.id === central.id && run.workflow_id === workflowId &&
    run.path === '.github/workflows/' + workflowFile && run.event === 'workflow_dispatch' &&
    run.head_branch === 'main' && run.actor?.id === botId);
  if (matches.length !== 1) return null;
  const [run] = matches;
  return run.status === 'completed' && run.conclusion === 'failure' && run.run_attempt === 1 &&
    positive(run.id) && /^[a-f0-9]{40}$/.test(run.head_sha) ? run : null;
}

export function failedDraftJob(run, jobs) {
  if (jobs.length !== 1) return null;
  const [job] = jobs;
  if (!positive(job.id) || job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== run.head_sha ||
    job.name !== 'event' || job.status !== 'completed' || job.conclusion !== 'failure' || !Array.isArray(job.steps)) return null;
  const has = (name, conclusion) => job.steps.filter(s => s.name === name).length === 1 &&
    job.steps.find(s => s.name === name).conclusion === conclusion;
  return has(prepare,'success') && has(generate,'failure') && writes.every(name => has(name,'skipped')) ? job : null;
}

// Only accept the controller's own bounded diagnostic, including the original form without SDK fields.
export function unknownDraftResponse(log) {
  const matches = log.split(/\r?\n/).filter(line => /^\d{4}-\d\d-\d\dT[\d:.]+Z RESPONSE_UNKNOWN stage=generate(?: |$)/.test(line));
  return matches.length === 1 && /^\S+ RESPONSE_UNKNOWN stage=generate(?: sdk_stage=(?:start|auth|models|session|send|response|usage|cleanup|process))?(?: status=(?:408|429|5\d\d))?$/.test(matches[0]);
}

const definiteRejections = new Set([400,401,403,404,409,410,422,429]);
const claimPath = claim => 'maintenance/candidate-draft-' + claim.productId + '-' + claim.sourceSha + '-' + claim.dispatchAttempt;

export function nextClaim(records, value) {
  for (let dispatchAttempt = 1; ; dispatchAttempt++) {
    const claim = { ...value, dispatchAttempt };
    const prefix = claimPath(claim);
    const previous = records.get(prefix + '.json');
    const rejection = records.get(prefix + '-rejected.json');
    if (!previous) {
      check(!rejection, 'ORPHAN_REJECTION');
      return { path: prefix + '.json', value: claim };
    }
    check(previous.roundId === value.roundId && previous.failedRunId === value.failedRunId &&
      previous.failedAttempt === value.failedAttempt, 'CLAIM_ORIGIN');
    if (!rejection || previous.coordinatorRunId === value.coordinatorRunId && previous.coordinatorAttempt === value.coordinatorAttempt) return null;
    const { responseStatus, ...refused } = rejection;
    check(definiteRejections.has(responseStatus) && Object.keys(previous).every(key => refused[key] === previous[key]), 'REJECTION_IDENTITY');
  }
}

export async function recoverDraft({ run, reader, admit, reserve, dispatch, reject }) {
  const current = await reader.json('actions/runs/' + run.id);
  if (!failedDraftRun([current],run.display_title.slice('Candidate event '.length)) ||
      current.id !== run.id || current.head_sha !== run.head_sha || current.run_attempt !== run.run_attempt) return 'SUPERSEDED';
  const jobs = await reader.pages('actions/runs/' + run.id + '/attempts/' + run.run_attempt + '/jobs','jobs');
  const job = failedDraftJob(run,jobs);
  if (!job) return 'INELIGIBLE';
  let log;
  try {
    log = await reader.response('actions/jobs/' + job.id + '/logs');
  } catch (error) {
    if (error?.status === 404 || error?.status === 410) return 'LOG_UNAVAILABLE';
    throw error;
  }
  if (!unknownDraftResponse(log.bytes.toString('utf8'))) return 'INELIGIBLE';
  if (!await admit()) return 'SUPERSEDED';
  const claim = await reserve();
  if (!claim) return 'ALREADY_RESERVED';
  // The persisted reservation is never reissued, including when a POST response is lost.
  if (!await admit()) return 'SUPERSEDED';
  const status = await dispatch();
  if (definiteRejections.has(status)) {
    await reject(claim, status);
    return 'DISPATCH_REJECTED';
  }
  check(status === 204 || status === 200, 'DISPATCH_UNCONFIRMED');
  return 'DISPATCHED';
}

async function writeRecoveryRecord(app, root, admit, plan) {
  return app.forRepository(central.id, async token => {
    const rules = app.readCentralMaintenanceRules;
    const refresh = () => fetchState(root,central,token,'steward/release-state',{
      includeHistory:true,centralFirstUse:true,readCentralMaintenanceRules:rules });
    const state = await refresh();
    const records = new Map(state.snapshot.domainRecords.map(record => [record.path, record.value]));
    const proposal = plan(records);
    if (!proposal) return null;
    const { path, value } = proposal;
    const content = JSON.stringify(value) + '\n';
    const beforePush = async () => {
      check(await admit(),'SOURCE_CHANGED');
      await assertReleaseWriterProtection(central.full_name,'steward/release-state',state.io,{readCentralMaintenanceRules:rules});
    };
    const result = await writeReleaseRecords({ directory:await mkdtemp(join(root,'claim-')),remote:state.remote,
      repositoryId:central.id,defaultBranch:'main',targetRef:'steward/release-state',writer:'maintenance',
      expectedHead:state.snapshot.head,allowedPaths:[path],changes:[{path,content,sha256:bodyDigest(content),previousSha256:null}],
      identity:{name:app.appBotLogin,email:botId+'+'+app.appBotLogin+'@users.noreply.github.com'} },{token,beforePush});
    check(result.status === 'APPLIED','CLAIM');
    check((await refresh()).snapshot.domainRecords.some(record => record.path === path && record.content === content),'CLAIM_READBACK');
    return value;
  },'maintenance');
}

async function loadProductRound({ app, root, repo, product, get, io, sourceSha }) {
  const participation = await releaseParticipation(repo, io, { requireWorkflowGitHubDelivery: true });
  if (participation.status !== 'APPLICABLE' || participation.sourceSha !== sourceSha) return;
  const configuration = await readOfficialConfig(get, sourceSha);
  if (officialCandidateRoute(configuration, 'true').route !== 'official') return;
  const manifest = await readOfficialManifest(get, sourceSha);
  const baseline = await candidateBaseline(get, product, sourceSha, configuration, manifest);
  return app.forCandidateRepository(repo.id, async stateToken => {
    const { directory } = await fetchState(root, repo, stateToken);
    return findOfficialCandidateRound({ directory, repositoryId: repo.id, defaultBranch: repo.default_branch, sourceSha, baseline });
  });
}

export async function recoverProduct({ app, root, repo, reader, history, runs, promoted, coordinator, controller },
  { transport = nativeEvidenceTransport, loadRound = loadProductRound, writeRecord = writeRecoveryRecord, isPaused = releaseIsPaused } = {}) {
  const product = { id: repo.id, name: repo.full_name, defaultBranch: repo.default_branch };
  return app.forCandidateReadRepository(repo.id, async token => {
    const io = transport(token);
    const target = new NativeEvidenceReader(io, repo.full_name);
    const get = path => target.json(path);
    const sourceSha = await defaultHead(get, repo.default_branch);
    const key = recoveryKey(repo.id, sourceSha);
    const run = failedDraftRun(runs, key);
    if (!run || await isPaused(app, repo.id)) return;
    const round = await loadRound({ app, root, repo, product, get, io, sourceSha });
    if (!round?.source || round.draft || round.branch || round.pull || round.source.sourceSha !== sourceSha ||
        officialCandidateRoundId(product, round.source) !== round.roundId) return;

    const admit = async () => {
      if (!await promoted() || await defaultHead(get, repo.default_branch) !== sourceSha ||
          await defaultHead(get, 'steward/release-state') !== round.head || failedDraftRun(await history(), key)?.id !== run.id) return false;
      if (await isPaused(app, repo.id)) return false;
      if (round.source.prior) {
        const { number, head } = round.source.prior;
        const pull = await get('pulls/' + number);
        pullBinding(pull, product, number, botId);
        if (pull.state !== 'open' || pull.merged || pull.head.sha !== head || !hasLabel(pull, officialPending)) return false;
      }
      return true;
    };
    const reservation = {
      schemaVersion: 1, productId: repo.id, sourceSha, roundId: round.roundId,
      failedRunId: run.id, failedAttempt: run.run_attempt, coordinatorRunId: coordinator.runId,
      coordinatorAttempt: coordinator.runAttempt, controllerSha: controller,
    };
    const dispatch = () => app.forRepository(central.id, async credential => {
      const path = '/repos/' + central.full_name + '/actions/workflows/' + workflowId + '/dispatches';
      const inputs = { event_json: JSON.stringify({ kind: 'push', repositoryId: repo.id, sourceSha }),
        request_key: key, source_sha: sourceSha, policy_sha: controller };
      const response = await transport(credential).request('POST', path, undefined, { ref: 'main', inputs });
      return response.status;
    }, 'configuration-actions');
    const reserve = () => writeRecord(app, root, admit, records => nextClaim(records, reservation));
    const reject = (claim, status) => writeRecord(app, root, admit, records => {
      const prefix = claimPath(claim), prior = records.get(prefix + '.json');
      check(prior && Object.keys(claim).every(key => prior[key] === claim[key]) && !records.has(prefix + '-rejected.json'), 'CLAIM_IDENTITY');
      return { path: prefix + '-rejected.json', value: { ...claim, responseStatus: status } };
    });
    const result = await recoverDraft({ run, reader, admit, reserve, dispatch, reject });
    return { product: repo.full_name, failedRunId: run.id, roundId: round.roundId, result };
  });
}

export async function reconcileCandidateDrafts(env = process.env) {
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
  const controller = env.STEWARD_CONTROLLER_SHA, reader = new NativeEvidenceReader(nativeEvidenceTransport(env.STEWARD_CENTRAL_TOKEN),central.full_name);
  const { beforePost, coordinator, workflow } = await verifyCompletion(env,event,reader);
  check(workflow.path === '.github/workflows/governance-promotion.yml' && workflow.state === 'active' &&
    event.workflow_run.conclusion === 'success' && event.workflow_run.head_sha === controller,'PROMOTION');
  const promoted = async () => {
    await beforePost();
    return await defaultHead(path => reader.json(path),'steward/validated-controller') === controller;
  };
  if (env.STEWARD_OFFICIAL_CANDIDATES_ENABLED !== 'true' || !await promoted()) return [];
  const wf = await reader.json('actions/workflows/'+workflowId);
  check(wf.id===workflowId && wf.path==='.github/workflows/'+workflowFile && wf.state==='active','WORKFLOW');
  // An unfiltered workflow list can be paginated beyond GitHub's 1,000 search results.
  // failedDraftRun applies exact App, event and branch checks to the complete retained history.
  const history = () => reader.pages('actions/workflows/' + workflowId + '/runs', 'workflow_runs');
  const runs = await history();
  if (!runs.some(run => run.conclusion === 'failure')) return [];
  const app = await officialCandidateApp(env);
  const root = await mkdtemp(join(tmpdir(),'candidate-draft-recovery-')), results=[];
  try {
    for (const repo of await app.discover({publicCandidatesOnly:true})) {
      if (repo.archived || repo.disabled) continue;
      try {
        const result = await recoverProduct({ app, root, repo, reader, history, runs, promoted, coordinator, controller });
        if (result) results.push(result);
      } catch (error) {
        const reason = /^CANDIDATE_RECOVERY_[A-Z_]+$/.test(error?.message) ? error.message : 'CANDIDATE_RECOVERY_FAILED';
        results.push({ product: repo.full_name, result: 'FAILED', reason });
      }
    }
    return results;
  } finally {await rm(root,{recursive:true,force:true});}
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  reconcileCandidateDrafts().then(results=>{
    console.log(JSON.stringify(results));
    if (results.some(entry => ['FAILED','DISPATCH_REJECTED'].includes(entry.result))) process.exitCode = 1;
  }).catch(error=>{
    console.error(/^CANDIDATE_RECOVERY_[A-Z_]+$/.test(error?.message)?error.message:'CANDIDATE_RECOVERY_FAILED');process.exitCode=1;
  });
