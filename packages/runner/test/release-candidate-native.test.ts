import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
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
import { pipelineNotes } from '../src/release-pipeline.js';
import type { BuildPipelineRecord } from '../src/release-pipeline-record.js';

// This scenario includes many durable state commits and five independent wakes, including merged-source handoff.
// Individual production Git operations retain their existing 30/60/90 second bounds.
vi.setConfig({ testTimeout: process.platform === 'win32' ? 1_200_000 : 360_000 });
setLogger({ debug() {}, info() {}, warn() {}, error() {}, trace() {} });
vi.mock('../dist/index.js', async () => import('../src/index.js'));
const { nativeReleaseCandidate, mergedContributorIdentity } = await import(pathToFileURL(resolve('scripts/release-candidate.mjs')).href);
const { advanceEvent } = await import(pathToFileURL(resolve('scripts/release-cycle-event.mjs')).href);
const { releaseParticipation } = await import(pathToFileURL(resolve('scripts/release-coordinator.mjs')).href);
const { releasePolicyGuard } = await import(pathToFileURL(resolve('scripts/release-repository-policy.mjs')).href);

it('projects legacy web-flow cache at merge while preserving original actors and rejecting other drift', () => {
  const bot = {id:19864447, login:'web-flow', type:'User', profileUrl:'https://github.com/web-flow', avatarUrl:'https://avatars.githubusercontent.com/u/19864447?v=4'};
  const person = {id:45, login:'human', type:'User', profileUrl:'https://github.com/human', avatarUrl:'https://avatars.githubusercontent.com/u/45'};
  const contributor = ({id, login, profileUrl, avatarUrl}:typeof bot) => ({id, login, profileUrl, avatarUrl, alt:login});
  const scope = {actors:[bot, person, null], contributors:{contributors:[contributor(person),contributor(bot)], unresolved:1}};
  const frozen = {...scope, units:[{...scope, id:'app'}]};
  const authors = [{id:7, evidence:'verified repository author'}];
  const projected = mergedContributorIdentity(frozen,authors);
  expect(projected.contributors).toEqual({contributors:[contributor(person)], unresolved:1});
  expect(projected.units[0].contributors).toEqual(projected.contributors);
  expect(projected.actors).toBe(frozen.actors);
  expect(frozen.contributors.contributors).toHaveLength(2);
  expect(mergedContributorIdentity(projected,authors)).toEqual(projected);
  const corrupt = structuredClone(frozen);
  corrupt.units[0]!.contributors.unresolved++;
  expect(()=>mergedContributorIdentity(corrupt,authors)).toThrow('MERGED_CANDIDATE_CONTRIBUTOR_DRIFT');
});
const { readReleaseRecords,writeReleaseRecords,releaseCommand } = await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals();for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it.each(['old-source', 'new-source', 'missing-pin', 'conflicting-pin', 'content-recovery', 'pending-recovery', 'legacy-pending-cancel',
  'compact', 'compact-registered', 'conditional-organization', 'conditional-compact', 'conditional-tampered'])('runs the native candidate adapter through protected state, real Git, upstream generation, fake SDK and same-PR editing: %s', async pinCase => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-native-test-')); roots.push(root); registerOfflineFixtureRoot(root);
  const directory = join(root, 'source'), remote = join(root, 'remote.git'); await mkdir(directory);
  const env = isolatedBuildEnvironment(process.env, root), identity = { name: 'Fixture', email: 'fixture@example.invalid' };
  const git = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: directory, env, encoding: 'utf8', windowsHide: true })).stdout.trim();
  const conditional = pinCase.startsWith('conditional-');
  await git('init', '--initial-branch=main'); await git('config', 'user.name', identity.name); await git('config', 'user.email', identity.email);
  await mkdir(join(directory, '.github'));
  await mkdir(join(directory,'.github/workflows'));
  const compactRegistered=pinCase==='compact-registered'||pinCase==='conditional-compact';
  const compact=pinCase==='compact'||compactRegistered;
  if(compactRegistered)await writeFile(join(directory,'.github/steward-central-policy'),'central\n');
  const explicitWorkflow=pinCase==='new-source'?'.github/workflows/fixture-release.yaml':undefined;
  const buildWorkflow=explicitWorkflow??'.github/workflows/steward-release-publish.yml';
  const notesPath=compact?(conditional?'docs/release-current.md':'.release-notes/root.md'):'.release-notes/app.md';
  for(const path of (compact?[buildWorkflow]:[buildWorkflow,'.github/workflows/steward-release-channels.yml','.github/release-template.md.mustache']))
    if(pinCase!=='old-source'||!path.endsWith('release-template.md.mustache'))
    await writeFile(join(directory,path),'# offline adopted source\n');
  const sourceControllerSha = (pinCase === 'new-source' ? 'f' : 'e').repeat(40);
  const publisherMatrix=explicitWorkflow?'    strategy:\n      matrix:\n        include:\n          - {unit: app, target: fixture}\n':'';
  if (pinCase !== 'missing-pin') await writeFile(join(directory,buildWorkflow),
    `jobs:\n  build:\n${publisherMatrix}    steps:\n      - uses: actions/checkout@${'a'.repeat(40)}\n        with:\n          repository: splrad/steward\n          path: controller\n          ref: ${pinCase === 'conflicting-pin' ? 'b'.repeat(40) : sourceControllerSha}\n  sign:\n    uses: splrad/steward/.github/workflows/product-release.yml@${sourceControllerSha}\n`);
  if(compact)await writeFile(join(directory,buildWorkflow),JSON.stringify({'run-name':'打包 ${{ inputs.operation_key }}',
    on:{workflow_dispatch:{inputs:Object.fromEntries(['cycle_id','operation_key','source_sha','controller_sha'].map(key=>[key,{required:true,type:'string'}]))}},
    jobs:{package:{name:'delivery/root',steps:[
      {uses:'actions/checkout@'+'a'.repeat(40),with:{repository:'splrad/steward',path:'controller',ref:sourceControllerSha}},
      {id:'upload-github-release',name:'Upload GitHub release delivery',uses:'actions/upload-artifact@'+'a'.repeat(40),
        with:{name:'delivery-github-release-${{ github.repository_id }}-root-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',path:'app.zip'}},
    ]}}}));
  const config = { 'separate-pull-requests': false, 'include-component-in-tag': false, packages: { '.': { 'release-type': 'simple', 'version-file': 'VERSION' } } };
  const repositoryAuthors=[{id:7,evidence:'offline explicit authorship record'}];
  const registeredChannels=explicitWorkflow?[{id:'github-release',required:true,location:'github',artifactIds:['app'],metadata:[]}]:[];
  const delivery=compact?{schemaVersion:3,...(conditional?{notes:{'.':notesPath}}:{repositoryAuthors})}:{schemaVersion:explicitWorkflow?2:1,buildWorkflow:explicitWorkflow,
    repositoryAuthors,units:[{id:'app',path:'.',notesPath:'.release-notes/app.md',
      assets:[{id:'app',name:'app-${version}.zip',mediaType:'application/zip'}],channels:registeredChannels}]};
  for (const [path, text] of Object.entries({ 'README.md': '# 应用\n\n公开使用说明。\n', 'VERSION': '0.0.0\n', 'release-please-config.json': JSON.stringify(config),
    '.release-please-manifest.json': '{".":"0.0.0"}', '.github/delivery.json': JSON.stringify(delivery), 'code.txt': '功能实现\n' })) await writeFile(join(directory, path), text);
  if (conditional) {
    await writeFile(join(directory, '.github/release-template.md.mustache'), compact ? 'Product override is ignored in schema v3.\n'
      : (await readFile('templates/repository/.github/release-template.md.mustache','utf8')).replace('width="48"',pinCase==='conditional-tampered'?'width="12"':'width="48"'));
    await writeFile(join(directory, '.github/release-contributors.json'), JSON.stringify([7, 42, 44, 45, 46, 19864447].map(id => ({ id, evidence: 'Offline confirmation fixture' }))));
  }
  await git('add', '.'); await git('commit', '--signoff', '-m', 'feat: initial product');
  const commitAuthors = new Map<string, number>();
  if (conditional) {
    commitAuthors.set(await git('rev-parse', 'HEAD'), 42);
    for (const author of [7, 42, 43, 44, 46, 47, 19864447]) {
      await writeFile(join(directory, 'code.txt'), `改动 ${author}\n`);
      await git('add', 'code.txt'); await git('commit', '--signoff', '-m', 'fix: adjust product behavior');
      commitAuthors.set(await git('rev-parse', 'HEAD'), author);
    }
  }
  const B = await git('rev-parse', 'HEAD');
  const actor = (id: number) => {
    const login = ({7:'author',42:'contributor',43:'service',44:'owner',45:'committer-only',46:'robot[bot]',47:'unknown',19864447:'web-flow'} as Record<number,string>)[id]!;
    return { id, login, type: id === 46 ? 'Bot' : 'User', html_url: 'https://github.com/' + login, avatar_url: `https://avatars.githubusercontent.com/u/${id}` };
  };
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
  let interruptPending = pinCase === 'pending-recovery' || pinCase === 'legacy-pending-cancel';
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', path = decodeURIComponent(url.pathname), body = init?.body ? JSON.parse(String(init.body)) : null;
    if (interruptPending && method === 'GET' && path.endsWith('/pulls')) {
      const durable = JSON.parse(await git('-C', remote, 'show', 'refs/heads/steward/release-state:state.json'));
      if (durable.candidate?.pendingWrite) throw Error('FIXTURE_PENDING_INTERRUPTION');
    }
    requests.push({ method, path, body }); expect(url.origin).toBe('https://api.github.com'); let value: any;
    if (method === 'GET' && (path.includes('/git/ref/heads/') || path.endsWith('/pulls')))
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-read');
    if(path==='/repos/fixture/product')value={id:1,full_name:'fixture/product',default_branch:'main',archived:false,disabled:false};
    else if(compact&&path.includes('/git/trees/')) {
      const lines=(await git('ls-tree','-r','-z',path.split('/').at(-1)!)).split('\0').filter(Boolean);
      value={truncated:false,tree:lines.map(line=>{const [,mode,type,sha,path]=/^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(line)!;return {mode,type,sha,path};})};
    }
    else if(compact&&path.endsWith('/git/matching-refs/heads/steward/release-state')) {
      value=[{ref:'refs/heads/steward/release-state',object:{type:'commit',sha:await head('steward/release-state')}}];
    }
    else if((compact||path.startsWith('/repos/splrad/steward/'))&&path.includes('/contents/')) {
      const file=path.split('/contents/')[1]!,ref=url.searchParams.get('ref');
      if(path.startsWith('/repos/splrad/steward/'))expect(pinCase==='old-source'?[sourceControllerSha,'f'.repeat(40)]:[sourceControllerSha]).toContain(ref);
      const bytes=path.startsWith('/repos/splrad/steward/')
        ?await readFile(conditional?file:'packages/core/test/fixtures/release-template-compact.mustache')
        :Buffer.from(await git('show',ref+':'+file));
      const fileSha=path.startsWith('/repos/splrad/steward/')?createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')
        :await git('rev-parse',ref+':'+file);
      const contents=path.startsWith('/repos/splrad/steward/')?bytes
        :(await promisify(execFile)('git',['cat-file','blob',fileSha],{cwd:directory,env,encoding:'buffer',windowsHide:true})).stdout;
      value={type:'file',path:file,encoding:'base64',size:contents.length,sha:fileSha,content:contents.toString('base64')};
    }
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
        head: { repo: { id: 1 }, ref: body.head, sha: await head(body.head) }, base: { ref: 'main', repo: { id: 1,full_name:'fixture/product' } }, state: 'open', merged:false, merged_at: null, labels: [], title: body.title, body: body.body };
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
    else if (/\/commits\/[a-f0-9]{40}$/.test(path)) {
      const sha=path.split('/').at(-1)!;
      value={sha,author:actor(commitAuthors.get(sha)??42),committer:actor(conditional?45:7)};
    }
    else if (path.startsWith('/users/')) {
      value=[7,42,43,44,45,46,47,19864447].map(actor).find(person=>path==='/users/'+person.login);
      expect(value).toBeDefined();
    }
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
    expect(Boolean(input.conditional)).toBe(conditional);
    return { text: JSON.stringify({paragraphs:[{sourceIds:[input.sources[0].id],section:conditional?'fixed':'changes',
      textZh:conditional?'**启动修复**。本次修复了已核实的启动错误。':'本次提供功能实现及使用资料。',qualification:'SOURCE_CONFIRMED'}]}),model:'offline-fixture',usage:{inputTokens:100,outputTokens:50}};
  } };
  const request = { directory, writeDirectory: join(root, 'writes'), remote, repository: 'fixture/product', repositoryId: 1, defaultBranch: 'main', appBotId: 301115370, identity };
  await mkdir(request.writeDirectory);
  let compactPolicyReads=0;
  const sourcePolicy=explicitWorkflow||compact?releasePolicyGuard({},request,async()=>{
    if(compactRegistered) {
      compactPolicyReads++;
      return {adoption:'central',policy:{repositoryId:1,repository:request.repository,release:null}};
    }
    return {adoption:'legacy',policy:null};
  }):undefined;
  const options = { token: 'fixture-write', readToken: 'fixture-read', controllerSha: 'f'.repeat(40), fetcher, generator, language, temporaryRoot: root,
    checkRepositoryPolicy:sourcePolicy,now: () => '2026-10-27T00:00:00Z' };
  if(pinCase==='conditional-tampered') {
    await expect(nativeReleaseCandidate(request,options)).rejects.toThrow('CANDIDATE_ORGANIZATION_TEMPLATE');
    expect(modelCalls).toBe(0);
    return;
  }
  if(compact) {
    const transport={request:async(method:'GET'|'POST',path:string)=>{
      const response=await fetcher('https://api.github.com'+path,{method,headers:{authorization:'Bearer fixture-read'}});
      return {status:response.status,headers:response.headers,bytes:new Uint8Array(await response.arrayBuffer())};
    }};
    expect(await releaseParticipation({id:1,full_name:request.repository,default_branch:request.defaultBranch},transport,{includeUnits:true}))
      .toEqual({status:'APPLICABLE',sourceSha:B,units:[{id:'root',path:'.',notesPath}]});
  }
  const pausedPolicy=releasePolicyGuard({},request,async()=>({adoption:'paused',policy:null}));
  const registered=(channels:typeof registeredChannels)=>({adoption:'central',policy:{
    repositoryId:1,repository:request.repository,release:{buildWorkflow:'.github/workflows/steward-release-publish.yml',units:[{id:'app',channels}]},
  }});
  if(explicitWorkflow||compactRegistered) {
    const state=await head('steward/release-state'),start=requests.length;
    await expect(nativeReleaseCandidate(request,{...options,checkRepositoryPolicy:pausedPolicy})).rejects.toThrow('CANDIDATE_REPOSITORY_POLICY_DISABLED');
    expect(requests.slice(start).every(request=>request.method==='GET')).toBe(true);
    expect(modelCalls).toBe(0);expect(pr).toBeNull();expect(await head('steward/release-state')).toBe(state);
  }
  if(pinCase==='old-source') {
    const originalState=await head('steward/release-state');
    await expect(nativeReleaseCandidate(request,{...options,expectedSourceSha:'0'.repeat(40)})).rejects.toThrow('CANDIDATE_EVENT_SOURCE_CHANGED');
    const beforeAdmission=requests.length;
    const result=await nativeReleaseCandidate(request,{...options,checkRepositoryPolicy:async (read:(path:string)=>Promise<string>)=>{
      expect(JSON.parse(await read('.github/delivery.json'))).toEqual(delivery);
      throw Error('CANDIDATE_REPOSITORY_POLICY_MOVED');
    }});
    expect(result).toEqual({status:'WAIT',reason:'CANDIDATE_REPOSITORY_POLICY_MOVED'});
    expect(requests.slice(beforeAdmission).every(request=>request.method==='GET')).toBe(true);
    expect(modelCalls).toBe(0);expect(pr).toBeNull();expect(await head('steward/release-state')).toBe(originalState);
  }
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
  if (interruptPending) {
    await expect(nativeReleaseCandidate(request, options)).rejects.toThrow();
    await refresh();
    const state = JSON.parse(await git('show', 'steward/release-state:state.json'));
    const archived = JSON.parse(await git('show', `steward/release-state:generated/${state.candidate.id}/session.json`));
    const session = await decodeCandidateDocument([archived]);
    expect(session.pending.write.proposedCommit).toBe(state.candidate.pendingWrite.proposedCommit);
    expect(session.pending.previousIdentity).toBeNull();
    expect(await head('steward/release-candidate')).toBeNull();
    for (const previous of [undefined, session.identity, false, { units: [] }]) {
      const copy = structuredClone(session);
      if (previous === undefined) delete copy.pending.previousIdentity;
      else copy.pending.previousIdentity = previous;
      const content = JSON.stringify(copy);
      const read = decodeCandidateDocument([{ ...archived, content, documentDigest: createHash('sha256').update(content).digest('hex') }]);
      if (previous === undefined || previous === session.identity) await expect(read).resolves.toEqual(copy);
      else await expect(read).rejects.toThrow();
    }
    interruptPending = false;
    if (pinCase === 'legacy-pending-cancel') {
      const path = `generated/${state.candidate.id}/session.json`;
      delete session.pending.previousIdentity;
      const content = JSON.stringify(session);
      const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
      const updated = JSON.stringify({ ...archived, content, documentDigest: hashText(content) }) + '\n';
      const previous = (await git('show', `steward/release-state:${path}`)) + '\n';
      const written = await writeReleaseRecords({ directory: join(root, 'legacy-state'), remote, repositoryId: 1,
        defaultBranch: 'main', targetRef: 'steward/release-state', writer: 'release', expectedHead: await head('steward/release-state'),
        allowedPaths: [path], changes: [{ path, content: updated, sha256: hashText(updated), previousSha256: hashText(previous) }], identity });
      expect(written.status).toBe('APPLIED');
      await git('commit', '--allow-empty', '-m', 'fix: new default source');
      await git('push', '--porcelain', remote, 'HEAD:refs/heads/main');
      await refresh();
      expect(await nativeReleaseCandidate({ ...request, writeDirectory: join(root, 'cancel-writes') }, options))
        .toMatchObject({ status: 'WAIT', reason: 'REPLAN' });
      await refresh();
      const cancelled = await decodeCandidateDocument([JSON.parse(await git('show', `steward/release-state:${path}`))]);
      expect(cancelled.pending).toBeNull(); expect(cancelled.identity).toBeNull();
      expect(await head('steward/release-candidate')).toBeNull();
      return;
    }
    const callsBeforeRestart = modelCalls;
    expect(await nativeReleaseCandidate({ ...request, writeDirectory: join(root, 'restart-writes') }, options))
      .toMatchObject({ status: 'READY', prNumber: 9 });
    expect(await head('steward/release-candidate')).toBe(state.candidate.pendingWrite.proposedCommit);
    expect(modelCalls).toBe(callsBeforeRestart);
    return;
  }
  expect(await nativeReleaseCandidate(request, options)).toMatchObject({ status: 'READY', prNumber: 9 });
  const firstHead = await head('steward/release-candidate'), firstCalls = modelCalls; expect(firstCalls).toBeGreaterThan(0); await refresh();
  const identityCalls = requests.filter(r => /\/commits\/|\/users\//.test(r.path)).length;
  expect(comments[0].body).toContain('github.com&#x2F;contributor');
  expect(comments[0].body.includes('github.com&#x2F;author')).toBe(conditional);
  if (conditional) {
    expect(comments[0].body).toContain('### 🐛 错误修复');
    expect(comments[0].body).toContain('width="48"');
    expect(comments[0].body.split('github.com&#x2F;contributor')).toHaveLength(2);
    expect(comments[0].body).toContain('github.com&#x2F;owner');
    expect(comments[0].body).not.toMatch(/committer-only|web-flow|&#x2F;robot|&#x2F;service|&#x2F;unknown|文档更新/);
  }
  pr.title = '人工修改标题'; pr.body = '人工修改正文'; pr.labels = [{ name: 'release:editing' }];
  expect(await nativeReleaseCandidate({ ...request, writeDirectory: join(root, 'edit-writes') }, options)).toMatchObject({ reason: 'EDITING', head: firstHead });
  expect(modelCalls).toBe(firstCalls); expect(await head('steward/release-candidate')).toBe(firstHead); await refresh();
  const state = await readReleaseRecords({ directory, targetRef: 'steward/release-state', repositoryId: 1 });
  expect(state.repository.candidate.editingAckHead).toBeUndefined(); expect(state.repository.candidate.prNumber).toBe(9);
  await git('fetch', '--no-tags', '--no-recurse-submodules', remote, 'refs/heads/steward/release-candidate');
  await git('switch', '-c', 'reviewed-notes', 'FETCH_HEAD');
  const publishedVersion=JSON.parse(await git('show','HEAD:.release-please-manifest.json'))['.'];
  const checksumUrl=`https://github.com/${request.repository}/releases/download/v${publishedVersion}/SHA256SUMS`;
  let reviewedNotes = (await git('show', 'HEAD:'+notesPath))
    .replace(conditional ? '已核实的启动错误' : '## 概述', conditional ? '人工审核确认的启动错误' : '## 概述\n\n人工审核说明。')
    .trimEnd();
  if(conditional&&!compact)reviewedNotes+=`\n\n## 获取与使用\n\n**校验附件**。下载[校验和](<${checksumUrl}>)。\n`;
  reviewedNotes=reviewedNotes.replace(/\n/g, '\r\n') + '\r\n';
  await writeFile(join(directory,notesPath),reviewedNotes);
  await git('add','--',notesPath);await git('commit','--signoff','-m','docs: review candidate notes');
  const humanHead = await git('rev-parse', 'HEAD'); await git('push', '--porcelain', remote, 'HEAD:refs/heads/steward/release-candidate');
  pr.head.sha = humanHead; await git('switch', 'main');
  pr.labels = []; pr.state = 'closed';
  expect(await nativeReleaseCandidate({ ...request, writeDirectory: join(root, 'closed-writes') }, options)).toMatchObject({ reason: 'CLOSED_PR' });
  pr.state = 'open';
  expect(await nativeReleaseCandidate({ ...request, writeDirectory: join(root, 'reopened-writes') }, options)).toMatchObject({ status: 'CONFLICT', reason: 'HUMAN_EDIT_CONFLICT' });
  expect(await head('steward/release-candidate')).toBe(humanHead); expect(modelCalls).toBe(firstCalls);
  expect(await git('show',humanHead+':'+notesPath)).toBe(reviewedNotes.trim());
  expect(requests.filter(r => /\/commits\/|\/users\//.test(r.path))).toHaveLength(identityCalls);
  expect(pr.title).toBe('人工修改标题'); expect(pr.body).toBe('人工修改正文');
  expect(requests.filter(r => r.method === 'POST' && r.path.endsWith('/pulls'))).toHaveLength(1);
  expect(requests.filter(r => r.method === 'PATCH').every(r => r.path.endsWith('/issues/comments/1'))).toBe(true);
  if (conditional) {
    const producer={repositoryId:1296724484,runId:42,attempt:1,controllerSha:options.controllerSha,requestKey:'f'.repeat(64)};
    expect(await nativeReleaseCandidate({...request,writeDirectory:join(root,'manual-writes')},{...options,manualCandidateProducer:producer}))
      .toMatchObject({status:'READY',reason:'MANUAL_VALIDATED',head:humanHead});
    await refresh();
    const updated=await readReleaseRecords({directory,targetRef:'steward/release-state',repositoryId:1});
    const archived=await decodeCandidateDocument(updated.domainRecords.filter((entry:any)=>entry.value.documentKind==='session').map((entry:any)=>entry.value));
    expect(archived.manualValidation.projection.preview).toContain('人工审核确认的启动错误');
    expect(archived.manualValidation.projection.preview).toContain('width="48"');
    expect(await head('steward/release-candidate')).toBe(humanHead);
  }
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
  if(explicitWorkflow) {
    const before=await head('steward/release-state'),start=requests.length;
    await expect(releaseCommand('candidate',{...request,cycleId:null,runId:null,writeDirectory:join(root,'paused-handoff')},
      {token:options.token,candidateReadToken:options.readToken,controllerSha:options.controllerSha,now:options.now,io,
        candidateRuntime:{checkRepositoryPolicy:pausedPolicy}})).rejects.toThrow('CANDIDATE_REPOSITORY_POLICY_DISABLED');
    expect(requests.slice(start).every(request=>request.method==='GET')).toBe(true);
    expect(await head('steward/release-state')).toBe(before);expect(modelCalls).toBe(firstCalls);
    const conflictingPolicy=releasePolicyGuard({},request,async()=>registered(registeredChannels.map(channel=>({...channel,artifactIds:['other']}))));
    await expect(releaseCommand('candidate',{...request,cycleId:null,runId:null,writeDirectory:join(root,'conflicting-handoff')},
      {token:options.token,candidateReadToken:options.readToken,controllerSha:options.controllerSha,now:options.now,io,
        candidateRuntime:{checkRepositoryPolicy:conflictingPolicy}})).rejects.toThrow('CANDIDATE_REPOSITORY_POLICY_CONFLICT');
    expect(requests.slice(start).every(request=>request.method==='GET')).toBe(true);
    expect(await head('steward/release-state')).toBe(before);expect(modelCalls).toBe(firstCalls);
  }
  if(pinCase==='old-source') {
    const before=await head('steward/release-state');
    await expect(releaseCommand('candidate',{...request,cycleId:null,runId:null,writeDirectory:join(root,'denied-handoff')},{
      token:options.token,candidateReadToken:options.readToken,controllerSha:options.controllerSha,now:options.now,io,
      candidateRuntime:{checkRepositoryPolicy:async (read:(path:string)=>Promise<string>)=>{
        expect(JSON.parse(await read('.github/delivery.json'))).toEqual(delivery);
        throw Error('CANDIDATE_REPOSITORY_POLICY_DISABLED');
      }}
    })).rejects.toThrow('CANDIDATE_REPOSITORY_POLICY_DISABLED');
    const beforeAdmission=requests.length;
    const result=await advanceEvent({kind:'push',repositoryId:1,sourceSha:S},{
      registry:[{id:1,name:request.repository,defaultBranch:request.defaultBranch}],
      snapshot:async()=>({head:before,cycles:[]}),
      get:async(path:string)=>{
        expect(path).toBe('git/ref/heads/main');
        return {object:{sha:await head('main')}};
      },
      candidate:async(expectedSourceSha:string,expectedStateSha:string)=>releaseCommand('candidate',{
        ...request,cycleId:null,runId:null,writeDirectory:join(root,'moved-handoff'),
      },{
        token:options.token,candidateReadToken:options.readToken,controllerSha:options.controllerSha,now:options.now,io,
        candidateRuntime:{expectedSourceSha,expectedStateSha,checkRepositoryPolicy:async(read:(path:string)=>Promise<string>)=>{
          expect(JSON.parse(await read('.github/delivery.json'))).toEqual(delivery);
          throw Error('CANDIDATE_REPOSITORY_POLICY_MOVED');
        }}
      }),
      invoke:vi.fn(()=>{throw Error('UNEXPECTED_BUILD_DISPATCH');}),
    });
    expect(result).toEqual({status:'WAIT',reason:'CANDIDATE_REPOSITORY_POLICY_MOVED'});
    expect(requests.slice(beforeAdmission).every(request=>request.method==='GET')).toBe(true);
    expect(await head('steward/release-state')).toBe(before);
    expect(modelCalls).toBe(firstCalls);
  }
  if(compactRegistered) {
    const before=await head('steward/release-state'),start=requests.length;
    await expect(releaseCommand('candidate',{...request,cycleId:null,runId:null,writeDirectory:join(root,'paused-compact-handoff')},
      {token:options.token,candidateReadToken:options.readToken,controllerSha:options.controllerSha,now:options.now,io,
        candidateRuntime:{checkRepositoryPolicy:pausedPolicy}})).rejects.toThrow('CANDIDATE_REPOSITORY_POLICY_DISABLED');
    expect(requests.slice(start).every(request=>request.method==='GET')).toBe(true);
    expect(await head('steward/release-state')).toBe(before);expect(modelCalls).toBe(firstCalls);
  }
  const compactReadsBeforeHandoff=compactPolicyReads;
  let adoptedReads=0;
  const adoptedPolicy=explicitWorkflow?releasePolicyGuard({},request,async()=>{
    adoptedReads++;
    return registered(registeredChannels);
  }):compact?sourcePolicy:undefined;
  const handed=await releaseCommand('candidate',{...request,cycleId:null,runId:null,writeDirectory:join(root,'merge-writes')},
    {token:options.token,candidateReadToken:options.readToken,controllerSha:options.controllerSha,now:options.now,io,
      candidateRuntime:{checkRepositoryPolicy:adoptedPolicy}});
  expect(handed).toMatchObject({ status: 'CYCLE_READY', sourceSha: S, cycleId: `pr-9-${S}` });
  if(explicitWorkflow)expect(adoptedReads).toBe(2);
  if(compactRegistered) {
    expect(compactReadsBeforeHandoff).toBeGreaterThan(0);
    expect(compactPolicyReads).toBeGreaterThan(compactReadsBeforeHandoff);
  }
  expect(modelCalls).toBe(firstCalls); await refresh();
  const merged = await readReleaseRecords({ directory, targetRef: 'steward/release-state', repositoryId: 1 });
  expect(merged.repository.activeCycleId).toBe(`pr-9-${S}`);
  expect(merged.cycles[0].value.controllerSha).toBe(sourceControllerSha);
  expect(merged.cycles[0].value.buildWorkflow).toBe(compact?buildWorkflow:explicitWorkflow);
  expect(merged.repository.releaseAdoption).toEqual(repository.releaseAdoption);
  expect(merged.cycles[0].value.units[0]).toMatchObject({ releaseId: null, manifestDigest: null });
  const chunks = merged.domainRecords.filter((record: any) => record.value.documentKind === 'merged-candidate').map((record: any) => record.value);
  const archive = await decodeCandidateDocument(chunks);
  expect(archive).toMatchObject({ cycleId: `pr-9-${S}`, sourceSha: S, candidate: expect.objectContaining({prNumber:9,publishedHead:pr.head.sha}),
    pull: { number: 9, head: pr.head.sha, mergeCommitSha: S }, session: { pending: null, conflict: null } });
  expect(archive.documents.some((file: any) => file.path.endsWith('/session.json'))).toBe(true);
  if (conditional) expect(archive.session.identity).toMatchObject({noteTemplate:expect.stringContaining('{{#hasContributors}}'),
    contributors:{contributors:[7,42,44].map(id=>expect.objectContaining({id}))},units:[{notesPath}]});
  if (conditional && !compact) {
    const { tag, version } = merged.cycles[0].value.units[0];
    const contributors = archive.session.identity.units[0].contributors.contributors;
    const templateBytes = await readFile('templates/repository/.github/release-template.md.mustache');
    const build: BuildPipelineRecord = { schemaVersion: 1, kind: 'build', repositoryId: request.repositoryId,
      fullName: request.repository, sourceSha: S, controllerSha: sourceControllerSha,
      delivery: { schemaVersion: 1, units: delivery.units!, repositoryAuthors: [] }, noteFormat: 'conditional',
      cycleId: merged.cycles[0].value.id, requestKey: 'a'.repeat(64), buildRef: 'refs/heads/steward/build/fixture',
      runId: 10, runAttempt: 1, toolLocks: {}, deliverySha256: 'b'.repeat(64),
      templateSha256: createHash('sha256').update(templateBytes).digest('hex'),
      units: [{ id: 'app', tag, version, packageVersion: version, builds: [],
        assets: [{ id: 'app', name: `app-${version}.zip`, build: 'fixture' }], contributors }],
    };
    const frozen = await pipelineNotes(build, 'app', directory);
    expect(frozen).toContain('人工审核确认的启动错误');
    expect(frozen).toContain('## 版本记录');
    expect(frozen).toContain(`/blob/${S}/CHANGELOG.md`);
    expect(frozen).toContain('width="48"');
    expect(frozen).toContain(checksumUrl);
    build.delivery.units[0]!.channels=[{id:'github-release',required:true,location:'github',metadata:[]}];
    await expect(pipelineNotes(build, 'app', directory)).rejects.toThrow('acquisition link');
    expect(frozen).not.toMatch(/committer-only|web-flow|&#x2F;robot|&#x2F;service|&#x2F;unknown/);
  }
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
