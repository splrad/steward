import {describe,expect,it} from 'vitest';
import {ReleaseRelay,releaseHint,relayKey} from '../src/release-cycle-relay.js';
import {CENTRAL,TARGET} from '../src/bounded-recheck-github.js';
import {SqliteDurableStorage} from './bounded-storage.js';

const pin='1'.repeat(40),deployment='2'.repeat(40);
const repo={id:TARGET.id,full_name:TARGET.name,default_branch:'main',fork:false,archived:false};
const payload={installation:{id:7},repository:repo,ref:'refs/heads/main',after:pin,deleted:false};
const hint=releaseHint('push',payload,'7')!;
const receipt={id:12,run_attempt:1,repository:{id:CENTRAL.id},head_repository:{id:CENTRAL.id},path:'.github/workflows/release-cycle-event.yml',
  head_branch:'main',head_sha:pin,actor:{id:301115370},event:'workflow_dispatch',display_title:'Release cycle '+relayKey(hint)};
function fixture(){
 const storage=new SqliteDurableStorage();
 const env={BOUNDED_RECHECK_ENABLED:'true',BOUNDED_DEPLOYMENT_SHA:deployment};
 const state={now:Date.now(),promoted:'3'.repeat(40),posts:0,hits:[] as any[]};
 const g={async json(id:number,path:string,method?:string){
   expect(id).toBe(CENTRAL.id);
   if(method==='POST'){state.posts++;throw Error('unknown POST response');}
   if(path.includes('/git/ref/heads/'))return {ref:'refs/heads/'+(path.endsWith('main')?'main':'steward/validated-controller'),object:{type:'commit',sha:path.endsWith('main')?pin:state.promoted}};
   if(path.includes('/contents/')){const content=Buffer.from(JSON.stringify({enabled:true,schemaVersion:1,deploymentSha:deployment}));return {type:'file',path:'config/bounded-recheck.json',encoding:'base64',size:content.length,content:content.toString('base64')};}
   if(path.includes('/runs?'))return {total_count:state.hits.length,workflow_runs:state.hits};
   if(path.endsWith('/release-cycle-event.yml'))return {state:'active',path:receipt.path};
   throw Error(path);
 }};
 const relay=new ReleaseRelay(storage as any,env as any,()=>g as any,()=>state.now);
 const tick=async()=>{state.now=await storage.get<number>('__alarm')??state.now;await relay.alarm();};
 return {state,relay,storage,tick};
}
describe('release cycle relay',()=>{
 it('retains signed product source and excludes unrelated repos and branches and forwards successful probes',()=>{
  expect(hint).toEqual({repositoryId:TARGET.id,kind:'push',sourceSha:pin});
  expect(releaseHint('push',payload,'8')).toBeUndefined();
  expect(releaseHint('push',{...payload,ref:'refs/heads/topic'},'7')).toBeUndefined();
  const run={id:12,run_attempt:2,head_repository:{id:TARGET.id},head_branch:'main',actor:{id:301115370},status:'completed',event:'workflow_dispatch',path:'.github/workflows/steward-release-channels.yml',workflow_id:410998651,display_title:'Channels submit '+'f'.repeat(64)};
  const p={...payload,action:'completed',workflow_run:run};
  expect(releaseHint('workflow_run',p,'7')).toEqual({repositoryId:TARGET.id,kind:'run',runId:12,attempt:2});
  const build={...run,workflow_id:410998652,path:'.github/workflows/steward-release-publish.yml',display_title:'Build '+'a'.repeat(64),head_branch:'steward/build/pr-192-'+pin};
  expect(releaseHint('workflow_run',{...p,workflow_run:build},'7')).toEqual({repositoryId:TARGET.id,kind:'run',runId:12,attempt:2});
  expect(releaseHint('workflow_run',{...p,workflow_run:{...build,head_branch:'main'}},'7')).toBeUndefined();
  run.display_title='Channels observe '+'f'.repeat(64);expect(releaseHint('workflow_run',p,'7')).toBeUndefined();Object.assign(run,{conclusion:'success'});expect(releaseHint('workflow_run',p,'7')?.kind).toBe('run');
 });
 it('retains its original object across promotion lag, response loss and duplicate registration',async()=>{
  const f=fixture();await f.relay.register(hint);await f.tick();expect(f.state.posts).toBe(0);
  f.state.promoted=pin;await f.tick();expect(f.state.posts).toBe(1);
  const stored=await f.storage.get('releaseCycle');await f.relay.register(hint);expect(await f.storage.get('releaseCycle')).toEqual(stored);
  f.state.hits=[{...receipt,head_sha:'0'.repeat(40)}];await f.tick();
  f.state.hits=[receipt];await f.tick();expect(await f.storage.get('releaseCycle')).toMatchObject({stage:'received',runId:12});
  expect(await f.storage.get('__alarm')).toBeUndefined();expect(f.state.posts).toBe(1);
 });
 it('closes unknown delivery without repeat POST or idle alarm',async()=>{
  const f=fixture();f.state.promoted=pin;await f.relay.register(hint);
  for(let i=0;i<6;i++)await f.tick();
  expect(await f.storage.get('releaseCycle')).toMatchObject({stage:'unknown',reason:'DELIVERY_UNKNOWN'});
  expect(await f.storage.get('__alarm')).toBeUndefined();expect(f.state.posts).toBe(1);
 });
});
