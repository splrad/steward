import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { TagName } from 'release-please/build/src/util/tag-name.js';
import { Version } from 'release-please/build/src/version.js';
import { parseDocument } from 'yaml';
import { advanceReleaseCandidate, pushPreparedCandidate, collectContentInput, planContentBatches,
  resumeContentBatches, assembleUnitNotes, copilotReleaseClient, decodeCandidateDocument, splitContentText, releaseAffectedUnitIds, isolatedBuildEnvironment,
  parseDeliveryConfig, parseSupplementalNotes, assertDeliveryPath, assertProductDelivery, mergedBuildCycle, assertRepositoryWrite, completeMergedPull } from '../packages/runner/dist/index.js';
import { readReleaseRecords, writeReleaseRecords, assertReleaseWriterProtection } from './release-record.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fail = code => { throw new Error(code); };

/** Fixed candidate adapter. Credentials never enter archived data or model/RP payloads. */
export async function nativeReleaseCandidate(request, { token, readToken, copilotToken, controllerSha, controllerDirectory = process.cwd(), now = () => new Date().toISOString(), fetcher = fetch, generator, language, temporaryRoot = tmpdir(),verifyHandoff } = {}) {
  if (!readToken || readToken === token) return { status: 'WAIT', reason: 'CANDIDATE_SCOPED_READ_CREDENTIAL_REQUIRED' };
  if (!validSha(controllerSha)) return { status: 'WAIT', reason: 'CANDIDATE_CONTROLLER_IDENTITY_REQUIRED' };
  const root = await mkdtemp(join(temporaryRoot, 'steward-candidate-native-'));
  await mkdir(request.writeDirectory, { recursive: true });
  const env = isolatedBuildEnvironment(process.env, root);
  Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${request.remote}.extraheader`, GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + readToken).toString('base64') });
  const git = async (...args) => (await promisify(execFile)('git', ['--no-replace-objects', '-c', 'core.hooksPath=', '-c', 'credential.helper=', '-c', 'core.fsmonitor=false', ...args],
    { cwd: request.directory, env, encoding: 'buffer', windowsHide: true, timeout: 90_000, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const api = async (method, path, body, allow404 = false) => {
    if (!path.startsWith(`/repos/${request.repository}/`) && !/^\/users\/[A-Za-z0-9-]+(?:\[bot\])?$/.test(decodeURIComponent(path))) fail('CANDIDATE_API_PATH');
    // The parent already holds Actions read; the Release Please child stays read-only content/PR scoped.
    const workflowInventory = path.split('?')[0] === `/repos/${request.repository}/actions/workflows`;
    const credential = method === 'GET' && !workflowInventory ? readToken : token;
    const response = await fetcher('https://api.github.com' + path, { method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: 'Bearer ' + credential, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (allow404 && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); fail(`CANDIDATE_NATIVE_HTTP_${response.status}`); }
    const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 16 * 1024 * 1024) fail('CANDIDATE_NATIVE_RESPONSE_LIMIT');
    return bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
  };
  const native = async path => {
    const value=await api('GET', `/repos/${request.repository}${path?'/'+path:''}`), pull=/^pulls\/([1-9][0-9]*)$/.exec(path);
    return pull ? completeMergedPull(request.repository,Number(pull[1]),value,()=>pages(`issues/${pull[1]}/events`)) : value;
  };
  const pages = async path => {
    const all = [], seen = new Set();
    for (let page = 1; page <= 10000; page++) {
      const values = await native(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(values)) fail('CANDIDATE_PAGINATION_SHAPE');
      for (const value of values) { const key = value.id ?? value.name; if (seen.has(key)) fail('CANDIDATE_PAGINATION_DUPLICATE'); seen.add(key); all.push(value); }
      if (values.length < 100) return all;
    }
    fail('CANDIDATE_PAGINATION_INCOMPLETE');
  };
  const fileAt = async (sha, path) => {
    if(!validSha(sha))fail('CANDIDATE_SOURCE_IDENTITY');assertDeliveryPath(path);
    const entry=(await git('ls-tree','-z',sha,'--',path)).toString('utf8');
    if(!new RegExp('^100(?:644|755) blob [a-f0-9]{40}\\t').test(entry)||entry.slice(entry.indexOf('\t')+1)!==path+'\0')fail('CANDIDATE_REGULAR_SOURCE_REQUIRED');
    return (await git('cat-file','blob',entry.slice(12,52))).toString('utf8');
  };
  const fetchBranch = async branch => {
    const ref = await api('GET', `/repos/${request.repository}/git/ref/heads/${branch}`, undefined, true);
    if (!ref) return null;
    if (!validSha(ref.object?.sha) || ref.object.type !== 'commit') fail('CANDIDATE_REF_IDENTITY');
    await git('fetch', '--no-tags', '--no-recurse-submodules', request.remote, `refs/heads/${branch}`);
    const head = (await git('rev-parse', 'FETCH_HEAD')).toString().trim(); if (head !== ref.object.sha) fail('CANDIDATE_REF_DRIFT');
    await git('update-ref', `refs/heads/${branch}`, head); return head;
  };
  try {
    // History closure may have adopted a newer state in a separate checkout.
    // Load the exact native ref before opening the next candidate session.
    if(!await fetchBranch('steward/release-state'))fail('CANDIDATE_STATE_UNAVAILABLE');
    let state = await readReleaseRecords({ directory: request.directory, targetRef: 'steward/release-state', repositoryId: request.repositoryId, includeHistory: false });
    assertRepositoryWrite(state.repository);
    const loaded = new Map(state.domainRecords.map(r => [r.path, r.content]));
    const priorState = (await git('show', `${state.head}:state.json`)).toString('utf8'); loaded.set('state.json', priorState);
    // Recovered archives may exist only in history. Compare writes against the
    // actual current tree, including cycle records outside domainRecords.
    const persisted = new Map([...loaded].filter(([path]) => state.currentPaths.includes(path)));
    for (const path of state.currentPaths.filter(path => path.startsWith('cycles/')))
      persisted.set(path, await fileAt(state.head, path));
    let expectedHead = state.head, writes = 0, lastFacts = null, lastProtections = null, delivery = null;
    const loadDocument = async path => {
      const text = loaded.get(path); if (text === undefined) return null;
      const first = JSON.parse(text), chunks = [first];
      for (let i = 1; i < first.count; i++) {
        const part = loaded.get(path.replace(/\.json$/, `-${i}.json`)); if (!part) fail('CANDIDATE_ARCHIVE_MISSING'); chunks.push(JSON.parse(part));
      }
      return decodeCandidateDocument(chunks);
    };
    const archive = (kind, candidate, path, value) => {
      const content = JSON.stringify(value), documentDigest = hash(content), parts = splitContentText(content, 120 * 1024);
      return parts.map((part, index) => ({ path: index === 0 ? path : path.replace(/\.json$/, `-${index}.json`),
        content: JSON.stringify({ schemaVersion: 1, repositoryId: request.repositoryId, candidateId: candidate, documentKind: kind, documentDigest, index, count: parts.length, content: part.text }) + '\n' }));
    };
    const persist = async files => {
      const changes = files.filter(f => persisted.get(f.path) !== f.content).map(f => ({ ...f, sha256: hash(f.content), previousSha256: persisted.has(f.path) ? hash(persisted.get(f.path)) : null }));
      if (!changes.length) return expectedHead;
      await assertReleaseWriterProtection(request.repository, 'steward/release-state', { request: async (method, path) => {
        // Protection endpoints require the parent's administration-read credential.
        const response = await fetcher('https://api.github.com' + path, { method, headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } });
        return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), headers: response.headers };
      } }, {token,fetcher});
      const result = await writeReleaseRecords({ directory: join(request.writeDirectory, `candidate-${++writes}`), remote: request.remote,
        repositoryId: request.repositoryId, defaultBranch: request.defaultBranch, targetRef: 'steward/release-state', writer: 'release', expectedHead,
        allowedPaths: changes.map(f => f.path), changes, identity: request.identity }, { token });
      if (!['APPLIED', 'UNCHANGED'].includes(result.status)) fail('CANDIDATE_STATE_CONFLICT');
      expectedHead = result.head; for (const file of changes) { loaded.set(file.path, file.content); persisted.set(file.path, file.content); } return expectedHead;
    };
    const source = async () => {
      const baseSha = await fetchBranch(request.defaultBranch); if (!baseSha) fail('CANDIDATE_DEFAULT_BRANCH_UNAVAILABLE');
      const config = await fileAt(baseSha, 'release-please-config.json'), manifest = await fileAt(baseSha, '.release-please-manifest.json');
      delivery = parseDeliveryConfig(JSON.parse(await fileAt(baseSha, '.github/delivery.json')));
      assertProductDelivery(delivery,request.repository);
      const rules = await native(`rules/branches/${encodeURIComponent(request.defaultBranch)}`);
      if (!Array.isArray(rules) || !rules.some(r => r.type === 'non_fast_forward') || !rules.some(r => r.type === 'deletion')) fail('CANDIDATE_SOURCE_PROTECTION_REQUIRED');
      const settings = JSON.parse(config), versions = JSON.parse(manifest);
      const initial = Object.values(versions).every(version => !version || version === '0.0.0');
      const releases = initial ? await pages('releases') : [], tags = initial ? await pages('tags') : [];
      if(JSON.stringify(Object.keys(settings.packages??{}).sort())!==JSON.stringify(delivery.units.map(unit=>unit.path).sort()))fail('CANDIDATE_UNIT_COVERAGE');
      const boundaries = [];
      for (const unit of delivery.units) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit.id) || typeof unit.path !== 'string') fail('CANDIDATE_DELIVERY_UNIT');
        const opts = { ...settings, ...settings.packages?.[unit.path] }, version = versions[unit.path];
        if (!version || version === '0.0.0') { boundaries.push({ path: unit.path, kind: 'full-tree', sha: null, reference: null, found: true }); continue; }
        const component = opts['include-component-in-tag'] === false ? undefined : opts.component;
        if (opts['include-component-in-tag'] !== false && !component) fail('CANDIDATE_COMPONENT_EVIDENCE_REQUIRED');
        const tag = new TagName(Version.parse(version), component, opts['tag-separator'], opts['include-v-in-tag']).toString();
        const nativeRef = initial ? null : await api('GET', `/repos/${request.repository}/git/ref/tags/${encodeURIComponent(tag)}`, undefined, true);
        let nativeTag = tags.find(t => t.name === tag);
        if (nativeRef) {
          if (nativeRef.ref !== `refs/tags/${tag}` || !validSha(nativeRef.object?.sha)) fail('CANDIDATE_TAG_DRIFT');
          nativeTag = {name:tag,commit:{sha:nativeRef.object.sha}};
        }
        if (!nativeTag) {
          // A failed prior version may have no tag: use its recorded reviewed S.
          const prior = state.cycles.map(record => record.value).find(cycle => cycle.units.some(u => u.id === unit.id && u.version === version));
          if (prior) {
            await git('merge-base', '--is-ancestor', prior.sourceSha, baseSha);
            boundaries.push({ path: unit.path, kind: 'baseline', sha: prior.sourceSha, reference: prior.id, found: true }); continue;
          }
          fail('CANDIDATE_RELEASE_BOUNDARY_REQUIRED');
        }
        await git('fetch', '--no-tags', '--no-recurse-submodules', request.remote, `refs/tags/${tag}`);
        const peeled = (await git('rev-parse', '--verify', 'FETCH_HEAD^{commit}')).toString().trim();
        const fetched = (await git('rev-parse', '--verify', 'FETCH_HEAD')).toString().trim();
        if ((nativeRef ? fetched : peeled) !== nativeTag.commit?.sha) fail('CANDIDATE_TAG_DRIFT');
        await git('update-ref', `refs/tags/${tag}`, peeled);
        if (!initial) {
          tags.push({name:tag,commit:{sha:peeled}});
          const release = await api('GET', `/repos/${request.repository}/releases/tags/${encodeURIComponent(tag)}`, undefined, true);
          if (release) { if (release.tag_name !== tag) fail('CANDIDATE_TAG_DRIFT'); releases.push(release); }
        }
        await git('merge-base', '--is-ancestor', peeled, baseSha);
        boundaries.push({ path: unit.path, kind: 'tag', sha: peeled, reference: tag, found: true });
      }
      const tagRules = (await pages('rulesets?includes_parents=true')).filter(r => r.target === 'tag' && r.enforcement === 'active');
      const protectedTags = [];
      for (const r of tagRules) { const detail = await native(`rulesets/${r.id}`); if (['deletion', 'non_fast_forward'].every(type => detail.rules?.some(rule => rule.type === type))) protectedTags.push(detail); }
      const tagPatterns = delivery.units.map(unit => {
        const opts = { ...settings, ...settings.packages?.[unit.path] }, component = opts['include-component-in-tag'] === false ? undefined : opts.component;
        if (opts['include-component-in-tag'] !== false && !component) fail('CANDIDATE_COMPONENT_EVIDENCE_REQUIRED');
        return 'refs/tags/' + new TagName(Version.parse('0.0.0'), component, opts['tag-separator'], opts['include-v-in-tag']).toString().replace('0.0.0', '*');
      });
      if (tagPatterns.some(pattern => !protectedTags.some(rule => !rule.conditions?.ref_name?.exclude?.length
        && rule.conditions.ref_name.include?.some(value => value === '~ALL' || value === 'refs/tags/*' || value === pattern)))) fail('CANDIDATE_TAG_PROTECTION_REQUIRED');
      const facts = { baseSha, defaultBranch: request.defaultBranch, config, manifest, commitCount: Number((await git('rev-list', '--count', baseSha)).toString().trim()),
        releases: releases.map(r => ({ id: r.id, tag: r.tag_name, sha: tags.find(t => t.name === r.tag_name)?.commit?.sha ?? '', bodyDigest: hash(r.body ?? ''), draft: r.draft })),
        tags: tags.map(t => ({ tag: t.name, sha: t.commit.sha })), boundaries, releaseInventoryComplete: true, protectionsEvidencePath: `generated/protections-${hash(JSON.stringify([rules, protectedTags]))}.json` };
      lastFacts = facts;
      lastProtections = { branch: rules, tags: protectedTags };
      return { baseSha, authors: delivery.repositoryAuthors, authorsDigest: hash(JSON.stringify(delivery.repositoryAuthors)) };
    };
    const prs = async branch => {
      const values = await pages(`pulls?state=all&base=${encodeURIComponent(request.defaultBranch)}&head=${encodeURIComponent(request.repository.split('/')[0] + ':' + branch)}`);
      const result = [];
      for (const pr of values) {
        if (pr.head?.repo?.id !== request.repositoryId || pr.head.ref !== branch || pr.base.ref !== request.defaultBranch) fail('CANDIDATE_PR_IDENTITY');
        // Closed PRs retain their reviewed head after the fixed branch advances.
        if (pr.state === 'open') { const head = await fetchBranch(branch); if (head && head !== pr.head.sha) fail('CANDIDATE_PR_HEAD_DRIFT'); }
        result.push({ number: pr.number, head: pr.head.sha, branch, base: pr.base.ref, state: pr.state, merged: Boolean(pr.merged_at),
          editing: pr.labels.some(l => l.name === 'release:editing'), body: pr.body ?? '' });
      }
      return result;
    };
    const existing = state.repository.candidate;
    const session = { repository: state.repository, ...await loadDocument(`generated/${existing?.id}/session.json`) ?? { generated: null, pending: null, identity: null, conflict: null, preview: null, adoption: null } };
    const sdk = language ?? copilotReleaseClient(controllerDirectory, copilotToken ?? '');
    const runtime = { workspace: request.directory, temporaryRoot: root, repository: request.repository, defaultBranch: request.defaultBranch, appBotId: request.appBotId, identity: request.identity, now, source,
      pullRequests: prs, branchHead: fetchBranch,
      legacyCandidate: async () => {
        const workflows = await native('actions/workflows?per_page=100');
        if (workflows.total_count > workflows.workflows.length) fail('CANDIDATE_WORKFLOW_INVENTORY_REQUIRED');
        if (workflows.workflows.some(w => /release-please/i.test(w.path + ' ' + w.name) && w.state === 'active')) fail('CANDIDATE_OLD_WRITER_ACTIVE');
        const old = (await pages(`pulls?state=open&base=${encodeURIComponent(request.defaultBranch)}`))
          .filter(p => p.head?.repo?.id === request.repositoryId && p.labels?.some(l => l.name === 'autorelease: pending'));
        if (old.length > 1) fail('CANDIDATE_MULTIPLE_PRS');
        return old[0] ? (await prs(old[0].head.ref)).find(p => p.number === old[0].number) : null;
      },
      generation: async B => {
        const frozen = structuredClone(lastFacts), directory = await mkdtemp(join(root, 'rp-'));
        if (generator) {
          const result = await generator({ repository: request.repository, facts: frozen, units: delivery.units.map(({ id, path }) => ({ id, path })) });
          await source();
          return JSON.stringify(frozen) === JSON.stringify(lastFacts) && lastFacts.baseSha === B ? result : { status: 'DRIFT' };
        }
        const child = spawn(process.execPath, [resolve(controllerDirectory, 'scripts/release-please-candidate.mjs')], { cwd: directory, windowsHide: true, timeout: 300_000,
          env: { ...isolatedBuildEnvironment(process.env, directory), STEWARD_CANDIDATE_READ_TOKEN: readToken }, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stderr.resume(); child.stdin.on('error', () => {}); let size = 0; const parts = [];
        child.stdout.on('data', bytes => { size += bytes.length; if (size > 64 * 1024 * 1024) child.kill(); else parts.push(bytes); });
        const code = await new Promise((done, reject) => { child.once('error', () => reject(new Error('CANDIDATE_GENERATION_UNAVAILABLE'))); child.once('close', done);
          child.stdin.end(JSON.stringify({ repository: request.repository, facts: frozen, units: delivery.units.map(({ id, path }) => ({ id, path })) })); });
        if (code !== 0 || size > 64 * 1024 * 1024) fail('CANDIDATE_GENERATION_UNAVAILABLE');
        const result = JSON.parse(Buffer.concat(parts).toString('utf8')); await source();
        return JSON.stringify(frozen) === JSON.stringify(lastFacts) && lastFacts.baseSha === B ? result : { status: 'DRIFT' };
      },
      content: async (candidate, snapshot) => {
        const path = `content/${candidate.id}/${candidate.contentGenerationDigest}/manifest.json`, cachePath = `content/${candidate.id}/cache.json`;
        const stored = await loadDocument(path), cacheIndex = await loadDocument(cachePath), cache = {};
        let work = null;
        for (const entry of cacheIndex?.entries ?? []) {
          const value = await loadDocument(entry.path); if (hash(JSON.stringify(value)) !== entry.digest || hash(JSON.stringify([value.inputDigest, value.configDigest])) !== entry.key) fail('CONTENT_CACHE_DIGEST');
          cache[entry.key] = value;
        }
        if (stored?.input.schemaVersion === 2) {
          work = { input: stored.input, payloads: {}, results: {}, evidence: await loadDocument(stored.evidencePath) };
          if (hash(JSON.stringify(work.evidence.manifests)) !== work.input.sourceManifestDigest) fail('CONTENT_SOURCE_MANIFEST_DIGEST');
          for (const batch of work.input.batches) {
            const payload = await loadDocument(stored.payloadPaths[batch.id]);
            if (payload.stage !== batch.stage || hash(JSON.stringify(payload)) !== batch.inputDigest) fail('CONTENT_PAYLOAD_DIGEST');
            work.payloads[batch.id] = payload;
            if (batch.status === 'READY') {
              const result = await loadDocument(batch.resultPath);
              if (result.stage !== batch.stage || JSON.stringify(result.sourceIds) !== JSON.stringify(batch.sourceIds)) fail('CONTENT_RESULT_IDENTITY');
              work.results[batch.id] = result.result;
            }
          }
        }
        let actors = [];
          const paths = new Set((await git('ls-tree', '-r', '--name-only', '-z', snapshot.baseSha)).toString('utf8').split('\0').filter(Boolean));
          const packageData = new Map(), names = new Map(), dependencies = {};
          for (const unit of delivery.units) {
            const path = (unit.path === '.' ? '' : unit.path + '/') + 'package.json';
            if (paths.has(path)) { const value = JSON.parse(await fileAt(snapshot.baseSha, path)); packageData.set(unit.id, value); if (value.name) names.set(value.name, unit.id); }
          }
          for (const [id, pkg] of packageData) dependencies[id] = [...new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).filter(name => names.has(name)).map(name => names.get(name)))];
        if (!work) {
          const collected = await collectContentInput({ directory: join(root, 'source'), candidateId: candidate.id, configDigest: snapshot.configDigest,
            repository: request.repository, preparedChanges: snapshot.files,
            units: snapshot.units.map(unit => { const b = lastFacts.boundaries.find(b => b.path === unit.path);
              const settings = JSON.parse(lastFacts.config), options = { ...settings, ...settings.packages[unit.path] };
              return { workspace: request.directory, changelogPath: options['changelog-path'] ?? 'CHANGELOG.md',
              identity: { repositoryId: request.repositoryId, defaultBranch: request.defaultBranch, targetSha: snapshot.baseSha, controllerSha }, unit,
              contextPaths: [...new Set(['README.md', '.github/delivery.json', (unit.path === '.' ? '' : unit.path + '/') + 'README.md', (unit.path === '.' ? '' : unit.path + '/') + 'package.json'])].filter(path => paths.has(path)),
              boundary: b.kind === 'full-tree' ? { kind: 'full-tree' } : { kind: b.kind, sha: b.sha, reference: b.reference, version: JSON.parse(lastFacts.manifest)[unit.path] } }; }) });
          work = await planContentBatches(collected.input, collected.sources, { manifests: collected.manifests, gaps: collected.gaps });
        }
        const save = async (work, cache) => {
          const results = [], payloadPaths = {}, evidencePath = path.replace(/manifest\.json$/, 'source-manifest.json');
          for (const batch of work.input.batches) {
            const payloadPath = path.replace(/manifest\.json$/, `batches/${batch.id}.json`); payloadPaths[batch.id] = payloadPath;
            results.push(...archive('content-payload', candidate.id, payloadPath, work.payloads[batch.id]));
          }
          for (const batch of work.input.batches.filter(b => b.status === 'READY')) {
            batch.resultPath = path.replace(/manifest\.json$/, `results/${batch.id}.json`);
            results.push(...archive('content-result', candidate.id, batch.resultPath, { stage: batch.stage, sourceIds: batch.sourceIds, result: work.results[batch.id] }));
          }
          const entries = [];
          for (const [key, entry] of Object.entries(cache)) {
            const entryPath = `content/${candidate.id}/cache/${key}.json`; entries.push({ key, path: entryPath, digest: hash(JSON.stringify(entry)) });
            results.push(...archive('cache-entry', candidate.id, entryPath, entry));
          }
          return persist([...archive('content', candidate.id, path, { input: work.input, payloadPaths, evidencePath }),
            ...archive('content-evidence', candidate.id, evidencePath, work.evidence), ...archive('cache', candidate.id, cachePath, { entries }), ...results]);
        };
        const result = await resumeContentBatches(work, cache, { now, editing: async () => (await prs(candidate.branch)).some(p => p.number === candidate.prNumber && p.editing), ...sdk, save });
        if (result.status !== 'READY') return { status: result.status === 'EDITING' ? 'EDITING' : result.status === 'FAILED' ? 'FAILED' : 'WAIT' };
        const unitActors = Object.fromEntries(snapshot.units.map(unit => [unit.id, []]));
        if (session.identity?.sourceDigest === snapshot.sourceDigest && session.identity.authorsDigest === hash(JSON.stringify(delivery.repositoryAuthors)))
          return { status: 'READY', files: assembleUnitNotes(work), actors: session.identity.actors,
            unitActors: Object.fromEntries(session.identity.units.map(unit => [unit.id, unit.actors])) };
        const commits = new Map();
        for (const manifest of work.evidence.manifests) for (const commit of manifest.commits) {
          if (!commits.has(commit.sha)) commits.set(commit.sha, []); commits.get(commit.sha).push(manifest.unit.id);
        }
        const users = new Map();
        for (const [id, intervalUnits] of commits) {
          const changed = (await git('diff-tree', '--root', '-m', '-r', '--name-only', '-z', '--no-commit-id', '--no-ext-diff', '--no-textconv', id)).toString('utf8').split('\0').filter(Boolean);
          const affected = new Set(changed.flatMap(path => releaseAffectedUnitIds(path, delivery.units, dependencies)));
          const units = intervalUnits.filter(id => affected.has(id));
          const commit = await native(`commits/${id}`); if (commit.sha !== id) fail('CANDIDATE_CONTRIBUTOR_COMMIT_IDENTITY');
          for (const actor of [commit.author, commit.committer]) {
            if (!actor) { actors.push(null); for (const id of units) unitActors[id].push(null); continue; }
            if (!users.has(actor.id)) {
              const user = await api('GET', `/users/${encodeURIComponent(actor.login)}`); if (user.id !== actor.id) fail('CANDIDATE_CONTRIBUTOR_IDENTITY');
              users.set(actor.id, { id: user.id, login: user.login, type: user.type, profileUrl: user.html_url, avatarUrl: user.avatar_url });
            }
            actors.push(users.get(actor.id)); for (const id of units) unitActors[id].push(users.get(actor.id));
          }
        }
        return { status: 'READY', files: assembleUnitNotes(work), actors, unitActors };
      },
      save: async session => {
        const { repository, ...data } = session, id = repository.candidate.id;
        const files = [{ path: 'state.json', content: JSON.stringify(repository, null, 2) + '\n' }, ...archive('session', id, `generated/${id}/session.json`, data)];
        if (lastFacts) files.push(...archive('native-input', id, lastFacts.protectionsEvidencePath, { facts: lastFacts, protections: lastProtections }));
        if (session.generated) files.push(...archive('generated', id, repository.candidate.generatedSnapshotPath, session.generated));
        if (session.adoption) files.push(...archive('adoption', id, `generated/${id}/adoption.json`, session.adoption));
        if (session.preview !== null) files.push({ path: `generated/${id}/preview.md`, content: session.preview });
        return persist(files);
      },
      isAncestor: async (a, b) => {
        // The proposed object may exist only in the durable write archive. The
        // complete fetched descendant history proves adoption or non-adoption;
        // a failed Git read must never be interpreted as absence.
        if (!validSha(a) || !validSha(b)) fail('CANDIDATE_ANCESTRY_IDENTITY');
        const history = (await git('rev-list', b)).toString().trim().split('\n');
        if (!history.length || history[0] !== b || !history.every(validSha)) fail('CANDIDATE_ANCESTRY_UNAVAILABLE');
        return history.includes(a);
      },
      push: async(branch, prepared) => {
        return pushPreparedCandidate(request.directory, request.remote, branch, prepared, token, root);
      },
      createPullRequest: data => api('POST', `/repos/${request.repository}/pulls`, { head: data.branch, base: data.base, title: data.title, body: data.body }),
      comments: async pr => (await pages(`issues/${pr}/comments`)).map(c => ({ id: c.id, authorId: c.user.id, body: c.body })),
      createComment: (pr, body) => api('POST', `/repos/${request.repository}/issues/${pr}/comments`, { body }),
      updateComment: (id, body) => api('PATCH', `/repos/${request.repository}/issues/comments/${id}`, { body }),
    };
    const candidateDocumentsAt=async(commit,id)=>{
      const entries=(await git('ls-tree','-r','-z',commit)).toString('utf8').split('\0').filter(Boolean),documents=[];
      for(const entry of entries) {
        const path=entry.slice(entry.indexOf('\t')+1);
        if(!path.startsWith('generated/')&&!path.startsWith('content/'))continue;
        const content=await fileAt(commit,path);
        let own=path.startsWith(`generated/${id}/`)||path.startsWith(`content/${id}/`);
        if(!own){try{own=JSON.parse(content).candidateId===id;}catch{}}
        if(own)documents.push({path,sha256:hash(content)});
      }
      return documents.sort((a,b)=>a.path.localeCompare(b.path));
    };
    const mergedSnapshot=async(candidate,data,stateCommit)=>{
      const pull=await native(`pulls/${candidate.prNumber}`);
      if(pull.merged!==true)return null;
        if (pull.number !== candidate.prNumber || pull.head?.repo?.id !== request.repositoryId || pull.base?.repo?.id !== request.repositoryId
          || pull.base.ref !== request.defaultBranch || pull.head.ref !== candidate.branch || !validSha(pull.merge_commit_sha)
          || !candidate.publishedHead || !data.identity || !data.generated || data.pending)return null;
        const sourceSha = pull.merge_commit_sha;
        const defaultSha = await fetchBranch(request.defaultBranch); await git('merge-base', '--is-ancestor', sourceSha, defaultSha);
        await git('fetch', '--no-tags', '--no-recurse-submodules', request.remote, pull.head.sha);
        await git('merge-base', '--is-ancestor', candidate.publishedHead, pull.head.sha);
        candidate = { ...candidate, publishedHead: pull.head.sha };
        data = { ...data, conflict: null };
        const sourceTree = (await git('rev-parse', `${sourceSha}^{tree}`)).toString().trim();
        const reviewedTree = (await git('rev-parse', `${pull.head.sha}^{tree}`)).toString().trim();
        const delivery = parseDeliveryConfig(JSON.parse(await fileAt(sourceSha, '.github/delivery.json')));
        const versions = JSON.parse(await fileAt(sourceSha, '.release-please-manifest.json'));
        for (const unit of delivery.units.filter(unit => data.generated.units.some(generated => generated.id === unit.id)))
          parseSupplementalNotes(await fileAt(sourceSha, unit.notesPath));
        if (data.identity.authorsDigest !== hash(JSON.stringify(delivery.repositoryAuthors))
          || data.generated.units.some(unit => versions[unit.path] !== unit.version)) fail('MERGED_CANDIDATE_INPUT_DRIFT');
        // The merged source fixes its execution controller, independently of this wake.
        const document = parseDocument(await fileAt(sourceSha, '.github/workflows/steward-release-publish.yml'), { uniqueKeys: true });
        if (document.errors.length) fail('CANDIDATE_CONTROLLER_PIN_INVALID');
        const workflow = document.toJS({ maxAliasCount: 0 }), jobs = workflow?.jobs;
        if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) fail('CANDIDATE_CONTROLLER_PIN_REQUIRED');
        const calls = Object.values(jobs).filter(job => typeof job?.uses === 'string'
          && job.uses.includes('/.github/workflows/product-release.yml@'));
        if (calls.length !== 1) fail('CANDIDATE_CONTROLLER_PIN_REQUIRED');
        const match = /^splrad\/steward\/\.github\/workflows\/product-release\.yml@([a-f0-9]{40})$/.exec(calls[0].uses);
        if (!match) fail('CANDIDATE_CONTROLLER_PIN_INVALID');
        const cycleControllerSha = match[1];
        const checkouts = Object.values(jobs).flatMap(job => Array.isArray(job?.steps) ? job.steps : [])
          .filter(step => step?.with?.path === 'controller' || step?.with?.repository === 'splrad/steward');
        if (!checkouts.length) fail('CANDIDATE_CONTROLLER_PIN_REQUIRED');
        if (checkouts.some(step => !/^actions\/checkout@[a-f0-9]{40}$/.test(step.uses ?? '')
          || step.with.repository !== 'splrad/steward' || step.with.ref !== cycleControllerSha)) fail('CANDIDATE_CONTROLLER_PIN_CONFLICT');
        const deliveryBlobSha = (await git('rev-parse', `${sourceSha}:.github/delivery.json`)).toString().trim();
        const cycle = mergedBuildCycle({ prNumber: pull.number, sourceSha, controllerSha:cycleControllerSha, sourceTree, reviewedTree, deliveryBlobSha, delivery, units: data.generated.units, repository:request.repository });
        const {repository:ignored,...archivedSession}=data;
        const documents=await candidateDocumentsAt(stateCommit,candidate.id);
        const mergedArchive = archive('merged-candidate', candidate.id, `generated/${candidate.id}/cycles/${cycle.id}.json`, {
          schemaVersion: 1, cycleId: cycle.id, sourceSha, stateCommit, candidate,
          session: archivedSession, pull: { number: pull.number, head: pull.head.sha, branch: pull.head.ref,
            base: pull.base.ref, repositoryId: request.repositoryId, mergedAt: pull.merged_at, mergeCommitSha: sourceSha }, documents,
        });
        // Validate the assembled snapshot before the atomic cycle handoff.
        await decodeCandidateDocument(mergedArchive.map(file => JSON.parse(file.content)));
        return {cycle,mergedArchive,sourceSha,defaultSha,delivery};
    };
    // Merged source precedes generation: its tag and Release need not exist yet.
    if(session.repository.candidate?.prNumber) {
      const value=await mergedSnapshot(session.repository.candidate,session,expectedHead);
      if(value) {
        const {cycle,mergedArchive,sourceSha,defaultSha}=value;
        if(!verifyHandoff)return {status:'WAIT',reason:'MERGED_CANDIDATE_VERIFICATION_REQUIRED'};
        const history=await verifyHandoff(cycle);
        const eligible=history?.result==='PASS';
        if(!eligible||history.inventoryComplete!==true||history.pendingHandoff!==cycle.id
          ||history.defaultHead!==defaultSha||history.stateHead!==expectedHead)
          return {status:'WAIT',reason:'MERGED_CANDIDATE_SOURCE_UNVERIFIED',history};
        if(await fetchBranch(request.defaultBranch)!==defaultSha||await fetchBranch('steward/release-state')!==expectedHead)
          return {status:'WAIT',reason:'MERGED_CANDIDATE_SOURCE_MOVED'};
        session.repository.activeCycleId = cycle.id; session.repository.candidate = null; session.repository.revision++; session.repository.lastProgressAt = now();
        const head = await persist([{ path: `cycles/${cycle.id}.json`, content: JSON.stringify(cycle, null, 2) + '\n' },
          { path: 'state.json', content: JSON.stringify(session.repository, null, 2) + '\n' }, ...mergedArchive]);
        return { status: 'CYCLE_READY', cycleId: cycle.id, sourceSha, stateHead: head };
      }
    }
    return await advanceReleaseCandidate(session, runtime);
  } finally { await rm(root, { recursive: true, force: true }); }
}
