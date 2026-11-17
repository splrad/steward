import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {isolatedBuildEnvironment} from '../src/build-environment.js';
import {registerOfflineFixtureRoot} from './offline-fixtures.js';
import {releaseProtectionFixture} from './fixtures/release-protection.js';
vi.setConfig({testTimeout:300000});
vi.mock('../dist/index.js',async()=>import('../src/index.js'));
const load=(path:string)=>import(pathToFileURL(resolve(path)).href);
it('native manual normal freeze and observer project use real Git, preserve G and never call generation',async()=>{
  const {fixture}=await load('scripts/test/manual-candidate-fixture.mjs'),f=fixture();
  const {nativeReleaseCandidate}=await load('scripts/release-candidate.mjs');
  const {readReleaseRecords}=await load('scripts/release-record.mjs');
  const {decodeCandidateDocument,candidateObservationIdentity}=await import('../src/index.js');
  const root=await mkdtemp(join(tmpdir(),'manual-native-test-'));registerOfflineFixtureRoot(root);
  try {
    const directory=join(root,'source'),remote=join(root,'remote.git');await mkdir(directory);
    const env=isolatedBuildEnvironment(process.env,root),identity={name:'Fixture',email:'fixture@example.invalid'};
    const git=async(...args:string[])=>(await promisify(execFile)('git',args,{cwd:directory,env,encoding:'utf8',windowsHide:true})).stdout.trim();
    await git('init','--initial-branch=main');await git('config','user.name',identity.name);await git('config','user.email',identity.email);
    for(const [path,text] of Object.entries(f.files)){await mkdir(join(directory,path,'..'),{recursive:true});await writeFile(join(directory,path),String(text));}
    await git('add','.');await git('commit','-m','initial actual product');const G=await git('rev-parse','HEAD');
    await writeFile(join(directory,'source.txt'),'current source');await git('add','.');await git('commit','-m','current source');const S=await git('rev-parse','HEAD');
    await git('switch','-c',f.session.repository.candidate.branch);await writeFile(join(directory,'.release-notes/layerscape.md'),f.files['.release-notes/layerscape.md']+'\n人工补充。\n');
    await git('add','.');await git('commit','-m','manual candidate');const H=await git('rev-parse','HEAD');
    f.pull.head.sha=H;f.session.generated.baseSha=G;
    const c=f.session.repository.candidate;Object.assign(c,{baseSha:G,publishedHead:G,generatedSnapshotPath:`generated/${c.id}/${c.id}.json`,contentGenerationDigest:c.id,adoptionOverride:null,observedLabelEventIds:[]});
    Object.assign(f.session.repository,{schemaVersion:3,releaseAdoption:{sourceSha:G,prNumber:1},defaultBranch:'main',lastObservedDefaultSha:S,lastCompletedCycleId:null,nextCheckAt:null,lastProgressAt:null,lastErrorCode:null});
    const originalGenerated=JSON.stringify(f.session.generated),originalNotes=await git('show',`${H}:.release-notes/layerscape.md`);
    await git('init','--bare',remote);await git('push','--porcelain',remote,`HEAD:refs/heads/${c.branch}`);await git('switch','main');await git('push','--porcelain',remote,'HEAD:refs/heads/main');
    await git('switch','--orphan','steward/release-state');
    const {repository,...data}=f.session;
    const archive=(kind:string,value:any)=>{const content=JSON.stringify(value);return JSON.stringify({schemaVersion:1,repositoryId:1187527897,candidateId:c.id,documentKind:kind,documentDigest:createHash('sha256').update(content).digest('hex'),index:0,count:1,content});};
    await mkdir(join(directory,'generated',c.id),{recursive:true});await writeFile(join(directory,'state.json'),JSON.stringify(repository));
    await writeFile(join(directory,'generated',c.id,'session.json'),archive('session',data));await writeFile(join(directory,c.generatedSnapshotPath),archive('generated',data.generated));
    await git('add','.');await git('commit','-m','protected initial candidate');await git('push','--porcelain',remote,'HEAD:refs/heads/steward/release-state');
    const head=async(branch:string)=>git('-C',remote,'rev-parse',`refs/heads/${branch}`),comments=[{id:11,user:{id:301115370},body:f.comments[0].body}],writes:string[]=[];
    const fetcher:typeof fetch=async(input,init)=>{
      const url=new URL(String(input)),path=decodeURIComponent(url.pathname),method=init?.method??'GET';let value:any;
      expect(url.origin).toBe('https://api.github.com');
      if(path.includes('/git/ref/heads/'))value={object:{type:'commit',sha:await head(path.split('/git/ref/heads/')[1]!)} };
      else if(path.endsWith('/pulls/192'))value=f.pull;
      else if(releaseProtectionFixture(path))value=releaseProtectionFixture(path);
      else if(path.endsWith('/issues/192/comments')&&method==='GET')value=comments;
      else if(path.endsWith('/issues/comments/11')&&method==='PATCH'){writes.push('comment');comments[0]!.body=JSON.parse(String(init?.body)).body;value=comments[0];}
      else throw Error('UNEXPECTED_NATIVE_CALL '+method+' '+path);
      return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
    };
    const request={directory,remote,writeDirectory:join(root,'writes'),repository:'splrad/LayerScape',repositoryId:1187527897,defaultBranch:'main',appBotId:301115370,identity};
    const options={token:'fixture-write',readToken:'fixture-read',controllerSha:f.producer.controllerSha,manualCandidateProducer:f.producer,expectedSourceSha:S,fetcher,temporaryRoot:root,
      generator:()=>{throw Error('GENERATOR_FORBIDDEN');},language:{preflight:()=>{throw Error('MODEL_FORBIDDEN');},call:()=>{throw Error('MODEL_FORBIDDEN');}}};
    const normal=await nativeReleaseCandidate(request,{...options,expectedStateSha:await head('steward/release-state')});expect(normal.reason).toBe('MANUAL_VALIDATED');expect(writes).toEqual([]);
    const read=async()=>{await git('fetch','--no-tags','--no-recurse-submodules',remote,'refs/heads/steward/release-state');await git('update-ref','refs/heads/steward/release-state',await git('rev-parse','FETCH_HEAD'));
      const state=await readReleaseRecords({directory,targetRef:'steward/release-state',repositoryId:1187527897});
      const data=await decodeCandidateDocument(state.domainRecords.filter((r:any)=>r.value.documentKind==='session').map((r:any)=>r.value));return {repository:state.repository,...data};};
    let session=await read();const observation=candidateObservationIdentity(session),frozenState=await head('steward/release-state');
    const observeOptions={...options,manualCandidateProducer:undefined,expectedStateSha:frozenState,observation};
    const {resultOutcome}=await load('scripts/bounded-release-entry.mjs');
    f.pull.labels=[{name:'release:editing'}];
    const paused=await nativeReleaseCandidate(request,observeOptions);expect(paused.reason).toBe('EDITING');expect(resultOutcome(paused)).toBe('paused');
    f.pull.labels=[];f.pull.state='closed';
    const closed=await nativeReleaseCandidate(request,observeOptions);expect(closed.reason).toBe('CLOSED_PR');expect(resultOutcome(closed)).toBe('source_changed');
    f.pull.merged=true;f.pull.merge_commit_sha=H;
    const merged=await nativeReleaseCandidate(request,observeOptions);expect(merged.reason).toBe('MERGED_SOURCE_HANDOFF');expect(resultOutcome(merged)).toBe('source_changed');
    expect(await head('steward/release-state')).toBe(frozenState);expect(writes).toEqual([]);
    f.pull.merged=false;f.pull.state='open';delete f.pull.merge_commit_sha;
    const projected=await nativeReleaseCandidate(request,observeOptions);
    expect(projected.reason).toBe('MANUAL_PROJECTION');expect(writes).toEqual(['comment']);session=await read();
    const completed=await head('steward/release-state');
    const replay=await nativeReleaseCandidate(request,{...options,manualCandidateProducer:{...f.producer,runId:43},expectedStateSha:completed});
    expect(replay.reason).toBe('MANUAL_VALIDATED');expect(await head('steward/release-state')).toBe(completed);expect(writes).toEqual(['comment']);
    expect(JSON.stringify(session.generated)).toBe(originalGenerated);expect(session.repository.candidate.baseSha).toBe(G);expect(session.repository.candidate.publishedHead).toBe(G);
    expect(await git('show',`${H}:.release-notes/layerscape.md`)).toBe(originalNotes);expect(await head(c.branch)).toBe(H);expect(session.manualValidation.producer.runId).toBe(42);
    expect(session.preview).toBe(session.manualValidation.projection.preview);expect(session.repository.activeCycleId).toBeNull();
    const newController='a'.repeat(40),newProducer={...f.producer,runId:44,controllerSha:newController};
    const revalidated=await nativeReleaseCandidate(request,{...options,controllerSha:newController,manualCandidateProducer:newProducer,expectedStateSha:completed});
    expect(revalidated.reason).toBe('MANUAL_VALIDATED');
    const observedAgain=await nativeReleaseCandidate(request,{...options,controllerSha:newController,manualCandidateProducer:undefined,expectedStateSha:completed,observation});
    expect(observedAgain.reason).toBe('MANUAL_PROJECTION');expect(await head('steward/release-state')).toBe(completed);expect(writes).toEqual(['comment']);
    session=await read();expect(session.manualValidation.producer).toEqual(f.producer);expect(candidateObservationIdentity(session)).toEqual(observation);

  } finally {await rm(root,{recursive:true,force:true});}
});
