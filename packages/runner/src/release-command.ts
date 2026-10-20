import {dispatchReleaseContinuation} from './release-continuation.js';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInstallationToken, GitHubClient, dispatchWorkflow } from '../../github/src/index.js';
import { releaseAssert, releaseSha, positiveId, newReleaseReceipt, type FrozenRelease, type ReleaseReceipt } from '../../core/src/release-note-receipt.js';
import { validateReleaseSource, validateReleaseEvidence } from '../../core/src/release-bundle.js';
import { currentReleaseBuild } from '../../core/src/release-rebuild.js';
import { generationGraphDigest, generationGraphLimits, generationSourceBatches, planGenerationGraph } from '../../core/src/release-generation-graph.js';
import { ReleaseReceiptClient, withReleaseClaim, writeCandidateReviewCheck, recoverReleaseAssets, prepareReleaseCandidate, createReleaseCandidate, publishReleaseCandidate, verifyReleaseDownloads, verifyReleaseAssetFiles, releaseUploader, releasePublishTimeoutMinutes, refreshingReleaseToken } from './release-lifecycle.js';

/** This command never runs code from the candidate or product checkout. */
export async function releaseCandidateCommand(args: Readonly<Record<string, string>>): Promise<void> {
  const required = (key: string) => { const v = args[key]; releaseAssert(v, 'ARGUMENT_' + key); return v; };
  const environment = (key: string) => { const v = process.env[key]; releaseAssert(v, 'ENV_' + key); return v; };
  const repositoryId = Number(required('repository-id')), policySha = required('policy-sha'), tag = required('target-tag'), operation = required('operation');
  releaseAssert(positiveId(repositoryId) && releaseSha(policySha) && ['prepare', 'revise', 'inspect', 'plan', 'reconcile', 'pause', 'resume', 'retry-create', 'export', 'rebind-build', 'generator-ticket', 'generator-continue', 'recover-assets', 'revise-rebuild', 'recover-candidate', 'migrate-policy'].includes(operation), 'COMMAND');
  const getToken = refreshingReleaseToken(() => createInstallationToken({ appId: environment('APP_ID'), privateKey: environment('STEWARD_APP_PRIVATE_KEY'), installationId: Number(environment('INSTALLATION_ID')), repositoryId,
    permissions: { ...(['recover-candidate', 'prepare', 'revise', 'revise-rebuild', 'inspect', 'plan', 'reconcile'].includes(operation) ? { actions: 'read' as const } : {}), metadata: 'read', contents: ['recover-candidate', 'prepare', 'revise', 'revise-rebuild', 'reconcile'].includes(operation) ? 'write' : 'read', pull_requests: ['recover-candidate', 'prepare', 'revise', 'revise-rebuild'].includes(operation) ? 'write' : 'read', checks: ['inspect', 'plan', 'reconcile'].includes(operation) ? 'write' : 'read' }, policySha }));
  const token = await getToken();
  const transport: typeof fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${await getToken()}`);
    return fetch(input, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(60_000) });
  };
  const gh = new GitHubClient(token, 'https://api.github.com', transport, policySha);
  const receipts = new ReleaseReceiptClient(environment('RUNTIME_URL'), token, repositoryId, tag, transport);
  if (operation === 'migrate-policy') {
    const result = await receipts.request('migrate-policy', {});
    process.stdout.write(JSON.stringify(result) + '\n'); return;
  }
  if (operation === 'generator-ticket' || operation === 'generator-continue') {
    const { frozen } = await receipts.request<{ frozen: FrozenRelease }>('generation-graph', { action: 'seed' });
    releaseAssert(frozen.repositoryId === repositoryId && frozen.policySha === policySha && frozen.targetTag === tag, 'BUNDLE_IDENTITY');
    const bytes = await receipts.getObject(frozen.sourceDigest);
    const source = validateReleaseSource(bytes, frozen);
    const inputs = generationSourceBatches(source);
    const graph = planGenerationGraph(frozen.sourceDigest, frozen.policySha, bytes.byteLength, inputs);
    const graphDigest = generationGraphDigest(graph);
    if (operation === 'generator-continue') {
      const artifactId = required('artifact-id'), runId = required('run-id');
      releaseAssert(/^[1-9]\d*$/.test(artifactId) && /^[1-9]\d*$/.test(runId), 'GENERATION_SEED_ARTIFACT');
      const allowed = await receipts.request<{ continue: boolean; graphDigest: string; reservation: string }>('generation-graph', { action: 'continue', frozen, graphDigest });
      releaseAssert(allowed.continue && allowed.graphDigest === graphDigest && /^continuation:[0-9]+$/.test(allowed.reservation), 'GENERATION_CONTINUATION');
      await dispatchReleaseContinuation(async()=>{
        const centralToken = await createInstallationToken({ appId: environment('APP_ID'), privateKey: environment('STEWARD_APP_PRIVATE_KEY'),
          installationId: Number(environment('INSTALLATION_ID')), repositoryId: 1296724484,
          permissions: { actions: 'write', contents: 'read', metadata: 'read' }, policySha });
        return new GitHubClient(centralToken, 'https://api.github.com', fetch, policySha);
      },policySha,{ repositoryId:String(repositoryId),targetTag:tag,operation:'generate',bundleArtifactId:artifactId,bundleRunId:runId },
      ()=>receipts.request('generation-graph',{action:'release-continuation',frozen,graphDigest,reservation:allowed.reservation}));
      return;
    }
    let offset = 0;
    while (offset < graph.nodes.length) {
      const page = await receipts.request<{ nextOffset: number; ready: boolean; graphDigest: string }>('generation-graph', { action: 'prepare', offset, inputs: inputs.slice(offset, offset + generationGraphLimits.prepareNodes) });
      releaseAssert(page.graphDigest === graphDigest && page.nextOffset === Math.min(offset + generationGraphLimits.prepareNodes, graph.nodes.length), 'GENERATION_PREPARE_PROGRESS');
      offset = page.nextOffset;
      if (offset === graph.nodes.length) releaseAssert(page.ready, 'GENERATION_GRAPH_INCOMPLETE');
    }
    await writeFile(resolve(required('output')), JSON.stringify(await receipts.request('generation-graph', { action: 'ticket', frozen, graphDigest })), { flag: 'wx', mode: 0o600 });
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
      const bytes = await receipts.getObject(digest);
      await writeFile(resolve(required('output')) + '.' + name + '.json', bytes, { flag: 'wx' });
    }
  } else {
    result = await withReleaseClaim(receipts, async session => {
      releaseAssert(session.receipt.frozen.policySha === policySha, 'POLICY_STALE');
      if (operation === 'recover-assets') return recoverReleaseAssets(gh, session, r => verifyReleaseDownloads(r, getToken, fetch, () => session.act('renew-claim')));
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
      return publishReleaseCandidate({ gh, session, assetDirectory: directory, upload: releaseUploader(getToken, policySha, directory), verifyDownloads: r => verifyReleaseDownloads(r, getToken, fetch, () => session.act('renew-claim')) });
    });
  }
  if (operation === 'plan' && !result.paused && ['merged', 'publishing'].includes(result.phase)) result = await withReleaseClaim(receipts, s => s.act('ensure-assets'));
  const shouldPublish = operation === 'plan' && !result.paused && !result.assetRecoveryPending && ['merged', 'publishing'].includes(result.phase);
  const build = currentReleaseBuild(result);
  const outputs = { phase: result.phase, shouldPublish: String(shouldPublish), publishTimeoutMinutes: String(releasePublishTimeoutMinutes(result.frozen.assets)), artifactId: String(build?.artifactId ?? ''), runId: String(build?.runId ?? ''), artifactName: build?.artifactName ?? '' };
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k,v]) => `${k}=${v}\n`).join(''));
  process.stdout.write(JSON.stringify({ candidateId: result.candidateId, revision: result.revision, phase: result.phase, paused: result.paused, error: result.error }) + '\n');
}
