import {expect,it,vi} from 'vitest';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {NativeEvidenceReader} from '../src/native-release-evidence.js';
import {decodeStateFile} from '../../core/src/release-observation.js';
import {maintenanceDisposition,decodeMaintenanceRecord,assertMaintenanceProgress} from '../../core/src/maintenance.js';

const api=await import(pathToFileURL(resolve('scripts/maintenance.mjs')).href);
const S='a'.repeat(40),T='b'.repeat(40),at='2026-10-31T00:00:00.000Z',now=()=>Date.parse(at);
const coordinator={runId:900,runAttempt:1,controllerSha:T};
const response=(value:any,status=200,headers:Record<string,string>={})=>({status,headers:new Headers(headers),bytes:Buffer.from(JSON.stringify(value))});
function job(id:number,name:string,attempt=1,conclusion='failure') {
  return {id,name,run_id:12,run_attempt:attempt,head_sha:S,status:'completed',conclusion,
    started_at:new Date(Date.parse(at)+attempt*60000).toISOString(),completed_at:new Date(Date.parse(at)+attempt*60000+1000).toISOString(),steps:[] as any[]};
}
async function fixture(file='settings-sync.yml') {
  const definition=await api.maintenanceDefinition(file),workflow={id:5,path:'.github/workflows/'+file,state:'active'};
  const run:any={id:12,run_attempt:1,workflow_id:5,path:workflow.path,repository:{id:1296724484},head_repository:{id:1296724484},head_sha:S,head_branch:'main',event:'schedule',created_at:'2026-10-30T00:00:00Z',updated_at:'2026-10-30T00:01:00Z',status:'completed',conclusion:'failure'};
  const f:any={definition,workflow,run,jobs:Object.entries(definition.names).map(([key,name],i)=>job(i+1,key==='update'?'update (0)':name as string)),calls:[],records:new Map(),saves:0,mode:'accepted'};
  f.io={request:async(method:string,path:string)=>{
    f.calls.push([method,path]);
    if(method==='POST') {
      expect(path).toBe('/repos/splrad/steward/actions/runs/12/rerun-failed-jobs');
      expect(f.records.get(12)?.requests.at(-1)?.fromAttempt).toBe(f.run.run_attempt);
      if(f.mode==='accepted'||f.mode==='lost'){f.run.run_attempt++;f.run.status='queued';f.run.conclusion=null;}
      if(f.mode==='lost'||f.mode==='unknown')throw Error('response lost');
      return response({},201);
    }
    if(path==='/repos/splrad/steward/actions/runs/12')return response(structuredClone(f.run));
    if(path==='/repos/splrad/steward/actions/workflows/5')return response(structuredClone(f.workflow));
    if(path.includes('/actions/runs/12/jobs?')) {
      const page=Number(new URL('https://api.github.com'+path).searchParams.get('page')??1),slice=f.jobs.slice((page-1)*100,page*100);
      const headers=page*100<f.jobs.length?{link:`<https://api.github.com/repos/splrad/steward/actions/runs/12/jobs?filter=all&per_page=100&page=${page+1}>; rel="next"`}:{};
      const rows=structuredClone(slice);for(const j of rows)j.steps?.forEach((s:any,i:number)=>Object.assign(s,{number:i+1,started_at:s.started_at??null,completed_at:s.completed_at??null}));
      return response({total_count:f.jobs.length,jobs:rows},200,headers);
    }
    throw Error('unregistered GET '+path);
  }};
  f.store={list:async()=>[...f.records.values()].map(v=>structuredClone(v)),load:async(id:number)=>structuredClone(f.records.get(id)??null),save:async(value:any,expected:any)=>{
    expect(f.records.get(value.runId)??null).toEqual(expected);f.saves++;f.records.set(value.runId,structuredClone(value));
  }};
  f.execute=()=>api.recoverMaintenanceRun({...f,reader:new NativeEvidenceReader(f.io,'splrad/steward'),branch:'main',runId:12,coordinator,now});
  f.posts=()=>f.calls.filter(([method]:string[])=>method==='POST');
  return f;
}
it.each(['sync-managed.yml','settings-sync.yml','update-dependencies.yml','quality-language-summary.yml','governance-promotion.yml'])('recovers only the exact failed native Run for fixed %s',async file=>{
  const f=await fixture(file);expect(await f.execute()).toEqual({status:'ACCEPTED'});expect(f.posts()).toHaveLength(1);
  expect(f.records.get(12).requests).toHaveLength(1);expect(f.records.get(12).requests[0].responseStatus).toBe(201);
});
it.each(['lost','unknown'])('reconciles a %s response without a second POST from the same attempt',async mode=>{
  const f=await fixture();f.mode=mode;expect((await f.execute()).status).toBe(mode==='lost'?'ACCEPTED':'UNKNOWN');
  expect((await f.execute()).status).toBe(mode==='lost'?'WAIT':'UNKNOWN');expect(f.posts()).toHaveLength(1);
});
it.each(['sync-managed.yml','update-dependencies.yml'])('reads a business Run without a health job for %s',async file=>{
  const f=await fixture(file);f.jobs=f.jobs.filter((j:any)=>j.name!=='automation-health');
  expect((await f.execute()).status).toBe('ACCEPTED');expect(f.posts()).toHaveLength(1);
});
it('stops after two recoveries and three actual failed business waves',async()=>{
  const f=await fixture();expect((await f.execute()).status).toBe('ACCEPTED');
  f.run.status='completed';f.run.conclusion='failure';f.jobs.push(job(2,'settings-sync',2));
  expect((await f.execute()).status).toBe('ACCEPTED');
  f.run.status='completed';f.run.conclusion='failure';f.jobs.push(job(3,'settings-sync',3));
  expect((await f.execute()).status).toBe('EXHAUSTED');expect(f.posts()).toHaveLength(2);
  expect(f.records.get(12).jobs).toHaveLength(3);
});
it('retains original maintenance job IDs after a health-only rerun creates new projection IDs',async()=>{
  const f=await fixture('update-dependencies.yml');
  f.run.run_attempt=2;f.run.conclusion='success';
  for(const j of f.jobs)j.conclusion='success';
  f.jobs[0].steps=[{name:'update-targets-empty',conclusion:'skipped'},{name:'update-targets-found',conclusion:'success'}];
  const prior=structuredClone(f.jobs);
  f.jobs.push(...prior.map((j:any)=>j.name==='automation-health'?{...job(j.id+100,j.name,2,'success')}:({...j,id:j.id+100,run_attempt:2})));
  expect(await f.execute()).toEqual({status:'SATISFIED'});expect(f.posts()).toHaveLength(0);
});
it('counts earlier manual business failures rather than resetting budget when no cache exists',async()=>{
  const f=await fixture();f.run.run_attempt=3;f.jobs.push(job(2,'settings-sync',2),job(3,'settings-sync',3));
  expect((await f.execute()).status).toBe('EXHAUSTED');expect(f.posts()).toHaveLength(0);
});
it.each(['no-targets','matrix','health-rerun'])('ignores a health-only failure after successful update business: %s',async kind=>{
  const f=await fixture('update-dependencies.yml');f.jobs[0].conclusion='success';
  f.jobs[0].steps=[{name:'update-targets-empty',conclusion:kind==='no-targets'?'success':'skipped'},{name:'update-targets-found',conclusion:kind==='no-targets'?'skipped':'success'}];
  if(kind==='no-targets'){f.jobs[1].name='update';f.jobs[1].conclusion='skipped';}else f.jobs[1].conclusion='success';
  if(kind==='health-rerun'){f.run.run_attempt=2;f.jobs.push(job(4,'automation-health',2));}
  expect((await f.execute()).status).toBe('SATISFIED');expect(f.posts()).toHaveLength(0);expect(f.saves).toBe(0);
});
it('does not charge health-only attempts against the first business recovery',async()=>{
  const f=await fixture('update-dependencies.yml');f.run.run_attempt=3;f.jobs.push(job(4,'automation-health',2),job(5,'automation-health',3));
  expect((await f.execute()).status).toBe('ACCEPTED');expect(f.records.get(12).requests[0].fromAttempt).toBe(3);expect(f.posts()).toHaveLength(1);
});
it.each(['repository','fork','workflow','path','branch','pr','head','attempt','job-run','job-head','job-future','job-name','job-duplicate','missing-steps','running-job'])('refuses incomplete or foreign %s evidence before POST',async kind=>{
  const f=await fixture();
  if(kind==='repository')f.run.repository.id=2;if(kind==='fork')f.run.head_repository.id=2;
  if(kind==='workflow')f.run.workflow_id=8;if(kind==='path')f.run.path='other.yml';if(kind==='branch')f.run.head_branch='feature';
  if(kind==='pr')f.run.event='pull_request';if(kind==='head')f.run.head_sha='not-a-sha';if(kind==='attempt')f.run.run_attempt=0;
  if(kind==='job-run')f.jobs[0].run_id=99;if(kind==='job-head')f.jobs[0].head_sha=T;if(kind==='job-future')f.jobs[0].run_attempt=2;
  if(kind==='job-name')f.jobs[0].name='private/secret';if(kind==='job-duplicate')f.jobs.push(structuredClone(f.jobs[0]));
  if(kind==='missing-steps')delete f.jobs[0].steps;if(kind==='running-job')f.jobs[0].status='in_progress';
  await expect(f.execute()).rejects.toThrow();expect(f.posts()).toHaveLength(0);
});
it.each(['missing-attempt','ambiguous-targets','missing-matrix'])('preserves unknown evidence for %s without recovery',async kind=>{
  const f=await fixture(kind==='missing-attempt'?'settings-sync.yml':'update-dependencies.yml');
  if(kind==='missing-attempt')f.run.run_attempt=2;
  else {f.jobs[0].conclusion='success';f.jobs[1].conclusion='success';f.jobs[0].steps=[{name:'update-targets-found',conclusion:'success'},{name:'update-targets-empty',conclusion:kind==='ambiguous-targets'?'success':'skipped'}];if(kind==='missing-matrix')f.jobs.splice(1,1);}
  expect((await f.execute()).status).toBe('UNKNOWN');expect(f.posts()).toHaveLength(0);
});
it('fully reads native jobs across pages without publishing matrix names or step text',async()=>{
  const f=await fixture('update-dependencies.yml');f.jobs=[job(1,'targets',1,'success'),...Array.from({length:105},(_,i)=>job(i+10,`update (${i})`,1,i===104?'failure':'success')),job(2,'automation-health',1,'success')];
  f.jobs[0].steps=[{name:'update-targets-found',conclusion:'success'},{name:'update-targets-empty',conclusion:'skipped'},{name:'private/hidden',conclusion:'success'}];
  expect((await f.execute()).status).toBe('ACCEPTED');expect(f.calls.some(([,p]:string[])=>p?.includes('page=2'))).toBe(true);
  expect(f.records.get(12).jobs).toHaveLength(107);expect(JSON.stringify(f.records.get(12))).not.toContain('private/hidden');
});
it.each(['missing-job','matrix-gap','ambiguous-markers'])('does not infer complete business evidence from a failure when %s exists',async kind=>{
  const f=await fixture(kind==='missing-job'?'sync-managed.yml':'update-dependencies.yml');
  if(kind==='missing-job')f.jobs=f.jobs.filter((j:any)=>j.name!=='templates');
  else {
    f.jobs[0].conclusion='success';
    f.jobs[0].steps=[{name:'update-targets-found',conclusion:'success'},{name:'update-targets-empty',conclusion:kind==='ambiguous-markers'?'success':'skipped'}];
    if(kind==='matrix-gap')f.jobs[1].name='update (1)';
  }
  expect((await f.execute()).status).toBe('UNKNOWN');expect(f.posts()).toHaveLength(0);expect(f.saves).toBe(0);
});
it.each(['health-only','both-failed','health-rerun'])('keeps sync-managed business recovery separate from %s',async kind=>{
  const f=await fixture('sync-managed.yml');
  for(const j of f.jobs)if(j.name!=='automation-health')j.conclusion='success';
  if(kind==='both-failed')f.jobs.find((j:any)=>j.name==='templates').conclusion='failure';
  if(kind==='health-rerun'){f.run.run_attempt=2;f.jobs.push(job(4,'automation-health',2));}
  const result=await f.execute();
  expect(result.status).toBe(kind==='both-failed'?'ACCEPTED':'SATISFIED');
  expect(f.posts()).toHaveLength(kind==='both-failed'?1:0);
  if(kind!=='both-failed')expect(f.saves).toBe(0);
});
it.each(['jobs','archive','run-changed','claim-changed','disabled','stale-source'])('withholds POST after %s changes at the native/archive boundary',async kind=>{
  const f=await fixture(),request=f.io.request;
  let runReads=0;
  f.io.request=async(method:string,path:string)=>{
    if(kind==='jobs'&&path.includes('/jobs?'))return response({},403);
    if(path.endsWith('/runs/12')&&method==='GET') {
      runReads++;
      if(kind==='run-changed'&&runReads===2)f.run.run_attempt++;
      if(kind==='stale-source'&&runReads===3)f.run.head_sha=T;
    }
    return request(method,path);
  };
  if(kind==='archive')f.store.save=async()=>{throw Error('archive unavailable');};
  if(kind==='claim-changed'){const save=f.store.save;f.store.save=async(v:any,e:any)=>{await save(v,e);if(v.requests.length)f.records.get(12).requests[0].coordinatorRunId=99;};}
  if(kind==='disabled')f.workflow.state='disabled_manually';
  const result=await f.execute().catch(()=>({status:'UNKNOWN'}));expect(['WAIT','UNKNOWN']).toContain(result.status);expect(f.posts()).toHaveLength(0);
});
it('respects old source age without dispatching a replacement Run',async()=>{
  const f=await fixture();f.run.created_at='2026-08-01T00:00:00Z';expect((await f.execute()).status).toBe('EXPIRED');expect(f.posts()).toHaveLength(0);
});
it.each(['release.yml','pages.yml','../settings-sync.yml','dynamic/dependabot'])('does not admit arbitrary workflow %s',async file=>{
  await expect(api.maintenanceDefinition(file)).rejects.toThrow('MAINTENANCE_WORKFLOW');
});
it('bisects a saturated native window and refuses an unsplittable or incomplete list',async()=>{
  const first={id:1,workflow_id:5,repository:{id:1296724484},head_repository:{id:1296724484},head_branch:'main',created_at:'1970-01-01T00:00:01Z'};
  const reader={json:async(p:string)=>({total_count:p.includes('00:00:01.000Z..1970-01-01T00:00:02.000Z')?1000:1}),pages:async(p:string)=>[{...first,...(p.includes('00:00:02.000Z..')?{id:2,created_at:'1970-01-01T00:00:02Z'}:{})}]};
  expect((await api.maintenanceRunWindow(reader,5,'main',1,2)).map((r:any)=>r.id)).toEqual([1,2]);
  await expect(api.maintenanceRunWindow({json:async()=>({total_count:1000})},5,'main',1,1)).rejects.toThrow('WINDOW_SATURATED');
  const transport={request:async()=>response({total_count:2,jobs:[job(1,'settings-sync')]})};
  await expect(new NativeEvidenceReader(transport as any,'splrad/steward').pages('actions/runs/12/jobs?filter=all','jobs')).rejects.toThrow('incomplete pagination');
});
it('keeps the native maintenance record closed, central-only, monotonic and separate from product cycles',async()=>{
  const f=await fixture();await f.execute();const record=f.records.get(12),bytes=Buffer.from(JSON.stringify(record));
  expect(decodeStateFile('steward/release-state','maintenance/12.json',bytes,1296724484)).toEqual(record);
  for(const id of [1,44151430])expect(()=>decodeStateFile('steward/release-state','maintenance/12.json',bytes,id)).toThrow();
  for(const [key,value] of Object.entries({phase:'PASS',retryCount:0,allowedJobs:[],cycleId:'private/secret'}))expect(()=>decodeMaintenanceRecord(Buffer.from(JSON.stringify({...record,[key]:value})),1296724484,'maintenance/12.json')).toThrow();
  const reset=structuredClone(record);reset.requests=[];expect(()=>assertMaintenanceProgress(record,reset)).toThrow('REQUEST_REMOVED');
  const lost=structuredClone(record);lost.jobs=[];expect(()=>assertMaintenanceProgress(record,lost)).toThrow('JOB_REMOVED');
});
it('supports many health-only attempts without an invented platform attempt cap',async()=>{
  const f=await fixture('update-dependencies.yml');f.run.run_attempt=101;f.jobs.push(...Array.from({length:100},(_,i)=>job(10+i,'automation-health',i+2)));
  expect((await f.execute()).status).toBe('ACCEPTED');expect(maintenanceDisposition(f.records.get(12))).toBe('FAILED');
});
it('reports maintenance failure independently and still services product work in the same bounded wake',async()=>{
  const {coordinateReleaseWake}=await import(pathToFileURL(resolve('scripts/release-coordinator.mjs')).href),calls:string[]=[];
  const result=await coordinateReleaseWake({maintenance:async()=>{calls.push('maintenance');return {errorCodes:['MAINTENANCE_RECOVERY_EXHAUSTED']};},discover:async()=>[{id:1}],observe:async()=>({}),service:async()=>{calls.push('product');return {status:'WAIT'};},health:async()=>{}},now);
  expect(calls).toEqual(['maintenance','product']);expect(result.scanCompletedAt).toBeNull();expect(result.errorCodes).toEqual(['MAINTENANCE_RECOVERY_EXHAUSTED']);
});
it('re-observes an unknown send once in a later coordinator wake, retaining the two-request ceiling',async()=>{
  const f=await fixture();f.mode='unknown';expect((await f.execute()).status).toBe('UNKNOWN');
  const input={...f,reader:new NativeEvidenceReader(f.io,'splrad/steward'),branch:'main',runId:12,coordinator:{...coordinator,runId:901},now};
  expect((await api.recoverMaintenanceRun(input)).status).toBe('UNKNOWN');expect(f.posts()).toHaveLength(2);
  expect((await api.recoverMaintenanceRun({...input,coordinator:{...coordinator,runId:902}})).status).toBe('EXHAUSTED');expect(f.posts()).toHaveLength(2);
});
it('does not repeat an acknowledged recovery while its next attempt remains invisible',async()=>{
  const f=await fixture();f.mode='acknowledged-not-visible';expect((await f.execute()).status).toBe('UNKNOWN');
  expect((await api.recoverMaintenanceRun({...f,reader:new NativeEvidenceReader(f.io,'splrad/steward'),branch:'main',runId:12,coordinator:{...coordinator,runId:901},now})).status).toBe('UNKNOWN');
  expect(f.posts()).toHaveLength(1);
});
it.each(['normal','denied-list','manually-disabled','wrong-coordinator','budget'])('executes the actual fixed central scan with %s evidence',async mode=>{
  const f=await fixture(),original=f.io.request;let clock=now();
  f.io.request=async(method:string,path:string)=>{
    if(path==='/repos/splrad/steward')return response({id:1296724484,full_name:'splrad/steward',default_branch:'main',archived:false,disabled:false});
    if(path.endsWith('/actions/runs/900'))return response({...f.run,id:900,head_sha:T,path:'.github/workflows/release.yml',head_branch:mode==='wrong-coordinator'?'fork':'main'});
    if(mode==='budget')clock+=6*60_000;
    if(/\/actions\/workflows\/[a-z-]+\.yml$/.test(path)) {
      const file=path.split('/').at(-1)!;
      return response({id:file==='settings-sync.yml'?5:6,path:'.github/workflows/'+file,state:file==='settings-sync.yml'&&mode!=='manually-disabled'?'active':'disabled_manually'});
    }
    if(path.includes('/actions/workflows/5/runs?'))return mode==='denied-list'?response({},403):response({total_count:1,workflow_runs:[structuredClone(f.run)]});
    return original(method,path);
  };
  const execute=api.serviceMaintenance({io:f.io,store:f.store,defaultBranch:'main',coordinator},()=>clock);
  if(mode==='wrong-coordinator'){await expect(execute).rejects.toThrow('COORDINATOR');expect(f.posts()).toHaveLength(0);return;}
  const result=await execute;
  expect(f.posts()).toHaveLength(mode==='normal'?1:0);
  expect(JSON.stringify(result)).not.toMatch(/private|runId|workflowId|headSha|settings-sync/);
  if(['budget','denied-list'].includes(mode))expect(result.counts.unknown).toBeGreaterThan(0);
  if(mode==='normal')expect(result.counts.recovered).toBe(1);
});
