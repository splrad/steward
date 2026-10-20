import { evaluatorSha } from './workflow-evaluator.js';
import { assertPersonalizationConfiguration, refreshPersonalizedSections } from '../../core/src/release-personalization.js';
import { comparePublicVersions, parsePublicVersion } from '../../core/src/release-version.js';
import { releaseProfiles } from '../../../config/release-profiles.js';
import { randomUUID } from 'node:crypto';
import { authorizeSingleRepository, type BodyWriteRuntimeEnv } from './pr-body-api.js';
import { ReleaseReceiptStore, releaseObjectLimits } from './release-note-receipts.js';
import { assertReleasePermit, candidatePaths, candidateProjection, canonicalReleaseJson, newReleaseReceipt, positiveId, receiptDigest, releaseAssert, releaseSha, reviewReleaseReceipt, type ReleaseReceipt } from '../../core/src/release-note-receipt.js';
import { validateReleaseSource, validateReleaseEvidence } from '../../core/src/release-bundle.js';
import { planBuild, matchBuildFiles } from '../../core/src/build-manifest.js';
import { readReleaseContributors, verifyReleaseCommitRange, assertIncreasingReleaseVersion } from '../../github/src/release-candidate.js';
import { readReleaseCandidateFacts, releaseTree, changedTreePaths, readCandidateBlob, optionalReleaseRead } from '../../github/src/release-candidate.js';
import { GitHubRequestError, GitHubClient, createInstallationToken, dispatchWorkflow } from '../../github/src/index.js';
import catalog from '../../../config/repositories.json' with { type: 'json' };
import notesProfile from '../../../config/profiles/release-notes/common-v3.json' with { type: 'json' };
import { ReleaseGenerationStore } from './release-generation-store.js';
import { handleGenerationGraphTicket } from './release-generation-graph-api.js';
import { issueGenerationGraph, acceptedReleaseSeed } from './release-generation-graph-issuer.js';
import { rebindReleaseBuild } from '../../core/src/release-rebuild.js';
import { currentReleaseBuild } from '../../core/src/release-rebuild.js';
import { makeReleaseBuildRequest, releaseToolchainDigest } from '../../core/src/release-build-request.js';
import { ReleaseBuildStore } from './release-build-store.js';
import { handleReleaseBuildAction, centralBuildClient, dispatchReleaseBuild } from './release-build-api.js';

const reply = (status: number, value: unknown) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const botId = 301115370;
export async function handleReleaseRequest(request: Request, env: BodyWriteRuntimeEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/internal/releases/')) return null;
  try {
    releaseAssert(!url.search, 'QUERY');
    const parts = url.pathname.split('/').slice(3), repositoryId = Number(parts[0]);
    releaseAssert(positiveId(repositoryId) && String(repositoryId) === parts[0] && env.ISSUE_SNAPSHOTS, 'ROUTE');
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (bearer.startsWith('release-generation-graph.')) {
      releaseAssert(parts.length === 3 && parts[2] === 'generation-graph' && /^v\d+\.\d+\.\d+$/.test(parts[1]!), 'GENERATION_SCOPE');
      const capability = (catalog.repositories as Record<string, any>)[String(repositoryId)]?.delivery?.githubRelease;
      releaseAssert(capability?.enabled === true && ['pending', 'active'].includes(capability.state), 'CAPABILITY');
      return reply(200, await handleGenerationGraphTicket(request, env.ISSUE_SNAPSHOTS, repositoryId, parts[1]!, env.POLICY_SHA!));
    }
    if (bearer.startsWith('release-generation.')) {
      releaseAssert(parts.length === 3 && parts[2] === 'generation' && /^v\d+\.\d+\.\d+$/.test(parts[1]!), 'GENERATION_SCOPE');
      const capability = (catalog.repositories as Record<string, any>)[String(repositoryId)]?.delivery?.githubRelease;
      releaseAssert(capability?.enabled === true && ['pending', 'active'].includes(capability.state), 'CAPABILITY');
      const generation = new ReleaseGenerationStore(env.ISSUE_SNAPSHOTS);
      await generation.authorize(repositoryId, parts[1]!, bearer, Date.now(), env.POLICY_SHA!);
      if (request.method === 'GET') return reply(200, await generation.read(repositoryId, parts[1]!));
      releaseAssert(request.method === 'POST', 'METHOD');
      const text = await request.text(); releaseAssert(Buffer.byteLength(text) <= releaseObjectLimits.recordBytes, 'REQUEST_LIMIT');
      const body = JSON.parse(text);
      if (body.action === 'prepare') {
        const current = (await generation.read(repositoryId, parts[1]!))!;
        releaseAssert(canonicalReleaseJson(body.plan) === canonicalReleaseJson(current.ledger.plan), 'GENERATION_OCCUPIED'); return reply(200, current);
      }
      releaseAssert(['reserve', 'complete', 'diagnostic'].includes(body.action) && typeof body.input === 'string', 'GENERATION_REQUEST');
      return reply(200, await generation.mutate(repositoryId, parts[1]!, body.version, body.action, body.input, body.index, body.inputDigest, { token: bearer, now: Date.now }));
    }
    const { repository, client: gh } = await authorizeSingleRepository(request, env, repositoryId);
    const store = new ReleaseReceiptStore(env.ISSUE_SNAPSHOTS);
    const [owner, repo] = repository.full_name.split('/') as [string, string];
    const configuration = (catalog.repositories as Record<string, any>)[String(repositoryId)];
    const capability = configuration?.delivery?.githubRelease;
    const canPrepare = () => releaseAssert(capability?.enabled === true && ['pending', 'active'].includes(capability.state), 'CAPABILITY');
    const canPublish = () => releaseAssert(capability?.enabled === true && capability.state === 'active', 'CAPABILITY');
    let body: any = {};
    if (request.method === 'POST') {
      const text = await request.text(); releaseAssert(Buffer.byteLength(text) <= releaseObjectLimits.recordBytes, 'REQUEST_LIMIT');
      body = JSON.parse(text); releaseAssert(body && typeof body === 'object' && !Array.isArray(body), 'REQUEST');
    }
    if (parts[1] === 'objects' && parts.length === 4) {
      const part = Number(parts[3]); releaseAssert(Number.isInteger(part) && part >= 0, 'OBJECT_PART');
      if (request.method === 'POST') { canPrepare(); await store.putChunk(repositoryId, parts[2]!, part, body.total, body.bytesBase64); return reply(200, { stored: true }); }
      if (request.method === 'GET') return reply(200, await store.getChunk(repositoryId, parts[2]!, part));
    }
    if (request.method === 'GET' && parts.length === 4 && parts[2] === 'revisions') {
      releaseAssert(/^v\d+\.\d+\.\d+$/.test(parts[1]!) && positiveId(Number(parts[3])), 'REVISION');
      return reply(200, await store.get(repositoryId, parts[1]!, Number(parts[3])));
    }
    const tag = parts[1]!; releaseAssert(/^v\d+\.\d+\.\d+$/.test(tag) && parts.length <= 3, 'ROUTE');
    const action = parts[2];
    if (action === 'migrate-policy') {
      canPrepare(); releaseAssert(request.method === 'POST', 'METHOD');
      const head = await gh.getGitRef(owner, repo, `heads/${repository.default_branch}`);
      releaseAssert(releaseSha(head.object?.sha), 'BUILD_TARGET_STALE');
      const product = await releaseTree(gh, owner, repo, head.object.sha);
      releaseAssert(await readCandidateBlob(gh, owner, repo, product, 'VERSION') === tag.slice(1) + '\n', 'VERSION_BINDING');
      await assertIncreasingReleaseVersion(gh, owner, repo, tag);
      releaseAssert(!await optionalReleaseRead(() => gh.getReleaseByTag(owner, repo, tag))
        && !await optionalReleaseRead(() => gh.getGitRef(owner, repo, `tags/${tag}`)), 'VERSION_OCCUPIED');
      const current = await store.get(repositoryId, tag);
      let archived: ReleaseReceipt;
      if (current) {
        const claim = await store.claim(repositoryId, tag, Date.now());
        try {
          archived = claim.receipt;
          releaseAssert(archived.frozen.policySha !== env.POLICY_SHA && !archived.releaseId && !archived.operation
            && !['publishing', 'verified'].includes(archived.phase), 'POLICY_MIGRATION_STATE');
          if (archived.pullNumber) {
            const pull = await gh.getPullRequest(owner, repo, archived.pullNumber);
            releaseAssert(pull.state === 'closed', 'POLICY_MIGRATION_OPEN_PR');
          }
          await makeReleaseBuildRequest({ ...archived.frozen, productTargetSha: head.object.sha, policySha: env.POLICY_SHA! }, configuration, 'initial', null);
          await store.migratePolicy(archived, claim.token, env.POLICY_SHA!, Date.now());
        } finally { await store.release(repositoryId, tag, claim.token); }
      } else {
        const pending = await store.migratedReceipt(repositoryId, tag);
        releaseAssert(pending, 'POLICY_MIGRATION_NOT_FOUND');
        if (pending.pullNumber) {
          const pull = await gh.getPullRequest(owner, repo, pending.pullNumber);
          releaseAssert(pull.state === 'closed', 'POLICY_MIGRATION_OPEN_PR');
        }
        await makeReleaseBuildRequest({ ...pending.frozen, productTargetSha: head.object.sha, policySha: env.POLICY_SHA! }, configuration, 'initial', null);
        archived = await store.resumePolicy(repositoryId, tag, env.POLICY_SHA!);
      }
      await makeReleaseBuildRequest({ ...archived.frozen, productTargetSha: head.object.sha, policySha: env.POLICY_SHA! }, configuration, 'initial', null);
      await dispatchWorkflow(await centralBuildClient(env, true), { owner: 'splrad', repo: 'steward', workflow: 'release-build.yml', policySha: env.POLICY_SHA!,
        inputs: { repositoryId: String(repositoryId), targetTag: tag, targetSha: head.object.sha, authorIds: archived.frozen.authorIds.join(',') } });
      return reply(200, { migratedRevision: archived.revision, policySha: env.POLICY_SHA, rebuildDispatched: true });
    }
    if (action === 'build-request') {
      releaseAssert(request.method === 'POST', 'METHOD');
      return reply(200, await handleReleaseBuildAction(env, gh, { ...repository, id: repositoryId }, configuration, tag, body));
    }
    if (action === 'generation-graph') {
      canPrepare(); releaseAssert(request.method === 'POST', 'METHOD');
      return reply(200, await issueGenerationGraph(env.ISSUE_SNAPSHOTS, repositoryId, tag, env.POLICY_SHA!, body));
    }
    if (action === 'generation') {
      canPrepare();
      const durable = await env.ISSUE_SNAPSHOTS.prepare('SELECT graph_digest FROM release_generation_graphs WHERE repository_id=? AND target_tag=? AND runs>0 LIMIT 1')
        .bind(repositoryId, tag).first();
      releaseAssert(!durable, 'GENERATION_PROTOCOL_UPGRADED');
      const generation = new ReleaseGenerationStore(env.ISSUE_SNAPSHOTS);
      if (request.method === 'GET') return reply(200, await generation.read(repositoryId, tag));
      releaseAssert(request.method === 'POST', 'METHOD');
      if (body.action === 'prepare') {
        releaseAssert(body.plan?.policySha === env.POLICY_SHA, 'POLICY_STALE');
        return reply(200, await generation.prepare(repositoryId, tag, body.plan));
      }
      if (body.action === 'ticket') {
        releaseAssert(typeof body.planDigest === 'string', 'GENERATION_PLAN');
        return reply(200, { token: await generation.ticket(repositoryId, tag, Date.now(), body.planDigest) });
      }
      releaseAssert(false, 'GENERATION_TICKET_REQUIRED');
    }
    if (request.method === 'GET' && !action) return reply(200, await store.get(repositoryId, tag));
    releaseAssert(request.method === 'POST', 'METHOD');
    const verifyPrepared = async (r: ReleaseReceipt) => {
      assertPersonalizationConfiguration(r.frozen, configuration, releaseProfiles);
      canPrepare();
      releaseAssert(r.frozen.repositoryId === repositoryId && r.frozen.fullName === repository.full_name && r.frozen.defaultBranch === repository.default_branch
        && r.frozen.targetTag === tag && r.frozen.policySha === env.POLICY_SHA, 'PREPARE_IDENTITY');
      releaseAssert(r.frozen.templateDigest === receiptDigest(canonicalReleaseJson(notesProfile)), 'TEMPLATE');
      const commit = await gh.getGitCommit(owner, repo, r.frozen.productTargetSha);
      releaseAssert(commit.sha === r.frozen.productTargetSha && commit.tree?.sha === r.frozen.productTree, 'PRODUCT_TREE');
      const product = await releaseTree(gh, owner, repo, r.frozen.productTargetSha);
      releaseAssert(await readCandidateBlob(gh, owner, repo, product, 'VERSION') === r.frozen.targetTag.slice(1) + '\n', 'VERSION_BINDING');
      await assertIncreasingReleaseVersion(gh, owner, repo, r.frozen.targetTag);
      const source = validateReleaseSource(await store.readObject(repositoryId, r.frozen.sourceDigest), r.frozen);
      await verifyReleaseCommitRange(gh, owner, repo, source, r.frozen.productTargetSha);
      const boundaryTree = source.boundary.kind === 'full-tree' ? { entries: [], object: null } : await releaseTree(gh, owner, repo, source.boundary.sha);
      const changed = changedTreePaths(boundaryTree, product);
      const retainedPaths = source.changes.flatMap((c: any) => c.previousPath ? [c.previousPath, c.path] : [c.path]);
      releaseAssert(JSON.stringify([...new Set(retainedPaths)].sort()) === JSON.stringify(changed), 'SOURCE_DIFF');
      for (const change of source.changes) {
        const before = boundaryTree.entries.find((e: any) => e.path === (change.previousPath ?? change.path)), after = product.entries.find(e => e.path === change.path);
        releaseAssert((before ? change.before?.oid === before.sha && change.before.mode === before.mode : change.before === null)
          && (after ? change.after?.oid === after.sha && change.after.mode === after.mode : change.after === null), 'SOURCE_DIFF_OBJECT');
      }
      validateReleaseEvidence(await store.readObject(repositoryId, r.frozen.evidenceDigest), r.frozen, source);
      const compare = source.boundary.kind === 'full-tree' ? null : `https://github.com/${r.frozen.fullName}/compare/${source.boundary.kind === 'tag' ? source.boundary.reference : source.boundary.sha}...${tag}`;
      releaseAssert(r.frozen.compareUrl === compare, 'COMPARE_BINDING');
      for (const link of r.frozen.allowedLinks) {
        if (link === compare) continue;
        const prefix = `https://github.com/${r.frozen.fullName}/pull/`, number = link.startsWith(prefix) ? Number(link.slice(prefix.length)) : 0;
        releaseAssert(positiveId(number) && link === prefix + number, 'LINK_SOURCE');
        const linked = await gh.listPullCommits(owner, repo, number);
        releaseAssert(linked.some(c => source.commits.some((s: any) => s.sha === c.sha)), 'LINK_SOURCE');
      }
      releaseAssert(JSON.stringify([...capability.builds].sort()) === JSON.stringify(r.frozen.manifests.map(m => m.buildId).sort()), 'BUILD_SET');
      for (const manifest of r.frozen.manifests) {
        const plan = await planBuild(manifest, configuration.builds[manifest.buildId]);
        releaseAssert(plan.inputsSha256 === manifest.inputsSha256, 'BUILD_INPUTS');
        const files = manifest.artifacts.map(a => { releaseAssert(a.kind === 'file', 'BUILD_ASSET'); return a.file; });
        const expected = matchBuildFiles(plan, files);
        releaseAssert(expected.every(e => manifest.artifacts.some(a => a.kind === 'file' && a.id === e.id && a.file === e.file && a.mediaType === e.mediaType)), 'BUILD_OUTPUTS');
      }
      if (r.frozen.build) {
        const token = await createInstallationToken({ appId: env.APP_ID, privateKey: env.STEWARD_APP_PRIVATE_KEY!, installationId: Number(env.INSTALLATION_ID), repositoryId: 1296724484, permissions: { actions: 'read', metadata: 'read' }, policySha: env.POLICY_SHA });
        const central = new GitHubClient(token, 'https://api.github.com', fetch, env.POLICY_SHA);
        const b = r.frozen.build;
        const run = await central.request<any>('GET', `/repos/splrad/steward/actions/runs/${b.runId}`);
        const artifact = await central.request<any>('GET', `/repos/splrad/steward/actions/artifacts/${b.artifactId}`);
        releaseAssert(run.id === b.runId && run.repository?.id === 1296724484 && run.head_sha === b.headSha && run.event === 'workflow_dispatch'
          && run.status === 'completed' && run.conclusion === 'success' && artifact.id === b.artifactId && artifact.name === b.artifactName
          && artifact.expired === false && artifact.workflow_run?.id === b.runId && artifact.workflow_run.head_sha === b.headSha, 'BUILD_PROVENANCE');
      }
      else {
        const seed = await acceptedReleaseSeed(env.ISSUE_SNAPSHOTS!, repositoryId, tag, env.POLICY_SHA);
        // Generation produces evidence; every other frozen field remains seed-bound.
        releaseAssert(canonicalReleaseJson(r.frozen) === canonicalReleaseJson({ ...seed, evidenceDigest: r.frozen.evidenceDigest }), 'PREPARE_SEED_BINDING');
      }
      // Stable numeric IDs and actual commit associations, never names supplied by a model.
      const humans = await readReleaseContributors(gh, owner, repo, source.commits);
      releaseAssert(humans.size === r.frozen.contributors.length, 'CONTRIBUTOR_SOURCE');
      for (const person of r.frozen.contributors) releaseAssert(humans.get(person.id) === person.login, 'CONTRIBUTOR_SOURCE');
      for (const id of r.frozen.authorIds) {
        const actor = await gh.request<any>('GET', `/user/${id}`);
        releaseAssert(actor.id === id && actor.type === 'User', 'AUTHOR_IDENTITY');
      }
    };
    if (action === 'prepare') {
      const existing = await store.get(repositoryId, tag);
      const r = newReleaseReceipt(body.frozen, body.draftNotes, existing?.revision ?? await store.nextRevision(repositoryId, tag));
      if (existing && existing.frozen.policySha === env.POLICY_SHA && existing.frozenDigest === r.frozenDigest && existing.draftNotes === r.draftNotes) return reply(200, existing);
      await verifyPrepared(r);
      return reply(200, await store.prepare(r, new Date().toISOString()));
    }
    if (action === 'claim') return reply(200, await store.claim(repositoryId, tag, Date.now()));
    if (action === 'release-claim') { await store.release(repositoryId, tag, body.token); return reply(200, { released: true }); }
    releaseAssert(typeof body.token === 'string' && Number.isSafeInteger(body.version), 'CLAIM');
    const r = await store.assertClaim(repositoryId, tag, body.token, body.version, Date.now());
    releaseAssert(r.frozen.policySha === env.POLICY_SHA, 'POLICY_STALE');
    if (action === 'renew-claim') return reply(200, r);
    const save = (next: ReleaseReceipt) => store.save(r, next, body.token, Date.now());
    if (action === 'ensure-assets') {
      canPrepare();
      releaseAssert(!r.paused && ['merged', 'publishing'].includes(r.phase), 'REBUILD_STATE');
      if (r.releaseId) {
        const release = await gh.request<any>('GET', `/repos/${owner}/${repo}/releases/${r.releaseId}`);
        if (release.draft === false) return reply(200, { ...r, assetRecoveryPending: false });
      }
      const b = currentReleaseBuild(r); if (!b) return reply(200, r);
      const central = await centralBuildClient(env);
      const artifact = await optionalReleaseRead(() => central.request<any>('GET', `/repos/splrad/steward/actions/artifacts/${b.artifactId}`));
      if (artifact && artifact.expired === false && body.unavailable !== true) {
        releaseAssert(artifact.workflow_run?.id === b.runId && artifact.workflow_run.head_sha === b.headSha && artifact.name === b.artifactName, 'BUILD_PROVENANCE');
        return reply(200, { ...r, assetRecoveryPending: false });
      }
      releaseAssert(r.frozen.toolchainDigest === releaseToolchainDigest, 'REBUILD_TOOLCHAIN');
      const buildStore = new ReleaseBuildStore(env.ISSUE_SNAPSHOTS!);
      let state = await buildStore.prepare(await makeReleaseBuildRequest(r.frozen, configuration, 'rebuild', b.artifactId));
      if (state.error === 'rebuild-changed-review-required' && state.artifact && state.resultManifests) {
        return reply(200, await save({ ...r, paused: true, error: state.error, rebuildRequestKey: state.request.key }));
      }
      if (state.status === 'running') {
        const last = state.attempts.at(-1)!;
        const run = await central.request<any>('GET', `/repos/splrad/steward/actions/runs/${last.runId}`);
        releaseAssert(run.id === last.runId && run.run_attempt === last.attempt && run.head_sha === env.POLICY_SHA && run.path === '.github/workflows/release-build.yml', 'BUILD_RUN_PROVENANCE');
        if (run.status === 'completed') {
          if (run.conclusion === 'success') {
            await store.assertClaim(repositoryId, tag, body.token, body.version, Date.now());
            await dispatchWorkflow(await centralBuildClient(env, true), { owner: 'splrad', repo: 'steward', workflow: 'release-build-complete.yml', policySha: env.POLICY_SHA!, inputs: { runId: String(run.id) } });
          } else state = await buildStore.save(state, { ...state, status: 'failed', error: 'build-run-failed' });
        }
      }
      if (state.attempts.length >= 3 && state.status === 'failed') return reply(200, await save({ ...r, paused: true, error: 'rebuild-budget-exhausted' }));
      if (['requested', 'failed'].includes(state.status)) {
        await store.assertClaim(repositoryId, tag, body.token, body.version, Date.now());
        await dispatchReleaseBuild(env, repositoryId, tag, state.request.key);
      }
      return reply(200, { ...r, assetRecoveryPending: true });
    }
    if (action === 'rebind-build') {
      canPrepare();
      const next = rebindReleaseBuild(r, body.build, body.manifests, body.toolchainDigest, new Date().toISOString());
      const token = await createInstallationToken({ appId: env.APP_ID, privateKey: env.STEWARD_APP_PRIVATE_KEY!, installationId: Number(env.INSTALLATION_ID), repositoryId: 1296724484, permissions: { actions: 'read', metadata: 'read' }, policySha: env.POLICY_SHA });
      const central = new GitHubClient(token, 'https://api.github.com', fetch, env.POLICY_SHA);
      const run = await central.request<any>('GET', `/repos/splrad/steward/actions/runs/${body.build.runId}`);
      const artifact = await central.request<any>('GET', `/repos/splrad/steward/actions/artifacts/${body.build.artifactId}`);
      releaseAssert(run.id === body.build.runId && run.repository?.id === 1296724484 && run.head_sha === r.frozen.policySha
        && run.event === 'workflow_dispatch' && run.status === 'completed' && run.conclusion === 'success'
        && artifact.id === body.build.artifactId && artifact.name === body.build.artifactName && artifact.expired === false
        && artifact.workflow_run?.id === run.id && artifact.workflow_run.head_sha === run.head_sha, 'BUILD_PROVENANCE');
      return reply(200, await save(next));
    }
    if (action === 'revise-rebuild') {
      canPrepare();
      const rebuilt = await new ReleaseBuildStore(env.ISSUE_SNAPSHOTS!).get(body.key, repositoryId, tag);
      releaseAssert(rebuilt?.error === 'rebuild-changed-review-required' && rebuilt.artifact && rebuilt.resultManifests
        && rebuilt.request.mode === 'rebuild' && rebuilt.request.frozen.policySha === env.POLICY_SHA, 'REBUILD_RESULT');
      if (r.rebuildRequestKey === body.key && !r.paused && r.frozen.build?.artifactId === rebuilt.artifact.artifactId) return reply(200, r);
      releaseAssert(r.paused && r.error === 'rebuild-changed-review-required' && r.rebuildRequestKey === body.key
        && r.frozenDigest === receiptDigest(canonicalReleaseJson(rebuilt.request.frozen))
        && r.approvedNotes !== null && r.merge && r.pullNumber && !r.releaseId && !r.operation, 'REVISION_STATE');
      const pull = await gh.getPullRequest(owner, repo, r.pullNumber);
      releaseAssert(pull.state === 'closed' && pull.merged === true && pull.merge_commit_sha === r.merge.commitSha, 'REVISION_MERGE');
      releaseAssert(!await optionalReleaseRead(() => gh.getReleaseByTag(owner, repo, tag))
        && !await optionalReleaseRead(() => gh.getGitRef(owner, repo, `tags/${tag}`)), 'VERSION_OCCUPIED');
      const head = await gh.getGitRef(owner, repo, `heads/${r.frozen.defaultBranch}`);
      const base = await releaseTree(gh, owner, repo, head.object.sha), target = await releaseTree(gh, owner, repo, r.frozen.productTargetSha);
      const paths = candidatePaths(r);
      releaseAssert(changedTreePaths(target, base).every(path => paths.includes(path))
        && await readCandidateBlob(gh, owner, repo, base, paths[0]) === canonicalReleaseJson(candidateProjection(r))
        && await readCandidateBlob(gh, owner, repo, base, paths[1]) === r.approvedNotes, 'REVISION_PRODUCT_DRIFT');
      const frozen = { ...r.frozen, build: rebuilt.artifact, manifests: rebuilt.resultManifests,
        assets: rebuilt.resultManifests.flatMap(m => m.artifacts.map(a => { releaseAssert(a.kind === 'file', 'BUILD_FILE'); return { name: a.file, size: a.size, sha256: a.sha256 }; })) };
      const draftNotes = refreshPersonalizedSections(r.approvedNotes, r.frozen, frozen);
      const next = { ...newReleaseReceipt(frozen, draftNotes, r.revision + 1), rebuildRequestKey: body.key,
        candidateBase: { sha: head.object.sha, tree: base.object.tree.sha } };
      await verifyPrepared(next);
      return reply(200, await store.revise(r, next, body.token, Date.now()));
    }
    if (action === 'revise') {
      releaseAssert(r.paused && !r.releaseId && !r.operation, 'REVISION_STATE');
      if (r.pullNumber) { const pull = await gh.getPullRequest(owner, repo, r.pullNumber); releaseAssert(pull.state === 'closed' && pull.merged === false, 'REVISION_OPEN'); }
      releaseAssert(!await optionalReleaseRead(() => gh.getReleaseByTag(owner, repo, tag)) && !await optionalReleaseRead(() => gh.getGitRef(owner, repo, `tags/${tag}`)), 'VERSION_OCCUPIED');
      const next = newReleaseReceipt(body.frozen, body.draftNotes, r.revision + 1);
      await verifyPrepared(next);
      return reply(200, await store.revise(r, next, body.token, Date.now()));
    }
    if (action === 'record-error') return reply(200, await save({ ...r, error: r.error ?? 'lifecycle-operation-failed' }));
    const publishPermit = async () => {
      canPublish(); assertReleasePermit(r);
      releaseAssert((await gh.getImmutableReleaseStatus(owner, repo)).enabled === true, 'IMMUTABLE_POLICY');
      const boundary = r.frozen.boundary;
      if (boundary.kind === 'tag') {
        let object = (await gh.getGitRef(owner, repo, `tags/${boundary.reference}`)).object;
        for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) object = (await gh.request<any>('GET', `/repos/${owner}/${repo}/git/tags/${object.sha}`)).object;
        releaseAssert(object?.type === 'commit' && object.sha === boundary.sha, 'BOUNDARY_DRIFT');
      }
      await assertIncreasingReleaseVersion(gh, owner, repo, tag, r.releaseId);
      const fresh = reviewReleaseReceipt({ ...r, phase: 'awaiting-review' }, await readReleaseCandidateFacts(gh, r, Number(env.APP_ID), botId, env.WORKFLOW_EVALUATOR_SHA === undefined ? undefined : evaluatorSha(env)));
      assertReleasePermit(fresh);
      releaseAssert(fresh.approvedNotes === r.approvedNotes && fresh.headSha === r.headSha && fresh.merge?.commitSha === r.merge?.commitSha, 'APPROVAL_DRIFT');
      if (r.releaseId) {
        const release = await remoteRelease();
        releaseAssert(release.draft === true, 'DRAFT_REQUIRED');
        releaseAssert(release.assets.every((a: any) => r.frozen.assets.some(e => e.name === a.name && e.size === a.size && `sha256:${e.sha256}` === a.digest)), 'ASSET_CONFLICT');
      }
      await store.assertClaim(repositoryId, tag, body.token, body.version, Date.now());
    };
    const remoteRelease = async () => {
      const release = r.releaseId ? await gh.request<any>('GET', `/repos/${owner}/${repo}/releases/${r.releaseId}`) : await optionalReleaseRead(() => gh.getReleaseByTag(owner, repo, tag));
      releaseAssert(release && release.tag_name === tag && release.target_commitish === r.frozen.productTargetSha && release.body === r.approvedNotes && release.prerelease === false, 'REMOTE_IDENTITY');
      if (r.releaseId) releaseAssert(release.id === r.releaseId, 'RELEASE_ID');
      if (r.releaseId) releaseAssert(release.name === (release.draft ? r.draftTitle : r.frozen.title), 'RELEASE_TITLE');
      return release;
    };
    if (action === 'candidate-commit') {
      canPrepare(); releaseAssert(!r.paused && r.phase === 'prepared' && releaseSha(body.sha) && (!r.initialCommitSha || r.initialCommitSha === body.sha), 'CANDIDATE_COMMIT');
      const target = await releaseTree(gh, owner, repo, r.frozen.productTargetSha), candidate = await releaseTree(gh, owner, repo, body.sha);
      const paths = candidatePaths(r);
      releaseAssert(JSON.stringify(changedTreePaths(target, candidate)) === JSON.stringify([...paths].sort())
        && candidate.object.parents?.length === 1 && candidate.object.parents[0].sha === (r.candidateBase?.sha ?? r.frozen.productTargetSha)
        && await readCandidateBlob(gh, owner, repo, candidate, paths[0]) === canonicalReleaseJson(candidateProjection(r))
        && await readCandidateBlob(gh, owner, repo, candidate, paths[1]) === r.draftNotes, 'CANDIDATE_COMMIT_SCOPE');
      return reply(200, await save({ ...r, initialCommitSha: body.sha }));
    }
    if (action === 'bind') {
      canPrepare(); releaseAssert(!r.paused && r.initialCommitSha && positiveId(body.pullNumber) && (!r.pullNumber || r.pullNumber === body.pullNumber), 'BIND');
      const candidate = { ...r, pullNumber: body.pullNumber };
      const facts = await readReleaseCandidateFacts(gh, candidate, Number(env.APP_ID), botId, env.WORKFLOW_EVALUATOR_SHA === undefined ? undefined : evaluatorSha(env));
      releaseAssert(facts.headSha === r.initialCommitSha && !facts.merged && !facts.closed && facts.notes === r.draftNotes, 'BIND_HEAD');
      return reply(200, await save({ ...candidate, headSha: facts.headSha, phase: 'awaiting-review' }));
    }
    if (action === 'review') {
      releaseAssert(!['publishing', 'verified'].includes(r.phase) && !r.paused, 'SEALED');
      try { return reply(200, await save(reviewReleaseReceipt(r, await readReleaseCandidateFacts(gh, r, Number(env.APP_ID), botId, env.WORKFLOW_EVALUATOR_SHA === undefined ? undefined : evaluatorSha(env))))); }
      catch (error) { await save({ ...r, phase: 'awaiting-review', approval: null, approvedNotes: null, merge: null, error: error instanceof Error ? error.message : 'review-failed' }); throw error; }
    }
    if (action === 'pause' || action === 'resume') {
      releaseAssert(r.phase !== 'verified', 'SEALED');
      releaseAssert(!r.error?.startsWith('rebuild-'), 'REBUILD_REVIEW_REQUIRED');
      return reply(200, await save({ ...r, paused: action === 'pause', error: action === 'pause' ? 'manually-paused' : null }));
    }
    if (action === 'permit') { await publishPermit(); return reply(200, r); }
    if (action === 'retry-create') {
      await publishPermit();
      releaseAssert(!r.releaseId && r.operation?.kind === 'create-release' && Date.now() - Date.parse(r.operation.startedAt) >= 60 * 60_000, 'CREATION_STILL_UNCERTAIN');
      releaseAssert(!await optionalReleaseRead(() => gh.getReleaseByTag(owner, repo, tag)) && !await optionalReleaseRead(() => gh.getGitRef(owner, repo, `tags/${tag}`))
        && !(await gh.listReleases(owner, repo)).some((release: any) => release.tag_name === tag), 'VERSION_OCCUPIED');
      return reply(200, await save({ ...r, phase: 'merged', operation: null, error: null }));
    }
    if (action === 'operation') {
      await publishPermit();
      releaseAssert(['create-release', 'upload-asset', 'publish'].includes(body.kind), 'OPERATION');
      if (body.kind === 'publish') {
        const release = await remoteRelease();
        releaseAssert(release.assets.length === r.frozen.assets.length && release.assets.every((a: any) => r.assetIds[a.name] === a.id), 'ASSETS_INCOMPLETE');
      }
      if (r.operation) { releaseAssert(r.operation.kind === body.kind, 'PENDING_OPERATION'); return reply(200, r); }
      return reply(200, await save({ ...r, phase: 'publishing', attempts: r.attempts + 1, operation: { kind: body.kind, key: randomUUID(), startedAt: new Date().toISOString() } }));
    }
    if (action === 'record-release') {
      const release = await remoteRelease();
      releaseAssert(r.operation?.kind === 'create-release' && release.draft === true && release.author?.id === botId
        && release.name === `${r.frozen.title} [${r.operation.key}]`, 'RELEASE_OWNERSHIP');
      return reply(200, await save({ ...r, releaseId: release.id, releaseUrl: release.html_url, draftTitle: release.name, operation: null }));
    }
    if (action === 'record-assets' || action === 'verify') {
      releaseAssert(r.releaseId && ['publishing', 'verified'].includes(r.phase), 'RELEASE_UNBOUND');
      const release = await remoteRelease();
      if (action === 'record-assets') releaseAssert(release.draft === true, 'DRAFT_REQUIRED');
      releaseAssert(Array.isArray(release.assets) && new Set(release.assets.map((a: any) => a.name)).size === release.assets.length, 'REMOTE_ASSETS');
      const assetIds: Record<string, number> = {};
      for (const asset of release.assets) {
        const expected = r.frozen.assets.find(a => a.name === asset.name);
        releaseAssert(expected && expected.size === asset.size && `sha256:${expected.sha256}` === asset.digest && positiveId(asset.id)
          && (!r.assetIds[asset.name] || r.assetIds[asset.name] === asset.id), 'ASSET_CONFLICT'); assetIds[asset.name] = asset.id;
      }
      releaseAssert(Object.entries(r.assetIds).every(([name, id]) => assetIds[name] === id), 'ASSET_REMOVED');
      if (action === 'verify') {
        releaseAssert(JSON.stringify(body.downloaded) === JSON.stringify(r.frozen.assets.map(a => a.sha256)), 'DOWNLOAD_RECEIPT');
        const ref = await gh.getGitRef(owner, repo, `tags/${tag}`);
        const latest = await gh.getLatestRelease(owner, repo);
        const latestValid = latest.id === r.releaseId || (latest.draft === false && latest.prerelease === false
          && /^v\d+\.\d+\.\d+$/.test(latest.tag_name)
          && comparePublicVersions(parsePublicVersion(latest.tag_name.slice(1)), parsePublicVersion(tag.slice(1))) > 0);
        releaseAssert(release.draft === false && release.immutable === true && release.name === r.frozen.title && release.assets.length === r.frozen.assets.length
          && ref.object?.type === 'commit' && ref.object.sha === r.frozen.productTargetSha && latestValid, 'VERIFY');
      }
      return reply(200, await save({ ...r, assetIds, downloadedDigests: action === 'verify' ? body.downloaded : r.downloadedDigests, operation: null, phase: action === 'verify' ? 'verified' : r.phase, error: null }));
    }
    return reply(404, { error: 'release-route-not-found' });
  } catch (error) {
    if (error instanceof GitHubRequestError) return reply([401, 403, 404].includes(error.status) ? 403 : 502, { error: 'release-github-read-failed' });
    const message = error instanceof Error ? error.message : 'release-operation-failed';
    return reply(message.startsWith('RN_RECEIPT_') ? 409 : 503, { error: message.startsWith('RN_RECEIPT_') ? message : 'release-operation-failed' });
  }
}
