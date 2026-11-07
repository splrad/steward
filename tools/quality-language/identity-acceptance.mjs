import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualityLanguage } from './run.mjs';
import { releaseNotes } from './release-notes.mjs';
import { contentWireInput } from '../../packages/runner/dist/index.js';

// Fixed public fixtures; no caller-supplied prompt, repository, or output destination.
const text = '修复认证暂不可用时的发布初稿恢复；未执行真实产品验收。';
const digest = createHash('sha256').update(text).digest('hex');
const qualityInput = JSON.stringify({ items: [{ bodyMarkdown: 'The retry delay is ignored after an authentication failure. Preserve the retry delay before the next request.', sourceCommentId: 'synthetic:1', sourceCommit: 'unknown', sourceUrl: 'https://github.com/splrad/steward', severity: '原文未说明', originalIdentifiers: [], segmentIndex: 0 }] });
const releaseInput = contentWireInput({ stage: 'DRAFT', unitIds: ['example'], units: [{ id: 'example', path: '.', version: '0.0.0', tag: 'v0.0.0' }], sources: [{ id: digest, unitId: 'example', path: 'example.txt', previousPath: null, status: 'A:after', oid: '0'.repeat(40), mode: '100644', byteLength: Buffer.byteLength(text), encoding: 'utf8', sha256: digest, start: 0, end: Buffer.byteLength(text), text, stage: 'DIFF' }], items: [], background: [] });

export function assertAdmission(purpose, env) {
  if (!['quality', 'release'].includes(purpose) || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      env.GITHUB_REPOSITORY !== 'splrad/steward' || env.GITHUB_REPOSITORY_ID !== '1296724484' ||
      env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_RUN_ATTEMPT !== '1' ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || env.ACCEPT_TWO_REQUESTS !== 'true' ||
      !/^[a-f0-9]{40}$/.test(env.APPROVED_SHA ?? '') || env.APPROVED_SHA !== env.GITHUB_SHA ||
      env.WORKFLOW_SHA !== env.GITHUB_SHA || !env.STEWARD_COPILOT_TOKEN?.trim()) throw new Error('ACCEPTANCE_ADMISSION_DENIED');
}

export async function acceptIdentity(purpose, env, adapters = { qualityLanguage, releaseNotes }) {
  assertAdmission(purpose, env);
  const token = env.STEWARD_COPILOT_TOKEN;
  // Preflight is read-only. Neither rejection nor unknown response is retried.
  const adapter = purpose === 'quality' ? adapters.qualityLanguage : adapters.releaseNotes;
  const preflight = await adapter('preflight', '', token);
  if (preflight.status !== 'READY') throw new Error('ACCEPTANCE_PREFLIGHT_DENIED');
  const result = purpose === 'quality' ? await adapters.qualityLanguage('translate', qualityInput, token)
    : await adapters.releaseNotes('generate', releaseInput, token);
  if (result.status !== 'RETURNED' || !result.model) throw new Error('ACCEPTANCE_RESPONSE_UNVERIFIED');
  return { status: 'RETURNED', purpose, synthetic: true, fullConsumerAcceptance: false,
    repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, attempt: 1,
    controllerSha: env.GITHUB_SHA, models: preflight.models, model: result.model, usage: result.usage };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const purpose = process.argv[2];
  try {
    const result = await acceptIdentity(purpose, process.env);
    await writeFile('identity-acceptance.json', JSON.stringify(result, null, 2) + '\n');
  } catch {
    // No SDK exception, generated text, token, or arbitrary log is published.
    await writeFile('identity-acceptance.json', JSON.stringify({ status: 'FAILED_OR_UNKNOWN', purpose: ['quality', 'release'].includes(purpose) ? purpose : null, automaticRetry: false }) + '\n');
    process.exitCode = 1;
  } finally { delete process.env.STEWARD_COPILOT_TOKEN; }
}
