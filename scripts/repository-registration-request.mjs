import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { downloadNativeArtifact } from '../packages/runner/dist/index.js';
import { must, positive, sha } from './configuration-native.mjs';
import { centralRegistrationWorkflow, registrationWorkflow } from './repository-registration-policy.mjs';

export const adminId = 1447987054;
export const centralId = 1296724484;
export const registrationEvent = 'steward-registration-request';
export const requestFile = 'repository-registration.json';
const maxRequestBytes = 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const types = ['repository_dispatch', 'workflow_dispatch'];
const exact = (value, keys) => value && !Array.isArray(value) && typeof value === 'object' &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const isGovernanceBot = actor => actor?.id === 353238212 &&
  actor.login === 'splrad-governance[bot]' && actor.type === 'Bot';

export function wakePayload(requestId) {
  must(typeof requestId === 'string' && uuid.test(requestId), 'Invalid registration locator');
  return { schemaVersion: 1, requestId };
}

export function readWake(event, env) {
  const repo = event.repository;
  const payload = event.client_payload;
  must(env.GITHUB_EVENT_NAME === 'repository_dispatch' && event.action === registrationEvent &&
    env.GITHUB_REF === 'refs/heads/main' && sha(env.GITHUB_SHA) && env.REGISTRATION_WORKFLOW_SHA === env.GITHUB_SHA &&
    env.GITHUB_WORKFLOW_REF === 'splrad/steward/' + centralRegistrationWorkflow + '@refs/heads/main' &&
    repo?.id === centralId && repo.full_name === 'splrad/steward' && repo.private === false &&
    repo.default_branch === 'main' && isGovernanceBot(event.sender) &&
    exact(payload, ['schemaVersion', 'requestId']) && payload.schemaVersion === 1, 'Untrusted registration wake');
  return wakePayload(payload.requestId).requestId;
}

export function makePrivateRequest(requestId, ids, env) {
  must(env.GITHUB_REF === 'refs/heads/main' && sha(env.GITHUB_SHA) &&
    env.REGISTRATION_WORKFLOW_SHA === env.GITHUB_SHA && types.includes(env.GITHUB_EVENT_NAME) &&
    env.GITHUB_WORKFLOW_REF === 'splrad/steward-settings/' + registrationWorkflow + '@refs/heads/main',
  'Untrusted registration producer');
  return { ...wakePayload(requestId), repositoryIds: validIds(ids), sourceSha: env.GITHUB_SHA,
    runId: positive(env.GITHUB_RUN_ID), attempt: positive(env.GITHUB_RUN_ATTEMPT), event: env.GITHUB_EVENT_NAME };
}

function validIds(ids) {
  must(Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length &&
    ids.every(id => Number.isSafeInteger(id) && id > 0), 'Invalid registration targets');
  return ids;
}

export async function extractPrivateRequest(artifact, admin, token) {
  const parent = resolve(tmpdir());
  const scratch = await mkdtemp(join(parent, 'steward-registration-'));
  must(dirname(resolve(scratch)) === parent, 'Invalid registration scratch path');
  try {
    const directory = join(scratch, 'request');
    await downloadNativeArtifact({ fullName: admin.full_name, artifactId: artifact.id, digest: artifact.digest,
      names: [requestFile], directory, policyDirectory: process.cwd(), home: join(scratch, 'download') }, token);
    return JSON.parse(await readFile(join(directory, requestFile), 'utf8'));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function loadPrivateRequest(api, admin, token, requestId, extract = extractPrivateRequest) {
  const name = 'repository-registration-' + wakePayload(requestId).requestId;
  const { data: found } = await api.rest.actions.listArtifactsForRepo({ ...api.target, name, per_page: 100 });
  must(found.total_count === 1 && found.artifacts?.length === 1, 'Registration request missing or ambiguous');
  const artifact = found.artifacts[0];
  const producer = artifact.workflow_run;
  must(artifact.name === name && artifact.expired === false && /^sha256:[a-f0-9]{64}$/.test(artifact.digest) &&
    positive(artifact.id) && Number.isSafeInteger(artifact.size_in_bytes) &&
    artifact.size_in_bytes > 0 && artifact.size_in_bytes <= maxRequestBytes &&
    producer?.repository_id === adminId && producer.head_repository_id === adminId &&
    producer.head_branch === 'main' && sha(producer.head_sha) && positive(producer.id), 'Invalid private registration artifact');
  const { data: workflow } = await api.rest.actions.getWorkflow({ ...api.target,
    workflow_id: registrationWorkflow.split('/').at(-1) });
  must(workflow.path === registrationWorkflow && workflow.state === 'active' && positive(workflow.id),
    'Untrusted registration workflow');
  const { data: main } = await api.rest.repos.getBranch({ ...api.target, branch: 'main' });
  must(main.name === 'main' && main.protected === true && sha(main.commit?.sha), 'Invalid producer default ref');
  if (main.commit.sha !== producer.head_sha) {
    const { data: compare } = await api.rest.repos.compareCommitsWithBasehead({ ...api.target,
      basehead: producer.head_sha + '...' + main.commit.sha });
    must(compare.merge_base_commit?.sha === producer.head_sha, 'Registration producer commit is outside main');
  }
  const request = await extract(artifact, admin, token);
  must(exact(request, ['schemaVersion', 'requestId', 'repositoryIds', 'sourceSha', 'runId', 'attempt', 'event']) &&
    request.schemaVersion === 1 && request.requestId === requestId && request.sourceSha === producer.head_sha &&
    request.runId === producer.id && types.includes(request.event) &&
    Number.isSafeInteger(request.attempt) && request.attempt > 0, 'Registration request provenance mismatch');
  const { data: run } = await api.rest.actions.getWorkflowRunAttempt({ ...api.target,
    run_id: request.runId, attempt_number: request.attempt });
  must(run.id === request.runId && run.run_attempt === request.attempt && run.workflow_id === workflow.id &&
    run.path === registrationWorkflow && run.event === request.event && run.repository?.id === adminId &&
    run.head_repository?.id === adminId && run.head_branch === 'main' && run.head_sha === request.sourceSha &&
    (request.event === 'repository_dispatch' ? isGovernanceBot(run.actor) :
      run.actor?.type === 'User' && Number.isSafeInteger(run.actor.id) && run.actor.id > 0),
  'Untrusted registration producer run');
  return validIds(request.repositoryIds);
}
