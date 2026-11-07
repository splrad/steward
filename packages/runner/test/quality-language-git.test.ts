import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { registerOfflineFixtureRoot } from './offline-fixtures.js';
import { reconcileQualitySources } from '../../core/src/quality-language-summary.js';
import { isolatedBuildEnvironment } from '../src/build-environment.js';

it('actual Git persists quality intent/results, preserves another PR, rejects foreign paths and recovers deleted cache from history',async()=>{
  const {writeReleaseRecords,readReleaseRecords}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
  const root=await mkdtemp(join(tmpdir(),'quality-git-fixture-'));registerOfflineFixtureRoot(root);
  try {
    const remote=join(root,'remote'),profile=join(root,'profile');await mkdir(remote);await mkdir(profile);
    const environment=isolatedBuildEnvironment(process.env,profile),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
    const git=async(cwd:string,...args:string[])=>(await promisify(execFile)('git',args,{cwd,env:environment,encoding:'utf8',windowsHide:true})).stdout.trim();
    await git(remote,'init','--initial-branch=main');await git(remote,'config','user.name','Fixture');await git(remote,'config','user.email','fixture@example.invalid');
    await writeFile(join(remote,'README.md'),'fixture\n');await git(remote,'add','README.md');await git(remote,'commit','--signoff','-m','Fixture source');
    const source=await git(remote,'rev-parse','HEAD'),context={repositoryId:12,pullRequestNumber:1,head:source,configVersion:'v1',observedAt:'2026-10-28T00:00:00Z'};
    const cache=await reconcileQualitySources(null,context,[{sourceCommentId:'review:1',sourceCommit:source,sourceUrl:'https://github.com/test/product/pull/1',
      severity:'原文未说明',bodyMarkdown:'Check input.',updatedAt:context.observedAt}]);
    const first=JSON.stringify(cache,null,2)+'\n',identity={name:'Fixture',email:'fixture@example.invalid'};
    const request=(name:string,expectedHead:string|null,changes:any[])=>({directory:join(root,name),remote,repositoryId:12,defaultBranch:'main',targetRef:'steward/governance-state',writer:'quality',expectedHead,
      allowedPaths:changes.map(c=>c.path),changes,identity});
    const record=(path:string,content:string,previousSha256:string|null=null)=>({path,content,sha256:sha(content),previousSha256});
    const one=await writeReleaseRecords(request('writer-1',null,[record('quality/1.json',first)]));expect(one.status).toBe('APPLIED');
    const other=await reconcileQualitySources(null,{...context,pullRequestNumber:2},[]),twoText=JSON.stringify(other,null,2)+'\n';
    const two=await writeReleaseRecords(request('writer-2',one.head,[record('quality/2.json',twoText)]));expect(two.status).toBe('APPLIED');
    const entry=Object.values(cache.entries)[0]!;entry.attempts.push({startedAt:context.observedAt,status:'UNKNOWN',model:null,usage:null});
    entry.nextCheckAt='2026-10-28T00:01:00Z';entry.errorCode='RESPONSE_UNKNOWN';const intent=JSON.stringify(cache,null,2)+'\n';
    const three=await writeReleaseRecords(request('writer-3',one.head,[record('quality/1.json',intent,sha(first))]));expect(three.status).toBe('APPLIED');
    const snapshot=await readReleaseRecords({directory:remote,targetRef:'steward/governance-state',repositoryId:12});
    expect(snapshot.domainRecords.find((r:any)=>r.path==='quality/2.json').content).toBe(twoText);
    expect(snapshot.domainRecords.find((r:any)=>r.path==='quality/1.json').value.entries[entry.key].attempts[0].status).toBe('UNKNOWN');
    const replay=await writeReleaseRecords(request('writer-replay',one.head,[record('quality/1.json',intent,sha(first))]));expect(replay.status).toBe('UNCHANGED');
    await expect(writeReleaseRecords(request('wrong-owner',three.head,[record('settings/1-1.json','{}\n')]))).rejects.toThrow();
    await git(remote,'switch','steward/governance-state');await git(remote,'rm','quality/1.json');await git(remote,'commit','--signoff','-m','Fixture cache loss');
    const recovered=await readReleaseRecords({directory:remote,targetRef:'steward/governance-state',repositoryId:12});
    expect(recovered.currentPaths).not.toContain('quality/1.json');expect(recovered.domainRecords.find((r:any)=>r.path==='quality/1.json').content).toBe(intent);
    expect((await git(remote,'log','-1','--format=%B')).match(/Signed-off-by: Fixture <fixture@example.invalid>/g)).toHaveLength(1);
  }finally{await rm(root,{recursive:true,force:true});}
},120000);

it('compacts only durable refusals while each refusal remains readable in actual fast-forward Git history',async()=>{
  const {translateQualitySources}=await import('../src/quality-language-summary.js');
  const {decodeQualityCache}=await import('../../core/src/quality-language-summary.js');
  const {writeReleaseRecords,readReleaseRecords}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
  const root=await mkdtemp(join(tmpdir(),'quality-refusal-history-'));registerOfflineFixtureRoot(root);
  try {
    const remote=join(root,'remote'),profile=join(root,'profile');await mkdir(remote);await mkdir(profile);
    const env=isolatedBuildEnvironment(process.env,profile),git=async(...args:string[])=>(await promisify(execFile)('git',args,{cwd:remote,env,encoding:'utf8',windowsHide:true})).stdout.trim();
    await git('init','--initial-branch=main');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
    await writeFile(join(remote,'README.md'),'fixture\n');await git('add','.');await git('commit','-m','fixture');
    const head=await git('rev-parse','HEAD'),context={repositoryId:12,pullRequestNumber:1,head,configVersion:'v1',observedAt:'2026-11-07T00:00:00Z'};
    let cache=await reconcileQualitySources(null,context,[{sourceCommentId:'review:1',sourceCommit:head,sourceUrl:'https://github.com/test/product/pull/1',severity:'P1',bodyMarkdown:'Check input.',updatedAt:context.observedAt}]);
    let stateHead:string|null=null,previous:string|null=null,writes=0,now=Date.parse(context.observedAt);
    const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
    const store={async save(value:typeof cache){const content=JSON.stringify(value)+'\n';const result=await writeReleaseRecords({directory:join(root,'write-'+(++writes)),remote,repositoryId:12,defaultBranch:'main',targetRef:'steward/governance-state',writer:'quality',expectedHead:stateHead,allowedPaths:['quality/1.json'],changes:[{path:'quality/1.json',content,sha256:hash(content),previousSha256:previous}],identity:{name:'Fixture',email:'fixture@example.invalid'}});expect(['APPLIED','UNCHANGED']).toContain(result.status);stateHead=result.head;previous=hash(content);return {commit:result.head};}};
    const client={preflight:async()=>({status:'READY' as const}),call:async()=>{throw Error('WAIT_AUTH');}};
    for(let i=0;i<4;i++) {
      await translateQualitySources(cache,client,store,{remaining:1,deadline:now+1080000},()=>now);now+=600000;
      const snapshot=await readReleaseRecords({directory:remote,targetRef:'steward/governance-state',repositoryId:12});
      cache=decodeQualityCache(snapshot.domainRecords.find((r:any)=>r.path==='quality/1.json').value,12,1);
      expect(Object.values(cache.entries)[0]!.attempts).toHaveLength(1);
    }
    const commits=(await git('log','steward/governance-state','--format=%H','--','quality/1.json')).split('\n'),observed=new Set<string>();
    for(const commit of commits){const old=JSON.parse(await git('show',commit+':quality/1.json'));for(const entry of Object.values(old.entries) as any[])for(const attempt of entry.attempts)if(attempt.status==='WAIT_AUTH')observed.add(attempt.startedAt);}
    expect(observed.size).toBe(4);expect(commits.length).toBeGreaterThanOrEqual(8);
  }finally{await rm(root,{recursive:true,force:true});}
},120000);
