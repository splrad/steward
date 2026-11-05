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

it('persists maintenance alongside product state, preserves requests after cache loss and refuses budget reset or foreign ownership',async()=>{
  const {writeReleaseRecords,readReleaseRecords}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
  const {maintenanceGitStore}=await import(pathToFileURL(resolve('scripts/maintenance.mjs')).href);
  const root=await mkdtemp(join(tmpdir(),'maintenance-git-'));registerOfflineFixtureRoot(root);
  try {
    const remote=join(root,'remote'),profile=join(root,'profile');await mkdir(remote);await mkdir(profile);
    const env=isolatedBuildEnvironment(process.env,profile),digest=(s:string)=>createHash('sha256').update(s).digest('hex');
    const git=async(...args:string[])=>(await promisify(execFile)('git',args,{cwd:remote,env,encoding:'utf8',windowsHide:true})).stdout.trim();
    await git('init','--initial-branch=main');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
    await writeFile(join(remote,'README.md'),'fixture\n');await git('add','README.md');await git('commit','--signoff','-m','Fixture source');
    const source=await git('rev-parse','HEAD'),identity={name:'Fixture',email:'fixture@example.invalid'},id=1296724484;
    const state=JSON.stringify({schemaVersion:3,releaseAdoption:{sourceSha:'a'.repeat(40),prNumber:1},repositoryId:id,defaultBranch:'main',revision:0,lastObservedDefaultSha:null,lastCompletedCycleId:null,activeCycleId:null,candidate:null,nextCheckAt:null,lastProgressAt:null,lastErrorCode:null})+'\n';
    const file=(path:string,content:string,previousSha256:string|null=null)=>({path,content,sha256:digest(content),previousSha256});
    const request=(name:string,changes:any[],expectedHead:string|null=null,writer='maintenance')=>({directory:join(root,name),remote,repositoryId:id,defaultBranch:'main',targetRef:'steward/release-state',writer,expectedHead,allowedPaths:changes.map(c=>c.path),changes,identity});
    await writeReleaseRecords(request('seed',[file('state.json',state),file('generated/preserved.md','Existing bytes\n')],null,'release'));
    const refresh=async()=>{const snapshot=await readReleaseRecords({directory:remote,targetRef:'steward/release-state',repositoryId:id});return {remote,snapshot,readBytes:async(path:string)=>Buffer.from((await promisify(execFile)('git',['show',`${snapshot.head}:${path}`],{cwd:remote,env,encoding:'utf8',windowsHide:true})).stdout)};};
    const store=maintenanceGitStore({refresh,writeDirectory:join(root,'writes'),defaultBranch:'main',identity});
    const record:any={schemaVersion:1,repositoryId:id,workflowFile:'settings-sync.yml',workflowId:5,runId:12,headSha:source,headBranch:'main',event:'schedule',createdAt:'2026-10-30T00:00:00.000Z',runAttempt:1,conclusion:'failure',jobs:[{id:1,key:'settings-sync',matrixIndex:null,attempt:1,conclusion:'failure',empty:null,found:null}],observedAt:'2026-10-31T00:00:00.000Z',requests:[]};
    await store.save(record,null);expect(await store.load(12)).toEqual(record);
    const claimed=structuredClone(record);claimed.requests.push({fromAttempt:1,requestedAt:record.observedAt,coordinatorRunId:900,coordinatorRunAttempt:1,responseStatus:null});
    await store.save(claimed,record);expect(await store.list()).toEqual([claimed]);
    const snap=(await refresh()).snapshot;
    expect(await git('show',`${snap.head}:state.json`)).toBe(state.trim());expect(await git('show',`${snap.head}:generated/preserved.md`)).toBe('Existing bytes');
    await expect(store.save(record,claimed)).rejects.toThrow('REQUEST_REMOVED');
    await expect(store.save(claimed,record)).rejects.toThrow('STATE_CHANGED');
    await expect(writeReleaseRecords({...request('foreign',[file('maintenance/12.json',JSON.stringify(claimed)+'\n')]),repositoryId:7})).rejects.toThrow();
    await git('switch','steward/release-state');await git('rm','maintenance/12.json');await git('commit','--signoff','-m','Fixture cache loss');
    expect(await store.load(12)).toEqual(claimed);
    const lost=(await refresh()).snapshot;
    await expect(writeReleaseRecords(request('reset-after-loss',[file('maintenance/12.json',JSON.stringify(record)+'\n')],lost.head))).rejects.toThrow();
    await git('switch','main');await store.save(claimed,claimed);
    expect((await refresh()).snapshot.currentPaths).toContain('maintenance/12.json');
    expect((await git('show','-s','--format=%B','steward/release-state')).match(/^Signed-off-by:/gm)).toHaveLength(1);
  }finally{await rm(root,{recursive:true,force:true});}
},120000);
