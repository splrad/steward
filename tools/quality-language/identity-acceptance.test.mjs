import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { assertAdmission, acceptIdentity } from './identity-acceptance.mjs';

const sha = 'a'.repeat(40);
const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'splrad/steward', GITHUB_REPOSITORY_ID: '1296724484', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123', ACCEPT_TWO_REQUESTS: 'true', APPROVED_SHA: sha, GITHUB_SHA: sha, WORKFLOW_SHA: sha, STEWARD_COPILOT_TOKEN: 'fixture' };
test('admission fails before touching any adapter for missing or mismatched authority', async () => {
  assertAdmission('quality', env);
  for (const [key, value] of Object.entries({ GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'other/repo', GITHUB_REPOSITORY_ID: '1', GITHUB_REF: 'refs/heads/topic', GITHUB_RUN_ATTEMPT: '2', GITHUB_RUN_ID: '', ACCEPT_TWO_REQUESTS: 'false', APPROVED_SHA: 'b'.repeat(40), WORKFLOW_SHA: 'b'.repeat(40), STEWARD_COPILOT_TOKEN: '' })) {
    await assert.rejects(acceptIdentity('quality', { ...env, [key]: value }, {}), /ADMISSION_DENIED/);
  }
  assert.throws(() => assertAdmission('arbitrary', env), /ADMISSION_DENIED/);
});
test('each purpose generates once with fixed inputs and preserves only identity evidence', async () => {
  for (const purpose of ['quality', 'release']) {
    const calls = [];
    const run = async (mode, input) => {
      calls.push({ mode, input });
      return mode === 'preflight' ? { status: 'READY', models: ['actual'] } : { status: 'RETURNED', model: 'actual', usage: { requests: 1 }, text: 'not published' };
    };
    const result = await acceptIdentity(purpose, env, { qualityLanguage: run, releaseNotes: run });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].mode, 'preflight');
    assert.equal(calls[1].mode, purpose === 'quality' ? 'translate' : 'generate');
    const input = JSON.parse(calls[1].input);
    if (purpose === 'release') { assert.ok(input.prompt.includes('中文发布初稿')); assert.equal(input.sources.length, 1); }
    else assert.equal(input.items.length, 1);
    assert.deepEqual(result.models, ['actual']);
    assert.equal(result.controllerSha, sha);
    assert.equal(result.text, undefined);
  }
});
test('preflight refusal, generation refusal and timeout do not retry', async () => {
  for (const status of ['WAIT_AUTH', 'WAIT_QUOTA']) {
    let calls = 0;
    const preflightDenied = { qualityLanguage: async () => { calls++; return { status }; } };
    await assert.rejects(acceptIdentity('quality', env, preflightDenied), /PREFLIGHT_DENIED/);
    assert.equal(calls, 1);
  }
  for (const failure of [false, true]) {
    let calls = 0;
    const adapters = { qualityLanguage: async mode => {
      calls++;
      if (mode === 'preflight') return { status: 'READY', models: ['actual'] };
      if (failure) throw new Error('RESPONSE_UNKNOWN');
      return { status: 'WAIT_QUOTA' };
    } };
    await assert.rejects(acceptIdentity('quality', env, adapters));
    assert.equal(calls, 2);
  }
});
test('workflow is manual only, sequential, least privilege and never invokes coordinators', async () => {
  const text = await readFile(new URL('../../.github/workflows/ai-identity-acceptance.yml', import.meta.url), 'utf8');
  const workflow = YAML.parse(text);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch.inputs.authorize_two_requests.default, false);
  assert.equal(workflow.jobs.release.needs, 'quality');
  for (const [purpose, job] of Object.entries(workflow.jobs)) {
    assert.deepEqual(job.permissions, { contents: 'read', 'copilot-requests': 'write' });
    assert.equal(job.environment.name, purpose === 'quality' ? 'steward-release-notes' : 'steward-release');
    assert.match(job.if, /github.run_attempt == 1/);
    assert.match(job.if, /inputs.approved_sha == github.sha/);
    assert.equal(job.steps.filter(s => s.env?.STEWARD_COPILOT_TOKEN).length, 1);
  }
  assert.doesNotMatch(text, /secrets\.|release-coordinator|quality-language-summary\.mjs/);
});
