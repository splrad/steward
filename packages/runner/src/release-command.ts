import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInstallationToken, GitHubClient } from '../../github/src/index.js';
import { releaseAssert, releaseSha, positiveId, newReleaseReceipt, type FrozenRelease, type ReleaseReceipt } from '../../core/src/release-note-receipt.js';
import { validateReleaseSource, validateReleaseEvidence } from '../../core/src/release-bundle.js';
import { currentReleaseBuild } from '../../core/src/release-rebuild.js';
import { generationInputs, generationPlan } from '../../core/src/release-production.js';
import { ReleaseReceiptClient, withReleaseClaim, writeCandidateReviewCheck, prepareReleaseCandidate, createReleaseCandidate, publishReleaseCandidate, verifyReleaseDownloads, verifyReleaseAssetFiles, releaseUploader } from './release-lifecycle.js';

/** This command never runs code from the candidate or product checkout. */
export async function releaseCandidateCommand(args: Readonly<Record<string, string>>): Promise<void> {
  const required = (key: string) => { const v = args[key]; releaseAssert(v, 'ARGUMENT_' + key); return v; };
  const environment = (key: string) => { const v = process.env[key]; releaseAssert(v, 'ENV_' + key); return v; };
  const repositoryId = Number(required('repository-id')), policySha = required('policy-sha'), tag = required('target-tag'), operation = required('operation');
  releaseAssert(positiveId(repositoryId) && releaseSha(policySha) && ['prepare', 'revise', 'inspect', 'plan', 'reconcile', 'pause', 'resume', 'retry-create', 'export', 'rebind-build', 'generator-ticket', 'recover-assets', 'revise-rebuild', 'recover-candidate'].includes(operation), 'COMMAND');
  const token = await createInstallationToken({ appId: environment('APP_ID'), privateKey: environment('STEWARD_APP_PRIVATE_KEY'), installationId: Number(environment('INSTALLATION_ID')), repositoryId,
    permissions: { metadata: 'read', contents: ['recover-candidate', 'prepare', 'revise', 'revise-rebuild', 'reconcile'].includes(operation) ? 'write' : 'read', pull_requests: ['recover-candidate', 'prepare', 'revise', 'revise-rebuild'].includes(operation) ? 'write' : 'read', checks: ['inspect', 'plan', 'reconcile'].includes(operation) ? 'write' : 'read' }, policySha });
  const transport: typeof fetch = (input, init = {}) => fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
  const gh = new GitHubClient(token, 'https://api.github.com', transport, policySha);
  const receipts = new ReleaseReceiptClient(environment('RUNTIME_URL'), token, repositoryId, tag);
  if (operation === 'generator-ticket') {
    const bundle = resolve(required('bundle'));
    const frozen = JSON.parse(await readFile(join(bundle, 'frozen.json'), 'utf8')) as FrozenRelease;
    releaseAssert(frozen.repositoryId === repositoryId && frozen.policySha === policySha && frozen.targetTag === tag, 'BUNDLE_IDENTITY');
    const source = validateReleaseSource(await readFile(join(bundle, 'source.json')), frozen);
    await receipts.request('generation', { action: 'prepare', plan: generationPlan(frozen.sourceDigest, frozen.policySha, generationInputs(source)) });
    await writeFile(resolve(required('output')), JSON.stringify(await receipts.request('generation', { action: 'ticket' })), { flag: 'wx', mode: 0o600 });
    return;
  }
  let result: ReleaseReceipt;
  if (operation === 'recover-candidate') {
    result = await withReleaseClaim(receipts, session => {
      releaseAssert(session.receipt.frozen.policySha === policySha, 'POLICY_STALE');
      return createReleaseCandidate(gh, session);
    });
  } else if (operation === 'revise-rebuild') {
    await withReleaseClaim(receipts, s => s.act('revise-rebuild', { key: required('request-key') }));
    result = await withReleaseClaim(receipts, s => createReleaseCandidate(gh, s));
  } else if (operation === 'prepare' || operation === 'revise') {
    const bundle = resolve(required('bundle'));
    const frozen = JSON.parse(await readFile(join(bundle, 'frozen.json'), 'utf8')) as FrozenRelease;
    releaseAssert(frozen.repositoryId === repositoryId && frozen.policySha === policySha && frozen.targetTag === tag, 'BUNDLE_IDENTITY');
    if (operation === 'revise') {
      const notes = await readFile(join(bundle, 'release-notes.zh-CN.md'), 'utf8'); newReleaseReceipt(frozen, notes);
      const source = await readFile(join(bundle, 'source.json')), evidence = await readFile(join(bundle, 'evidence.json'));
      validateReleaseEvidence(evidence, frozen, validateReleaseSource(source, frozen));
      await verifyReleaseAssetFiles(frozen, resolve(required('assets')));
      await receipts.putObject(source); await receipts.putObject(evidence);
      await withReleaseClaim(receipts, s => s.act('revise', { frozen, draftNotes: notes }));
      result = await withReleaseClaim(receipts, s => createReleaseCandidate(gh, s));
    } else result = await prepareReleaseCandidate({ gh, receipts, frozen, source: await readFile(join(bundle, 'source.json')), evidence: await readFile(join(bundle, 'evidence.json')),
      notes: await readFile(join(bundle, 'release-notes.zh-CN.md'), 'utf8'), assetDirectory: resolve(required('assets')) });
  } else if (operation === 'export') {
    result = await receipts.request<ReleaseReceipt>(args.revision ? `revisions/${args.revision}` : '');
    releaseAssert(result, 'NOT_FOUND');
    await writeFile(resolve(required('output')), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    // Export the authoritative source objects, rather than candidate-provided pointers.
    for (const [name, digest] of [['source', result.frozen.sourceDigest], ['evidence', result.frozen.evidenceDigest]] as const) {
      const chunks: Buffer[] = [];
      let total = 1;
      for (let part = 0; part < total; part++) {
        const row = await receipts.request<{ total: number; bytes_base64: string }>('', undefined, `objects/${digest}/${part}`);
        releaseAssert(row && positiveId(row.total) && row.total <= 2048 && (part === 0 || row.total === total), 'EXPORT_OBJECT');
        total = row.total; chunks.push(Buffer.from(row.bytes_base64, 'base64'));
      }
      const { receiptDigest } = await import('../../core/src/release-note-receipt.js');
      const bytes = Buffer.concat(chunks); releaseAssert(receiptDigest(bytes) === digest, 'EXPORT_DIGEST');
      await writeFile(resolve(required('output')) + '.' + name + '.json', bytes, { flag: 'wx' });
    }
  } else {
    result = await withReleaseClaim(receipts, async session => {
      releaseAssert(session.receipt.frozen.policySha === policySha, 'POLICY_STALE');
      if (operation === 'recover-assets') return session.act('ensure-assets', { unavailable: true });
      if (operation === 'rebind-build') {
        const rebuilt = JSON.parse(await readFile(resolve(required('bundle')), 'utf8'));
        await verifyReleaseAssetFiles(session.receipt.frozen, resolve(required('assets')));
        return session.act('rebind-build', rebuilt);
      }
      if (['pause', 'resume', 'retry-create'].includes(operation)) return session.act(operation);
      if (session.receipt.paused) return session.receipt;
      if (!['publishing', 'verified'].includes(session.receipt.phase)) {
        await session.act('review');
        await writeCandidateReviewCheck(gh, session.receipt, Number(environment('APP_ID')));
      }
      if (operation !== 'reconcile' || !['merged', 'publishing', 'verified'].includes(session.receipt.phase) || session.receipt.paused) return session.receipt;
      const directory = resolve(required('assets'));
      return publishReleaseCandidate({ gh, session, assetDirectory: directory, upload: releaseUploader(token, policySha, directory), verifyDownloads: r => verifyReleaseDownloads(r, token) });
    });
  }
  if (operation === 'plan' && !result.paused && ['merged', 'publishing'].includes(result.phase)) result = await withReleaseClaim(receipts, s => s.act('ensure-assets'));
  const shouldPublish = operation === 'plan' && !result.paused && !result.assetRecoveryPending && ['merged', 'publishing'].includes(result.phase);
  const build = currentReleaseBuild(result);
  const outputs = { phase: result.phase, shouldPublish: String(shouldPublish), artifactId: String(build?.artifactId ?? ''), runId: String(build?.runId ?? ''), artifactName: build?.artifactName ?? '' };
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k,v]) => `${k}=${v}\n`).join(''));
  process.stdout.write(JSON.stringify({ candidateId: result.candidateId, revision: result.revision, phase: result.phase, paused: result.paused, error: result.error }) + '\n');
}
