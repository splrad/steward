import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
import {NativeEvidenceReader,decodePagesMaintenance,assertPagesProgress,pagesRecordPath} from '../../packages/runner/dist/index.js';
import {pagesInputDigest,pagesRunName} from '../select-pages-source.mjs';
import {pagesDefinition,currentPagesSource,preflightPages,checkPagesArtifact,pagesArtifactName,pagesDeployment} from '../pages-runtime.mjs';
import {servicePages,pagesRunInventory} from '../pages-maintenance.mjs';

const bytes=await readFile(new URL('../../templates/release/pages.yml',import.meta.url));
const workflowDoc=YAML.parse(bytes.toString()),pin=workflowDoc.env.STEWARD_CONTROLLER_SHA,S='a'.repeat(40),N='b'.repeat(40);
const START=Date.parse('2026-10-31T00:00:00Z');
function fixture() {
  const repo={id:10,full_name:'fixture/product',default_branch:'trunk',archived:false,disabled:false};
  const source={schemaVersion:1,repositoryId:10,repository:repo.full_name,mode:'default-branch',controllerSha:pin,defaultBranch:'trunk',sourceSha:S,ref:'refs/heads/trunk',releaseId:null,unitId:null,manifestDigest:null};source.inputDigest=pagesInputDigest(source);
  const workflow={id:5,path:'.github/workflows/pages.yml',state:'active'};
  const run={id:12,workflow_id:5,run_attempt:1,repository:{id:10},head_repository:{id:10},path:workflow.path,head_sha:S,head_branch:'trunk',event:'push',status:'completed',conclusion:'failure',created_at:'2026-10-30T00:00:00Z',updated_at:'2026-10-30T00:01:00Z',display_title:'Pages default-branch '+S+' 12'};
  const build={id:21,run_id:12,run_attempt:1,head_sha:S,name:`build/${source.inputDigest}`,conclusion:'success',steps:[{name:'Upload Pages artifact',conclusion:'success'}]};
  const deploy={id:22,run_id:12,run_attempt:1,head_sha:S,name:`deploy/${source.inputDigest}`,conclusion:'success',steps:[{name:'Deploy Pages',conclusion:'success',completed_at:'2026-10-30T00:10:00Z'}]};
  for(const j of [build,deploy]) Object.assign(j,{status:'completed',started_at:'2026-10-30T00:00:00Z',completed_at:'2026-10-30T00:10:00Z'});
  const artifact={id:30,name:pagesArtifactName(source,12,1),expired:false,expires_at:'2099-01-01T00:00:00Z',size_in_bytes:20,digest:'sha256:'+'e'.repeat(64),workflow_run:{id:12,head_sha:S}};
  const state={time:START,head:S,mode:'default-branch',runs:[],deployments:[],statuses:new Map(),jobs:[build,deploy],artifacts:[artifact],post:'accept',fault:null,onSave:null,saturated:false,site:null};
  const calls=[],records=new Map();
  const response=value=>({status:200,headers:new Headers(),bytes:Buffer.from(JSON.stringify(value))});
  const io={async request(method,path,limit,body) {
    calls.push({method,path,body});if(state.fault?.(method,path))return {status:403,headers:new Headers(),bytes:Buffer.from('{}')};
    const url=new URL(path,'https://api.github.com'),p=url.pathname.replace('/repos/'+repo.full_name,'');
    if(method==='POST') {
      if(p.endsWith('/dispatches')&&state.post!=='reject')state.runs.push({...run,id:Math.max(11,...state.runs.map(r=>r.id))+1,event:'workflow_dispatch',display_title:pagesRunName(source),status:'queued',conclusion:null,created_at:new Date(state.time).toISOString()});
      if(p.endsWith('/rerun')&&state.post!=='reject'){const r=state.runs.find(r=>r.id===12);r.run_attempt++;r.status='queued';r.conclusion=null;}
      if(state.post==='lost')throw Error('lost response');
      return {status:state.post==='reject'?503:p.endsWith('/dispatches')?204:201,headers:new Headers(),bytes:Buffer.from('{}')};
    }
    if(p==='')return response(repo);
    if(p==='/git/ref/heads/trunk')return response({ref:'refs/heads/trunk',object:{type:'commit',sha:state.head}});
    if(p==='/contents/.github/workflows/pages.yml')return response({type:'file',path:'.github/workflows/pages.yml',encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')});
    if(p.startsWith('/actions/variables/'))return response({name:p.split('/').at(-1),value:state.mode});
    if(p==='/actions/workflows/pages.yml')return response(workflow);
    if(p==='/actions/workflows/5/runs') {
      const status=url.searchParams.get('status'),created=url.searchParams.get('created');
      let rows=state.runs;
      if(status)rows=rows.filter(r=>r.status===status);
      if(created){const [lo,hi]=created.split('..').map(Date.parse);rows=rows.filter(r=>Date.parse(r.created_at)>=lo&&Date.parse(r.created_at)<=hi);}
      return response({total_count:state.saturated?1000:rows.length,workflow_runs:rows});
    }
    if(/^\/actions\/runs\/\d+$/.test(p))return response(state.runs.find(r=>r.id===Number(p.split('/').at(-1)))??run);
    if(p==='/actions/runs/12/artifacts')return response({total_count:state.artifacts.length,artifacts:state.artifacts});
    if(/^\/actions\/runs\/\d+\/(attempts\/\d+\/)?jobs$/.test(p)){
      const parts=p.split('/'),rows=structuredClone(state.jobs.filter(j=>j.run_id===Number(parts[3])&&(parts[4]!=='attempts'||j.run_attempt===Number(parts[5]))));
      for(const j of rows)j.steps?.forEach((s,i)=>Object.assign(s,{number:i+1,started_at:s.started_at??null,completed_at:s.completed_at??null}));
      return response({total_count:rows.length,jobs:rows});
    }
    if(p==='/deployments')return response(state.deployments);
    if(/^\/deployments\/\d+\/statuses$/.test(p))return response(state.statuses.get(Number(p.split('/')[2]))??[]);
    throw Error('unregistered fixture '+method+' '+path);
  }};
  const reader=new NativeEvidenceReader(io,repo.full_name),options={reader,repositoryId:10,mode:'default-branch',controllerSha:pin};
  const store={async load(p){return structuredClone(records.get(p)??null);},async save(v,expected){const p=pagesRecordPath(v);assert.deepEqual(records.get(p)??null,expected);decodePagesMaintenance(Buffer.from(JSON.stringify(v)),10,p);if(expected)assertPagesProgress(expected,v);records.set(p,structuredClone(v));state.onSave?.(v);}};
  const coordinator={runId:900,runAttempt:1,controllerSha:pin};
  const service=()=>servicePages({io,repository:repo,store,coordinator,appBotId:301115370},{now:()=>state.time,deployment:async()=>state.site});
  const successful=(id=40,sha=S)=>{state.deployments.push({id,environment:'github-pages',sha,created_at:'2026-10-30T00:00:00Z'});state.statuses.set(id,[{id:id+100,state:'success',created_at:'2026-10-30T00:10:00Z',log_url:'https://github.com/fixture/product/actions/runs/12/job/22',environment_url:'https://fixture.github.io/product/'}]);};
  return {repo,source,workflow,run,build,deploy,artifact,state,calls,records,reader,options,store,coordinator,service,successful};
}

test('native YAML separates source, secret-free build and Pages deployment with same-Run artifacts',()=>{
  assert.equal(pagesDefinition(bytes).controllerSha,pin);
  const d=workflowDoc;assert.deepEqual(d.permissions,{});assert.deepEqual(d.jobs.build.permissions,{contents:'read'});
  assert.equal(d.jobs.build.environment,undefined);assert.deepEqual(d.jobs.deploy.needs,['select','build']);
  assert.deepEqual(d.jobs.deploy.permissions,{contents:'read',actions:'read',attestations:'read',deployments:'read',pages:'write','id-token':'write'});
  assert.equal(d.concurrency.queue,'max');assert.equal(d.concurrency['cancel-in-progress'],false);
  assert.equal(d.on.push.paths,undefined);assert.deepEqual(d.on.push.branches,['**']);assert.equal(d.jobs.deploy.steps.filter(s=>s.uses?.startsWith('actions/checkout@')).length,1);
  assert.equal(d.jobs.build.steps.find(s=>s.name==='Upload Pages artifact').with.name,'github-pages-${{ github.run_id }}-${{ github.run_attempt }}-${{ needs.select.outputs.input_digest }}');
  assert.equal(d.jobs.deploy.steps.find(s=>s.name==='Deploy Pages').with.artifact_name,'${{ steps.guard.outputs.artifact_name }}');
  assert.doesNotMatch(bytes.toString(),/secrets\.|pull_request_target|workflow_run|deployment_id/);
});
test('rejects drifted controller pins, missing build dependency and concurrent cancellation',()=>{
  for(const mutate of [d=>d.jobs.deploy.steps[0].with.ref=N,d=>d.jobs.deploy.needs=['select'],d=>d.concurrency['cancel-in-progress']=true]){
    const d=structuredClone(workflowDoc);mutate(d);assert.throws(()=>pagesDefinition(Buffer.from(YAML.stringify(d))),/PAGES_/);
  }
});
test('actual Contents bytes select the immutable product pin; default mode needs no VERSION or Release',async()=>{
  const f=fixture();f.options.controllerSha=N;assert.deepEqual((await currentPagesSource(f.options)).source,f.source);
  assert.ok(f.calls.every(c=>!c.path.includes('VERSION')&&!c.path.includes('/releases')));
});
test('deploy-only rerun resolves the retained build to its original artifact name and ID',async()=>{
  const f=fixture();f.run.run_attempt=2;f.state.jobs.push({...structuredClone(f.build),id:121,run_attempt:2});
  const result=await checkPagesArtifact(f.reader,f.source,{runId:12,attempt:2,artifactId:30});
  assert.equal(result.buildJobId,21);assert.equal(result.runAttempt,1);assert.equal(result.artifactName,f.artifact.name);
});
test('retained deployment projections preserve the original deployment job even with a Run-only URL',async()=>{
  const f=fixture();f.run.run_attempt=2;f.successful();f.state.jobs.push({...structuredClone(f.deploy),id:122,run_attempt:2});
  f.state.statuses.get(40)[0].log_url='https://github.com/fixture/product/actions/runs/12';
  const result=await pagesDeployment(f.reader,f.source);assert.equal(result.jobId,22);assert.equal(result.runAttempt,1);
});
test('accepts an exact same-Run current-attempt artifact with successful native build proof',async()=>{
  const f=fixture();const result=await preflightPages({reader:f.reader,source:f.source,options:f.options,invocation:{runId:12,attempt:1,artifactId:30}});
  assert.equal(result.status,'READY');assert.equal(result.artifact.artifactId,30);assert.equal(result.artifact.buildJobId,21);
});
for(const [name,mutate] of [
  ['expired',f=>f.artifact.expired=true],['other Run',f=>f.artifact.workflow_run.id=13],['other source',f=>f.artifact.workflow_run.head_sha=N],
  ['other input',f=>f.artifact.name=f.artifact.name.replace(f.source.inputDigest,'f'.repeat(64))],['duplicate',f=>f.state.artifacts.push({...f.artifact,id:31})],
  ['missing build proof',f=>f.build.steps=[]],['wrong attempt',f=>f.build.run_attempt=2],['incomplete native list',f=>f.state.artifacts.push({...f.artifact})]
])test(`refuses ${name} artifact evidence`,async()=>{const f=fixture();mutate(f);await assert.rejects(checkPagesArtifact(f.reader,f.source,{runId:12,attempt:1,artifactId:30}));});
test('old build exits before artifact reads when default head moved',async()=>{
  const f=fixture();f.state.head=N;assert.equal((await preflightPages({reader:f.reader,source:f.source,options:f.options,invocation:{}})).status,'STALE');assert.ok(!f.calls.some(c=>c.path.includes('/artifacts')));
});
test('source change during artifact reads is caught by the final freshness check',async()=>{
  const f=fixture();let reads=0;const currentSource=async()=>{reads++;return {status:reads===1?'READY':'DISABLED',source:f.source};};
  assert.equal((await preflightPages({reader:f.reader,source:f.source,options:f.options,invocation:{runId:12,attempt:1,artifactId:30}},{currentSource})).status,'STALE');
});
test('same native deployment skips duplicate work and records actual deployment/Run/job identity',async()=>{
  const f=fixture();f.successful();const result=await preflightPages({reader:f.reader,source:f.source,options:f.options,invocation:{}});
  assert.equal(result.status,'SATISFIED');assert.equal(result.deployment.deploymentId,40);assert.equal(result.deployment.jobId,22);
  assert.ok(!f.calls.some(c=>c.path.includes('/artifacts')));
});
test('a deployment claiming another source cannot reuse this native Run proof',async()=>{
  const f=fixture();f.successful();f.successful(41,N);await assert.rejects(pagesDeployment(f.reader,f.source),/DEPLOYMENT_SOURCE/);
});
test('latest actual deploy wins over an older matching source',async()=>{
  const f=fixture();f.successful();f.successful(41,N);
  f.state.runs.push({...f.run,id:13,head_sha:N});f.state.jobs.push({...f.deploy,id:23,run_id:13,head_sha:N,name:'deploy/'+'f'.repeat(64),steps:[{name:'Deploy Pages',conclusion:'success',completed_at:'2026-10-30T00:11:00Z'}]});
  f.state.statuses.get(41)[0].log_url='https://github.com/fixture/product/actions/runs/13/job/23';assert.equal(await pagesDeployment(f.reader,f.source),null);
});
test('duplicate skipped job and inactive Environment status preserve the last actual successful deployment',async()=>{
  const f=fixture();f.successful();f.state.statuses.get(40)[0].state='inactive';f.successful(41);
  f.state.runs.push({...f.run,id:13});f.state.jobs.push({...f.deploy,id:23,run_id:13,steps:[{name:'Deploy Pages',conclusion:'skipped'}]});
  f.state.statuses.get(41)[0].log_url='https://github.com/fixture/product/actions/runs/13/job/23';assert.equal((await pagesDeployment(f.reader,f.source)).deploymentId,40);
});
test('deployment with another input digest or spoofed job URL cannot satisfy this source',async()=>{
  const f=fixture();f.successful();f.deploy.name='deploy/'+'f'.repeat(64);assert.equal(await pagesDeployment(f.reader,f.source),null);
  f.deploy.name='deploy/'+f.source.inputDigest;f.state.statuses.get(40)[0].log_url='https://attacker.invalid/actions/runs/12/job/22';await assert.rejects(pagesDeployment(f.reader,f.source),/PAGES_DEPLOYMENT_UNCONFIRMED/);
});

test('unconfirmed successful deployment prevents both deployment and recovery side effects',async()=>{
  const f=fixture();f.successful();f.state.statuses.get(40)[0].log_url='https://github.com/fixture/product/actions/runs/12/job/999';
  await assert.rejects(preflightPages({reader:f.reader,source:f.source,options:f.options,invocation:{runId:12,attempt:1,artifactId:30}}),/PAGES_DEPLOYMENT_UNCONFIRMED/);
  await assert.rejects(servicePages({io:f.reader.io,repository:f.repo,store:f.store,coordinator:f.coordinator,appBotId:301115370},{now:()=>f.state.time}),/PAGES_DEPLOYMENT_UNCONFIRMED/);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(f.records.size,0);
  assert.ok(!f.calls.some(c=>c.path.includes('/artifacts')));
});

test('current Run deployment readback ignores successful deployments from other Runs',async()=>{
  const f=fixture();f.successful();f.successful(41);
  f.state.runs.push({...f.run,id:13});f.state.jobs.push({...f.deploy,id:23,run_id:13,steps:[{name:'Deploy Pages',conclusion:'success',completed_at:'2026-10-30T00:11:00Z'}]});
  f.state.statuses.get(41)[0].log_url='https://github.com/fixture/product/actions/runs/13/job/23';
  const result=await pagesDeployment(f.reader,f.source,{runId:13,attempt:1,completed:true});
  assert.equal(result.deploymentId,41);assert.equal(result.runId,13);assert.equal(result.jobId,23);
});
test('maintenance dispatches only fixed workflow/ref/closed inputs and records intent before POST',async()=>{
  const f=fixture();assert.equal((await f.service()).status,'ACCEPTED');
  const posts=f.calls.filter(c=>c.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].path,'/repos/fixture/product/actions/workflows/5/dispatches');
  assert.deepEqual(Object.keys(posts[0].body.inputs).sort(),['input_digest','release_id','source_mode','source_sha']);assert.equal(posts[0].body.ref,'refs/heads/trunk');
  assert.equal([...f.records.values()][0].requests[0].responseStatus,204);
});
test('dispatch response loss reconciles queued same-source Run without a second send',async()=>{
  const f=fixture();f.state.post='lost';assert.equal((await f.service()).status,'ACCEPTED');f.coordinator.runId++;f.state.time+=300000;
  assert.equal((await f.service()).status,'WAIT');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('an old queued Run outside the discovery window suppresses dispatch',async()=>{
  const f=fixture();f.state.runs.push({...f.run,status:'queued',conclusion:null,created_at:'2025-01-01T00:00:00Z'});
  assert.equal((await f.service()).status,'WAIT');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
test('rerun rebuilds the same Run even with expired artifacts; at most two recoveries',async()=>{
  const f=fixture();f.state.runs.push(f.run);f.artifact.expired=true;
  assert.equal((await f.service()).status,'ACCEPTED');assert.equal(f.run.run_attempt,2);
  f.run.status='completed';f.run.conclusion='failure';f.coordinator.runId++;f.state.time+=300000;
  assert.equal((await f.service()).status,'ACCEPTED');assert.equal(f.run.run_attempt,3);
  f.run.status='completed';f.run.conclusion='failure';f.coordinator.runId++;f.state.time+=300000;
  assert.equal((await f.service()).status,'EXHAUSTED');assert.equal(f.calls.filter(c=>c.method==='POST').length,2);
  assert.ok(f.calls.filter(c=>c.method==='POST').every(c=>c.path.endsWith('/runs/12/rerun')));assert.ok(!f.calls.some(c=>c.path.includes('release-state')));
});
test('rerun response loss keeps the reserved budget and observes the newer attempt',async()=>{
  const f=fixture();f.state.runs.push(f.run);f.state.post='lost';assert.equal((await f.service()).status,'ACCEPTED');
  assert.equal(f.records.get('maintenance/pages/12.json').requests[0].responseStatus,null);assert.equal((await f.service()).status,'WAIT');
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('same wake cannot repeat an uncertain rerun; later wake can spend only the remaining slot',async()=>{
  const f=fixture();f.state.runs.push(f.run);f.state.post='reject';assert.equal((await f.service()).status,'UNKNOWN');assert.equal((await f.service()).status,'WAIT');
  f.coordinator.runId++;f.state.time+=300000;assert.equal((await f.service()).status,'UNKNOWN');
  f.coordinator.runId++;f.state.time+=300000;assert.equal((await f.service()).status,'EXHAUSTED');assert.equal(f.calls.filter(c=>c.method==='POST').length,2);
});
test('unknown dispatches have bounded reservations and cannot create unbounded new Runs',async()=>{
  const f=fixture();f.state.post='reject';for(let i=0;i<3;i++){assert.equal((await f.service()).status,'UNKNOWN');assert.equal((await f.service()).status,i===2?'EXHAUSTED':'WAIT');f.coordinator.runId++;f.state.time+=300000;}
  assert.equal((await f.service()).status,'EXHAUSTED');assert.equal(f.calls.filter(c=>c.method==='POST').length,3);
});
test('source moving while Git intent is archived prevents dispatch',async()=>{
  const f=fixture();f.state.onSave=()=>f.state.head=N;assert.equal((await f.service()).status,'STALE');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
test('human workflow disable and source disable both prevent recovery',async()=>{
  const f=fixture();f.workflow.state='disabled_manually';assert.equal((await f.service()).status,'DISABLED');f.workflow.state='active';f.state.mode='';assert.equal((await f.service()).status,'DISABLED');assert.equal(f.records.size,0);
});
test('denied variable reads and incomplete inventories fail closed without writes',async()=>{
  for(const path of ['/actions/variables/','status=pending']){const f=fixture();f.state.fault=(m,p)=>p.includes(path);await assert.rejects(f.service());assert.equal(f.records.size,0);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);}
});
test('saturated single-second inventory cannot be interpreted as a missing event',async()=>{
  const f=fixture();f.state.saturated=true;await assert.rejects(pagesRunInventory(f.reader,f.workflow,f.source,1,1),/WINDOW_SATURATED/);
});
test('terminal canonical Run persists across duplicate events; its exhausted budget cannot be bypassed',async()=>{
  const f=fixture();f.run.run_attempt=3;f.state.runs.push(f.run);assert.equal((await f.service()).status,'EXHAUSTED');
  f.state.runs.push({...f.run,id:13,run_attempt:1,display_title:`Pages default-branch ${S} 13`});f.coordinator.runId++;assert.equal((await f.service()).status,'EXHAUSTED');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
test('success while disabled cannot block a later enabled site from obtaining its first deployment',async()=>{
  const f=fixture();f.state.runs.push({...f.run,conclusion:'success',display_title:`Pages  ${S} 12`});
  assert.equal((await f.service()).status,'ACCEPTED');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('a successful stale/skipped Run without a real deployment is reconciled by a fixed dispatch',async()=>{
  const f=fixture();f.state.runs.push({...f.run,conclusion:'success'});
  assert.equal((await f.service()).status,'ACCEPTED');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('native release Run matching includes exact Release ID even with identical tag and source SHA',async()=>{
  const f=fixture();Object.assign(f.source,{mode:'release',ref:'refs/tags/v1.2.3',releaseId:20,unitId:'app',manifestDigest:'d'.repeat(64)});f.source.inputDigest=pagesInputDigest(f.source);
  const run={...f.run,event:'release',head_branch:'v1.2.3',display_title:`Pages release ${S} 20`};
  f.state.runs.push(run,{...run,id:13,display_title:`Pages release ${S} 19`});
  assert.deepEqual((await pagesRunInventory(f.reader,f.workflow,f.source,Math.floor(START/1000)-30*86400,Math.floor(START/1000))).map(r=>r.id),[12]);
});
test('returning to a prior source after a newer actual site uses a new deployment context and preserves old Run budgets',async()=>{
  const f=fixture();f.run.run_attempt=3;f.state.runs.push(f.run);assert.equal((await f.service()).status,'EXHAUSTED');
  const old=structuredClone(f.records.get('maintenance/pages/12.json'));
  f.state.site={deploymentId:41,sourceSha:N,inputDigest:'f'.repeat(64),deployedAt:new Date(START+60000).toISOString()};f.state.time+=300000;f.coordinator.runId++;
  assert.equal((await f.service()).status,'ACCEPTED');assert.deepEqual(f.records.get('maintenance/pages/12.json'),old);
  assert.equal([...f.records.values()].filter(r=>r.kind==='DISPATCH').length,2);
});
