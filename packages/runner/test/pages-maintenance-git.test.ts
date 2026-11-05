import {expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {registerOfflineFixtureRoot} from './offline-fixtures.js';
import {isolatedBuildEnvironment} from '../src/build-environment.js';
import {decodeStateFile} from '../../core/src/release-observation.js';

it('Pages reservations survive real Git cache loss, preserve another governance writer and reject budget/source resets',async()=>{
  const {writeReleaseRecords,readReleaseRecords}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
  const {pagesGitStore}=await import(pathToFileURL(resolve('scripts/pages-maintenance.mjs')).href);
  const {pagesInputDigest}=await import(pathToFileURL(resolve('scripts/select-pages-source.mjs')).href);
  const root=await mkdtemp(join(tmpdir(),'pages-git-'));registerOfflineFixtureRoot(root);
  try {
    const remote=join(root,'remote'),profile=join(root,'profile');await mkdir(remote);await mkdir(profile);
    const env=isolatedBuildEnvironment(process.env,profile),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
    const git=async(...args:string[])=>(await promisify(execFile)('git',args,{cwd:remote,env,encoding:'utf8',windowsHide:true})).stdout.trim();
    await git('init','--initial-branch=trunk');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
    await writeFile(join(remote,'README.md'),'fixture\n');await git('add','README.md');await git('commit','--signoff','-m','Fixture source');
    const source:any={schemaVersion:1,repositoryId:17,repository:'private/product',mode:'default-branch',controllerSha:'c'.repeat(40),defaultBranch:'trunk',sourceSha:await git('rev-parse','HEAD'),ref:'refs/heads/trunk',releaseId:null,unitId:null,manifestDigest:null};source.inputDigest=pagesInputDigest(source);
    const record:any={schemaVersion:1,kind:'RUN',repositoryId:17,workflowId:5,source,runId:12,runAttempt:1,siteDeploymentId:null,createdAt:'2026-10-30T00:00:00.000Z',observedAt:'2026-10-31T00:00:00.000Z',requests:[]};
    const path='maintenance/pages/12.json',identity={name:'Fixture',email:'fixture@example.invalid'},targetRef='steward/governance-state';
    const file=(path:string,content:string,previousSha256:string|null=null)=>({path,content,sha256:hash(content),previousSha256});
    const request=(name:string,changes:any[],expectedHead:string|null=null,writer='pages')=>({directory:join(root,name),remote,repositoryId:17,defaultBranch:'trunk',targetRef,writer,expectedHead,allowedPaths:changes.map(c=>c.path),changes,identity});
    await writeReleaseRecords(request('seed',[file(path,JSON.stringify(record)+'\n')]));
    const refresh=async()=>{const snapshot=await readReleaseRecords({directory:remote,targetRef,repositoryId:17});return {remote,snapshot,readBytes:async(p:string)=>Buffer.from((await promisify(execFile)('git',['show',`${snapshot.head}:${p}`],{cwd:remote,env,encoding:'utf8',windowsHide:true})).stdout)};};
    const store=pagesGitStore({repositoryId:17,refresh,writeDirectory:join(root,'writes'),defaultBranch:'trunk',identity});
    const head=(await refresh()).snapshot.head,claimed=structuredClone(record);
    claimed.requests.push({fromAttempt:1,requestedAt:record.observedAt,coordinatorRunId:900,coordinatorRunAttempt:1,responseStatus:null});await store.save(claimed,record);
    const other=`quality/1/${source.sourceSha}.md`;
    expect((await writeReleaseRecords(request('concurrent',[file(other,'Preserved quality summary\n')],head,'quality'))).status).toBe('APPLIED');
    expect(await store.load(path)).toEqual(claimed);expect(await git('show',`${targetRef}:${other}`)).toBe('Preserved quality summary');
    await expect(store.save(record,claimed)).rejects.toThrow('REQUEST_REMOVED');await expect(store.save(claimed,record)).rejects.toThrow('STATE_CHANGED');
    await git('switch',targetRef);await git('rm',path);await git('commit','--signoff','-m','Fixture cache loss');await git('switch','trunk');
    expect(await store.load(path)).toEqual(claimed);
    await expect(writeReleaseRecords(request('reset',[file(path,JSON.stringify(record)+'\n')],(await refresh()).snapshot.head))).rejects.toThrow('RELEASE_RECORD: validation or local operation failed');
    expect(await store.load(path)).toEqual(claimed);
    await store.save(claimed,claimed);expect((await refresh()).snapshot.currentPaths).toContain(path);
    expect((await git('show','-s','--format=%B',targetRef)).match(/^Signed-off-by:/gm)).toHaveLength(1);
    for(const mutate of [(v:any)=>v.schemaVersion=99,(v:any)=>v.source.sourceSha='f'.repeat(40),(v:any)=>v.repositoryId=18,
      (v:any)=>v.requests.push(...[v.requests[0],v.requests[0]]),(v:any)=>v.command='echo unsafe']){
      const bad=structuredClone(claimed);mutate(bad);expect(()=>decodeStateFile(targetRef,path,Buffer.from(JSON.stringify(bad)),17)).toThrow();
    }
    expect(()=>decodeStateFile('steward/release-state',path,Buffer.from(JSON.stringify(claimed)),17)).toThrow();
  }finally{await rm(root,{recursive:true,force:true});}
},120000);
