import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { registerOfflineFixtureRoot } from './offline-fixtures.js';
import { isolatedBuildEnvironment } from '../src/build-environment.js';
import { generateCandidate } from '../src/release-candidate-update.js';
import { decodeCandidateDocument } from '../../core/src/release-candidate-record.js';
import { GitHub } from 'release-please/build/src/github.js';
import { FileNotFoundError } from 'release-please/build/src/errors/index.js';
import { setLogger } from 'release-please/build/src/util/logger.js';
import { releaseProtectionFixture } from './fixtures/release-protection.js';
import { createHash } from 'node:crypto';
import { CONTENT_OUTPUT_SCHEMA } from '../../core/src/release-content.js';

// This scenario includes many durable state commits and five independent wakes, including merged-source handoff.
// Individual production Git operations retain their existing 30/60/90 second bounds.
vi.setConfig({ testTimeout: process.platform === 'win32' ? 1_200_000 : 360_000 });
setLogger({ debug() {}, info() {}, warn() {}, error() {}, trace() {} });
vi.mock('../dist/index.js', async () => import('../src/index.js'));
const { nativeReleaseCandidate } = await import(pathToFileURL(resolve('scripts/release-candidate.mjs')).href);
const { readReleaseRecords,releaseCommand } = await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals();for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it.each(['old-source', 'new-source', 'missing-pin', 'conflicting-pin', 'content-recovery'])('runs the native candidate adapter through protected state, real Git, upstream generation, fake SDK and same-PR editing: %s', async pinCase => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-native-test-')); roots.push(root); registerOfflineFixtureRoot(root);
  const directory = join(root, 'source'), remote = join(root, 'remote.git'); await mkdir(directory);
  const env = isolatedBuildEnvironment(process.env, root), identity = { name: 'Fixture', email: 'fixture@example.invalid' };
  const git = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: directory, env, encoding: 'utf8', windowsHide: true })).stdout.trim();
  await git('init', '--initial-branch=main'); await git('config', 'user.name', identity.name); await git('config', 'user.email', identity.email);
  await mkdir(join(directory, '.github'));
  await mkdir(join(directory,'.github/workflows'));
  for(const path of ['.github/workflows/steward-release-publish.yml','.github/workflows/steward-release-channels.yml','.github/release-template.md.mustache'])
    await writeFile(join(directory,path),'# offline adopted source\n');
  const sourceControllerSha = (pinCase === 'new-source' ? 'f' : 'e').repeat(40);
  if (pinCase !== 'missing-pin') await writeFile(join(directory,'.github/workflows/steward-release-publish.yml'),
    `jobs:\n  build:\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)}\n        with:\n          repository: splrad/steward\n          path: controller\n          ref: ${pinCase === 'conflicting-pin' ? 'b'.repeat(40) : sourceControllerSha}\n  sign:\n    uses: splrad/steward/.github/workflows/product-release.yml@${sourceControllerSha}\n`);
  const config = { 'separate-pull-requests': false, 'include-component-in-tag': false, packages: { '.': { 'release-type': 'simple', 'version-file': 'VERSION' } } };
  const delivery = { schemaVersion: 1, units: [{ id: 'app', path: '.', notesPath: '.release-notes/app.md',
    assets: [{ id: 'app', name: 'app-${version}.zip', mediaType: 'application/zip' }], channels: [] }], repositoryAuthors: [{ id: 7, evidence: 'offline explicit authorship record' }] };
  for (const [path, text] of Object.entries({ 'README.md': '# 应用\n\n公开使用说明。\n', 'VERSION': '0.0.0\n', 'release-please-config.json': JSON.stringify(config),
    '.release-please-manifest.json': '{".":"0.0.0"}', '.github/delivery.json': JSON.stringify(delivery), 'code.txt': '功能实现\n' })) await writeFile(join(directory, path), text);
  await git('add', '.'); await git('commit', '--signoff', '-m', 'feat: initial product'); const B = await git('rev-parse', 'HEAD');
  await git('init', '--bare', remote); await git('push', '--porcelain', remote, 'HEAD:refs/heads/main');
  await git('switch', '--orphan', 'steward/release-state');
  const repository = { schemaVersion: 3, releaseAdoption:{sourceSha:B,prNumber:1}, repositoryId: 1, defaultBranch: 'main', revision: 0, lastObservedDefaultSha: B, lastCompletedCycleId: null,
    activeCycleId: null, candidate: null, nextCheckAt: null, lastProgressAt: null, lastErrorCode: null };
  await writeFile(join(directory, 'state.json'), JSON.stringify(repository) + '\n'); await git('add', '--', 'state.json'); await git('commit', '--signoff', '-m', 'Initial state');
  await git('push', '--porcelain', remote, 'HEAD:refs/heads/steward/release-state'); await git('switch', 'main');
  const requests: { method: string; path: string; body: any }[] = [], comments: any[] = [], pulls: any[] = [];
  const merges=new Map<number,{sha:string;at:string}>();
  let pr: any = null, modelCalls = 0;
  let policySha='e'.repeat(40);
  const head = async (branch: string) => { try { return await git('-C', remote, 'rev-parse', '--verify', `refs/heads/${branch}`); } catch { return null; } };
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', path = decodeURIComponent(url.pathname), body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, path, body }); expect(url.origin).toBe('https://api.github.com'); let value: any;
    if (method === 'GET' && (path.includes('/git/ref/heads/') || path.endsWith('/pulls')))
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-read');
    if(path==='/repos/fixture/product')value={id:1,full_name:'fixture/product',default_branch:'main',archived:false,disabled:false};
    else if(path.endsWith('/commits/main'))value={sha:await head('main')};
    else if(path.endsWith('/pulls/1'))value={number:1,merged:true,merge_commit_sha:B,base:{ref:'main',repo:{id:1}},head:{repo:{id:1}}};
    else if(path.endsWith('/collaborators/axiomoth/permission'))value={user:{id:7,login:'axiomoth'}};
    else if (path.includes('/git/ref/heads/')) { const branch = path.split('/git/ref/heads/')[1]!, sha = await head(branch); if (!sha) return new Response('{}', { status: 404 }); value = { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } }; }
    else if (path.endsWith('/rules/branches/main')) value = [{ type: 'non_fast_forward' }, { type: 'deletion' },
      ...(pinCase==='content-recovery'?[{type:'workflows',parameters:{workflows:[{repository_id:1296724484,path:'.github/workflows/pr-validation-native.yml',sha:policySha}]}}]:[])];
    else if (releaseProtectionFixture(path)) value = releaseProtectionFixture(path);
    else if (path.endsWith('/rulesets/6')) value = { id: 6, target: 'tag', enforcement: 'active', conditions: { ref_name: { include: ['~ALL'], exclude: [] } }, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] };
    else if (path.endsWith('/rulesets')) value = [{ id: 6, target: 'tag', enforcement: 'active' }];
    else if (path.endsWith('/releases') || path.endsWith('/tags')) value = [];
    else if (path.endsWith('/actions/workflows')) {
      // Private workflow inventory needs Actions read, held only by the trusted parent credential.
      if (new Headers(init?.headers).get('authorization') !== 'Bearer fixture-write')
        return new Response('{}', { status: 403 });
      value = { total_count: 0, workflows: [] };
    }
    else if (path.endsWith('/pulls') && method === 'POST') {
      const number=9+pulls.length;
      pr = { id:number,number,user:{id:301115370},url:`https://api.github.com/repos/fixture/product/pulls/${number}`,
        head: { repo: { id: 1 }, ref: body.head, sha: await head(body.head) }, base: { ref: 'main', repo: { id: 1,full_name:'fixture/product' } }, state: 'open', merged_at: null, labels: [], title: body.title, body: body.body };
      pulls.push(pr);
      throw new Error('accepted create response lost');
    } else if (path.endsWith('/pulls')) {
      for(const pull of pulls)if(pull.state==='open')pull.head.sha=await head(pull.head.ref);
      const commit=/\/commits\/([a-f0-9]{40})\/pulls$/.exec(path);
      value=pulls.filter(pull=>(!commit||merges.get(pull.number)?.sha===commit[1])
        &&(!url.searchParams.has('state')||url.searchParams.get('state')==='all'||pull.state===url.searchParams.get('state')));
    }
    else if (path.includes('/git/ref/tags/') || path.includes('/releases/tags/')) return new Response('{}',{status:404});
    else if (/\/pulls\/[0-9]+$/.test(path)) value = pulls.find(pull=>pull.number===Number(path.split('/').at(-1)));
    else if (/\/issues\/[0-9]+\/events$/.test(path)) {
      const number=Number(path.split('/').at(-2)),merge=merges.get(number),id=number+3;
      value=[...(merge?[{id,event:'merged',url:`https://api.github.com/repos/fixture/product/issues/events/${id}`,
        commit_id:merge.sha,commit_url:`https://api.github.com/repos/fixture/product/commits/${merge.sha}`,actor:{id:7},created_at:merge.at}]:[])];
    }
    else if (/\/git\/blobs\/[a-f0-9]{40}$/.test(path)) value={encoding:'base64',content:(await promisify(execFile)('git',
      ['cat-file','blob',path.split('/').at(-1)!],{cwd:directory,env,encoding:'buffer',windowsHide:true})).stdout.toString('base64')};
    else if (/\/commits\/[a-f0-9]{40}$/.test(path)) value = { sha: path.split('/').at(-1), author: { id: 42, login: 'contributor' }, committer: { id: 7, login: 'author' } };
    else if (path.startsWith('/users/')) { const login = path.split('/').at(-1)!; value = { id: login === 'author' ? 7 : 42, login, type: 'User', html_url: `https://github.com/${login}`, avatar_url: `https://avatars.githubusercontent.com/u/${login === 'author' ? 7 : 42}` }; }
    else if (/\/issues\/[0-9]+\/comments$/.test(path) && method === 'GET') value = comments.filter(comment=>comment.issue===Number(path.split('/').at(-2)));
    else if (/\/issues\/[0-9]+\/comments$/.test(path) && method === 'POST') { value = { id: comments.length+1,issue:Number(path.split('/').at(-2)),user: { id: 301115370 }, body: body.body }; comments.push(value); }
    else if (/\/issues\/comments\/[0-9]+$/.test(path) && method === 'PATCH') { value=comments.find(comment=>comment.id===Number(path.split('/').at(-1)));value.body=body.body; }
    else throw new Error('Unregistered native candidate fixture: ' + method + ' ' + path);
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const generator = async (request: any) => {
    const base=request.facts.baseSha;
    const client = Object.assign(Object.create(GitHub.prototype), {
      repository: { owner: 'fixture', repo: 'product', defaultBranch: 'main' }, logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} },
      getFileJson: async (path: string) => JSON.parse(await git('show', `${base}:${path}`)),
      getFileContentsOnBranch: async (path: string) => { let content; try { content = await git('show', `${base}:${path}`); } catch { throw new FileNotFoundError(path); }
        return { content: Buffer.from(content).toString('base64'), parsedContent: content, sha: 'b'.repeat(40), mode: '100644' }; },
      mergeCommitIterator: async function* () {
        for(const sha of (await git('rev-list',base)).split('\n'))yield {sha,message:await git('show','-s','--format=%B',sha),files:['code.txt']};
      },
      releaseIterator: async function* () {}, tagIterator: async function* () {}, pullRequestIterator: async function* () {},
    });
    return generateCandidate(base, { configPath: 'release-please-config.json', manifestPath: '.release-please-manifest.json', units: request.units, readFacts: async () => request.facts, createReadClient: async () => client });
  };
  const language = { preflight: async () => 'READY', call: async (text: string) => {
    modelCalls++; const input = JSON.parse(text);
    return { text: JSON.stringify({paragraphs:[{sourceIds:[input.sources[0].id],section:'changes',textZh:'本次提供功能实现及使用资料。',qualification:'SOURCE_CONFIRMED'}]}),model:'offline-fixture',usage:{inputTokens:100,outputTokens:50}};
  } };
  const request = { directory, writeDirectory: join(root, 'writes'), remote, repository: 'fixture/product', repositoryId: 1, defaultBranch: 'main', appBotId: 301115370, identity };
  await mkdir(request.writeDirectory);
  const options = { token: 'fixture-write', readToken: 'fixture-read', controllerSha: 'f'.repeat(40), fetcher, generator, language, temporaryRoot: root, now: () => '2026-10-27T00:00:00Z' };
  const refresh = async () => { await git('fetch', '--no-tags', '--no-recurse-submodules', remote, 'refs/heads/steward/release-state'); await git('update-ref', 'refs/heads/steward/release-state', await git('rev-parse', 'FETCH_HEAD')); };
  if(pinCase==='content-recovery') {
    const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
    const rejected={...language,call:async()=>{modelCalls++;return {text:'{"bad":"字段"}',model:'offline',usage:null};}};
    expect(await nativeReleaseCandidate(request,{...options,controllerSha:policySha,language:rejected})).toMatchObject({status:'WAIT',reason:'CONTENT_FAILED'});
    await refresh();const failed=await readReleaseRecords({directory,targetRef:'steward/release-state',repositoryId:1});
    const candidate=failed.repository.candidate,rootPath=`content/${candidate.id}/${candidate.contentGenerationDigest}/`,manifestPath=rootPath+'manifest.json';
    const original=await git('show',`steward/release-state:${manifestPath}`),manifest=await decodeCandidateDocument([JSON.parse(original)]);
    const protectionPath=(await git('ls-tree','-r','--name-only','steward/release-state')).split('\n').find(p=>p.startsWith('generated/protections-'))!;
    const grant={candidateId:candidate.id,batchId:manifest.input.batches[0].id,previousAttemptSha256:hash(manifest.input.batches[0].attempts[0]),authorizationId:hash('approved'),outputContractSha256:hash(CONTENT_OUTPUT_SCHEMA),archiveContentDigest:candidate.contentGenerationDigest,archiveProtectionDigest:protectionPath.slice('generated/protections-'.length,-5)};
    policySha=options.controllerSha;
    expect(await nativeReleaseCandidate({...request,writeDirectory:join(root,'recovery-writes')},{...options,contentRecovery:grant})).toMatchObject({status:'READY',prNumber:9});
    expect(modelCalls).toBe(2);await refresh();expect(await git('show',`steward/release-state:${manifestPath}`)).toBe(original);
    const recovered=await readReleaseRecords({directory,targetRef:'steward/release-state',repositoryId:1});
    expect(recovered.repository.candidate.contentGenerationDigest).not.toBe(candidate.contentGenerationDigest);
    const nextPath=`content/${candidate.id}/${recovered.repository.candidate.contentGenerationDigest}/manifest.json`;
    const next=await decodeCandidateDocument([JSON.parse(await git('show',`steward/release-state:${nextPath}`))]);
    expect(next.input.batches[0].attempts.map((a:{ordinal:number})=>a.ordinal)).toEqual([1,2]);expect(next.input.batches[0].attempts[0]).toEqual(manifest.input.batches[0].attempts[0]);
    expect(next.input.batches[0].attempts[1].recovery.archiveContentDigest).toBe(candidate.contentGenerationDigest);
    await expect(nativeReleaseCandidate({...request,writeDirectory:join(root,'duplicate-recovery-writes')},{...options,contentRecovery:grant})).rejects.toThrow('CONTENT_RECOVERY_ARCHIVE_EXISTS');
    expect(modelCalls).toBe(2);return;
  }
  expect(await nativeReleaseCandidate(request, options)).toMatchObject({ status: 'READY', prNumber: 9 });
  const firstHead = await head('steward/release-candidate'), firstCalls = modelCalls; expect(firstCalls).toBeGreaterThan(0); await refresh();
  const identityCalls = requests.filter(r => /\/commits\/|\/users\//.test(r.path)).length;
  expect(comments[0].body).toContain('github.com&#x2F;contributor'); expect(comments[0].body).not.toContain('github.com&#x2F;author');
  pr.title = '人工修改标题'; pr.body = '人工修改正文'; pr.labels = [{ name: 'release:editing' }];
  expect(await nativeReleaseCandidate({ ...request, writeDirectory: join(root, 'edit-writes') }, options)).toMatchObject({ reason: 'EDITING', head: firstHead });
  expect(modelCalls).toBe(firstCalls); expect(await head('steward/release-candidate')).toBe(firstHead); await refresh();
  const state = await readReleaseRecords({ directory, targetRef: 'steward/release-state', repositoryId: 1 });
  expect(state.repository.candidate.editingAckHead).toBeUndefined(); expect(state.repository.candidate.prNumber).toBe(9);
  await git('fetch', '--no-tags', '--no-recurse-submodules', remote, 'refs/heads/steward/release-candidate');
  await git('switch', '-c', 'reviewed-notes', 'FETCH_HEAD');
  const reviewedNotes = (await git('show', 'HEAD:.release-notes/app.md')).replace('## 概述', '## 概述\n\n人工审核说明。').replace(/\n/g, '\r\n') + '\r\n';
  await writeFile(join(directory, '.release-notes/app.md'), reviewedNotes);
  await git('add', '--', '.release-notes/app.md'); await git('commit', '--signoff', '-m', 'docs: review candidate notes');
  const humanHead = await git('rev-parse', 'HEAD'); await git('push', '--porcelain', remote, 'HEAD:refs/heads/steward/release-candidate');
  pr.head.sha = humanHead; await git('switch', 'main');
  pr.labels = []; pr.state = 'closed';
  expect(await nativeReleaseCandidate({ ...request, writeDirectory: join(root, 'closed-writes') }, options)).toMatchObject({ reason: 'CLOSED_PR' });
  pr.state = 'open';
  expect(await nativeReleaseCandidate({ ...request, writeDirectory: join(root, 'reopened-writes') }, options)).toMatchObject({ status: 'CONFLICT', reason: 'HUMAN_EDIT_CONFLICT' });
  expect(await head('steward/release-candidate')).toBe(humanHead); expect(modelCalls).toBe(firstCalls);
  expect(await git('show', `${humanHead}:.release-notes/app.md`)).toBe(reviewedNotes.trim());
  expect(requests.filter(r => /\/commits\/|\/users\//.test(r.path))).toHaveLength(identityCalls);
  expect(pr.title).toBe('人工修改标题'); expect(pr.body).toBe('人工修改正文');
  expect(requests.filter(r => r.method === 'POST' && r.path.endsWith('/pulls'))).toHaveLength(1);
  expect(requests.filter(r => r.method === 'PATCH').every(r => r.path.endsWith('/issues/comments/1'))).toBe(true);
  await refresh();
  await git('fetch', '--no-tags', '--no-recurse-submodules', remote, 'refs/heads/steward/release-candidate');
  await git('merge', '--ff-only', 'FETCH_HEAD'); await git('push', '--porcelain', remote, 'HEAD:refs/heads/main');
  const S = await git('rev-parse', 'HEAD'); pr.state = 'closed'; pr.merged = true; pr.merged_at = '2026-10-27T00:00:00Z';
  merges.set(9,{sha:S,at:'2026-10-27T00:00:01Z'});
  pr.url = 'https://api.github.com/repos/fixture/product/pulls/9'; pr.base.repo.full_name = 'fixture/product';
  const readsBeforeMerge = requests.length;
  // Exercise the actual command: a newly merged S has no cycle record yet.
  // Its source must be verified without asking that new cycle to be complete.
  vi.stubGlobal('fetch',fetcher);
  const io={request:async(method:'GET'|'POST',path:string)=>{
    const response=await fetcher('https://api.github.com'+path,{method,headers:{authorization:'Bearer fixture-read'}});
    return {status:response.status,headers:response.headers,bytes:new Uint8Array(await response.arrayBuffer())};
  }};
  if (pinCase === 'missing-pin' || pinCase === 'conflicting-pin') {
    const before = await head('steward/release-state');
    await expect(releaseCommand('candidate',{...request,cycleId:null,runId:null,writeDirectory:join(root,'rejected-merge-writes')},
      {token:options.token,candidateReadToken:options.readToken,controllerSha:options.controllerSha,now:options.now,io}))
      .rejects.toThrow(pinCase === 'missing-pin' ? 'CANDIDATE_CONTROLLER_PIN_REQUIRED' : 'CANDIDATE_CONTROLLER_PIN_CONFLICT');
    expect(await head('steward/release-state')).toBe(before);expect(modelCalls).toBe(firstCalls);
    return;
  }
  const handed=await releaseCommand('candidate',{...request,cycleId:null,runId:null,writeDirectory:join(root,'merge-writes')},
    {token:options.token,candidateReadToken:options.readToken,controllerSha:options.controllerSha,now:options.now,io});
  expect(handed).toMatchObject({ status: 'CYCLE_READY', sourceSha: S, cycleId: `pr-9-${S}` });
  expect(modelCalls).toBe(firstCalls); await refresh();
  const merged = await readReleaseRecords({ directory, targetRef: 'steward/release-state', repositoryId: 1 });
  expect(merged.repository.activeCycleId).toBe(`pr-9-${S}`);
  expect(merged.cycles[0].value.controllerSha).toBe(sourceControllerSha);
  expect(merged.repository.releaseAdoption).toEqual(repository.releaseAdoption);
  expect(merged.cycles[0].value.units[0]).toMatchObject({ releaseId: null, manifestDigest: null });
  const chunks = merged.domainRecords.filter((record: any) => record.value.documentKind === 'merged-candidate').map((record: any) => record.value);
  const archive = await decodeCandidateDocument(chunks);
  expect(archive).toMatchObject({ cycleId: `pr-9-${S}`, sourceSha: S, candidate: expect.objectContaining({prNumber:9,publishedHead:pr.head.sha}),
    pull: { number: 9, head: pr.head.sha, mergeCommitSha: S }, session: { pending: null, conflict: null } });
  expect(archive.documents.some((file: any) => file.path.endsWith('/session.json'))).toBe(true);
  const tree = (await promisify(execFile)('git', ['ls-tree', '-r', '-z', archive.stateCommit], { cwd: directory, env, encoding: 'utf8', windowsHide: true })).stdout;
  const blobs = new Map(tree.split('\0').filter(Boolean).map(entry => {
    const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(entry)!;
    return [match[2]!, match[1]!] as const;
  }));
  for (const file of archive.documents) {
    const bytes = (await promisify(execFile)('git', ['cat-file', 'blob', blobs.get(file.path)!], { cwd: directory, env, encoding: 'buffer', windowsHide: true })).stdout;
    expect((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
  }
  const changed = structuredClone(chunks), body = JSON.parse(changed[0].content);
  body.candidate.publishedHead = '1'.repeat(40); changed[0].content = JSON.stringify(body);
  changed[0].documentDigest = (await import('node:crypto')).createHash('sha256').update(changed[0].content).digest('hex');
  await expect(decodeCandidateDocument(changed)).rejects.toThrow('MERGED_CANDIDATE_IDENTITY');
  expect(requests.slice(readsBeforeMerge).some(r => r.method !== 'GET' || /\/(?:releases|tags)$/.test(r.path))).toBe(false);

  expect(merged.repository.candidate).toBeNull();
  // A subsequent normal candidate is allowed while the previous cycle still exists.
  await writeFile(join(directory,'code.txt'),'修正后继版本。\n');await git('add','code.txt');
  await git('commit','--signoff','-m','fix: next release');await git('push','--porcelain',remote,'HEAD:refs/heads/main');
  const next=await nativeReleaseCandidate({...request,writeDirectory:join(root,'next-candidate')},options);
  expect(next,JSON.stringify(next)).toMatchObject({status:'READY',prNumber:10});await refresh();
  const nextState=await readReleaseRecords({directory,targetRef:'steward/release-state',repositoryId:1});
  expect(nextState.cycles[0].value).toEqual(merged.cycles[0].value);
  expect(nextState.repository.candidate.prNumber).toBe(10);
  const nextGenerated=await decodeCandidateDocument(nextState.domainRecords.filter((record:any)=>record.value.documentKind==='generated'&&record.value.candidateId===nextState.repository.candidate.id).map((record:any)=>record.value));
  expect(nextGenerated.units[0].version).toBe('1.0.1');
  expect(requests.slice(readsBeforeMerge).some(r=>/\/(?:releases|tags)$/.test(r.path))).toBe(false);
  expect(nextState.domainRecords.some((record:any)=>record.value.documentKind==='repair-decision')).toBe(false);
});
