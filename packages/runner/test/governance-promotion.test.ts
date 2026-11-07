import {expect,it,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {generateKeyPairSync} from 'node:crypto';
import YAML from 'yaml';
const module=()=>import(pathToFileURL(resolve('scripts/governance-promotion.mjs')).href);
const P='a'.repeat(40),M='b'.repeat(40),T='c'.repeat(40);
const path='.github/workflows/pr-validation-native.yml';
function source(){
  const run={id:12,run_attempt:2,workflow_id:5,path,event:'push',head_branch:'main',head_sha:M,status:'completed',conclusion:'success',repository:{id:1296724484},head_repository:{id:1296724484}};
  const workflow={id:5,path,name:'SPLRAD Steward / Native Validation',state:'active'};
  const jobs=[{id:8,run_id:12,run_attempt:1,head_sha:M,name:'Scope',status:'completed',conclusion:'success'},
    {id:9,run_id:12,run_attempt:2,head_sha:M,name:'SPLRAD Validation',status:'completed',conclusion:'success'}];
  const fixture={main:M,run,workflow,jobs,calls:[] as string[],request:async(method:string,url:string)=>{
    fixture.calls.push(method+' '+url);expect(method).toBe('GET');
    if(url.endsWith('/commits/main'))return {status:200,value:{sha:fixture.main}};
    if(url.endsWith('/actions/workflows/5'))return {status:200,value:workflow};
    if(url.includes('/actions/workflows/5/runs?'))return {status:200,value:{total_count:1,workflow_runs:[run]}};
    if(url.endsWith('/actions/runs/12'))return {status:200,value:structuredClone(run)};
    if(url.includes('/jobs?'))return {status:200,value:{total_count:jobs.length,jobs}};
    throw Error('unregistered '+url);
  }};return fixture;
}
const input={workflowId:5,event:'workflow_run',sourceRunId:12,controllerSha:M,requiredJobs:['Scope','SPLRAD Validation']};
it('accepts a scope-skipped job only with the trusted aggregate successful and keeps failures blocked',async()=>{
  const {selectPromotion}=await module(),f=source();
  f.jobs.push({...f.jobs[1]!,id:10,name:'Source linux',conclusion:'skipped'});
  const policy={...input,requiredJobs:[...input.requiredJobs,'Source linux'],skippableJobs:['Source linux']};
  expect(await selectPromotion(f,policy)).toMatchObject({status:'ELIGIBLE',jobIds:[8,9,10]});
  await expect(selectPromotion(f,{...policy,skippableJobs:[]})).rejects.toThrow('JOBS_INCOMPLETE');
  f.jobs[2]!.conclusion='failure';await expect(selectPromotion(f,policy)).rejects.toThrow('JOBS_INCOMPLETE');
  f.jobs[2]!.conclusion='skipped';f.jobs[1]!.conclusion='skipped';await expect(selectPromotion(f,policy)).rejects.toThrow('JOBS_INCOMPLETE');
  await expect(selectPromotion(f,{...policy,skippableJobs:['SPLRAD Validation']})).rejects.toThrow('SKIP_POLICY');
});
it.each(['workflow_run','schedule','workflow_dispatch'])('binds exact central native validation source and all required jobs: %s',async event=>{
  const f=source();expect(await (await module()).selectPromotion(f,{...input,event})).toMatchObject({status:'ELIGIBLE',sha:M,runId:12,runAttempt:2,jobIds:[8,9]});
});
it.each(['repository','fork','workflow','path','event','branch','attempt','missing','failed','skipped','duplicate','head'])('rejects mismatched or incomplete native validation evidence: %s',async kind=>{
  const f=source();
  if(kind==='repository')f.run.repository.id=2;if(kind==='fork')f.run.head_repository.id=2;
  if(kind==='workflow')f.run.workflow_id=6;if(kind==='path')f.run.path='other.yml';if(kind==='event')f.run.event='pull_request';
  if(kind==='branch')f.run.head_branch='other';if(kind==='attempt')f.jobs[0]!.run_attempt=3;
  if(kind==='missing')f.jobs.pop();if(kind==='failed')f.jobs[0]!.conclusion='failure';if(kind==='skipped')f.jobs[0]!.conclusion='skipped';
  if(kind==='duplicate')f.jobs.push({...f.jobs[0]!,id:10});if(kind==='head')f.jobs[0]!.head_sha=T;
  await expect((await module()).selectPromotion(f,input)).rejects.toThrow('PROMOTION_');
});
it('old main, inactive workflow and unvalidated latest main never acquire write authority',async()=>{
  const {selectPromotion}=await module();const f=source();f.main=T;expect(await selectPromotion(f,input)).toEqual({status:'STALE'});
  f.main=M;f.workflow.state='disabled_manually';expect(await selectPromotion(f,input)).toEqual({status:'DISABLED'});
  f.workflow.state='active';f.run.conclusion='failure';expect(await selectPromotion(f,input)).toEqual({status:'WAITING_VALIDATION'});
});
function rule(){return {id:18883080,name:'main',source:'splrad',source_type:'Organization',target:'branch',enforcement:'active',bypass_actors:[],
  conditions:{repository_name:{include:['~ALL'],exclude:[]},ref_name:{include:['~DEFAULT_BRANCH'],exclude:[]}},
  rules:[{type:'deletion'},{type:'pull_request',parameters:{future_platform_flag:true}},{type:'workflows',parameters:{do_not_enforce_on_create:true,workflows:[{repository_id:1296724484,path,sha:P},{repository_id:42,path:'other.yml',sha:T}]}}]};}
const shaBinding=(r:any)=>r.rules.find((v:any)=>v.type==='workflows').parameters.workflows[0];
function rulesFixture(mode='success'){
  let current=rule(),writes=0,reads=0;const records:any[]=[];
  return {records,get current(){return current;},get writes(){return writes;},record:async(r:any)=>{records.push(r);},request:async(method:string,_path:string,body:any)=>{
    if(method==='GET'){
      if(mode==='pre-change'&&++reads===2)current.conditions.repository_name.exclude.push('human' as never);
      return {status:200,value:structuredClone(current)};
    }
    expect(method).toBe('PUT');expect(Object.keys(body)).toEqual(['rules']);writes++;
    if(mode==='unchanged'&&writes===1)return {status:502};
    if(mode==='third'&&writes===1){shaBinding(current).sha=T;return {status:409};}
    current.rules=structuredClone(body.rules);
    if(mode==='external')current.conditions.repository_name.exclude.push('human' as never);
    if(mode==='lost')throw Error('lost response');
    return {status:200};
  }};
}
it.each(['success','lost','unchanged','third','pre-change'])('promotes only registered workflow SHA with native reconciliation: %s',async mode=>{
  const f=rulesFixture(mode),assertCurrent=vi.fn();const result=await (await module()).promoteRequiredWorkflow(f,M,assertCurrent,f.record);
  expect(result).toEqual({status:'ADOPTED',sha:M});expect(f.writes).toBe(['unchanged','third'].includes(mode)?2:1);
  expect(f.current.rules[1]).toEqual(rule().rules[1]);expect(f.current.rules[2]!.parameters!.workflows![1]).toEqual(rule().rules[2]!.parameters!.workflows![1]);
  if(mode==='pre-change')expect(f.current.conditions.repository_name.exclude).toEqual(['human']);
  expect(f.records.some(r=>r.kind==='rules-after')).toBe(true);
});
it('unmergeable concurrent rule change records before/after and stops; moved main cannot write',async()=>{
  const {promoteRequiredWorkflow}=await module(),f=rulesFixture('external');
  await expect(promoteRequiredWorkflow(f,M,async()=>{},f.record)).rejects.toThrow('EXTERNAL_RULE_CHANGE');expect(f.writes).toBe(1);
  const other=rulesFixture();await expect(promoteRequiredWorkflow(other,M,async()=>{throw Error('MAIN_MOVED');},other.record)).rejects.toThrow('MAIN_MOVED');expect(other.writes).toBe(0);
});
it('already adopted source is a read-only NOP',async()=>{
  const f=rulesFixture();shaBinding(f.current).sha=M;expect(await (await module()).promoteRequiredWorkflow(f,M,async()=>{},f.record)).toEqual({status:'ALREADY_ADOPTED',sha:M});expect(f.writes).toBe(0);
});
it.each(['success','lost','conflict','changed'])('template tags are create-only, exact commit bound and recover lost responses: %s',async mode=>{
  const refs:any={'refs/tags/v1.0.0':P},plan={status:'CREATE',commit:M,tag:'v1.0.1',tags:{...refs}};
  let writes=0;const io={request:async(method:string,url:string,body:any)=>{
    if(url.endsWith('matching-refs/tags/'))return {status:200,value:Object.entries(refs).map(([ref,sha])=>({ref,object:{sha,type:'commit'}}))};
    if(method==='GET'){const value=refs['refs/tags/v1.0.1'];return value?{status:200,value:{ref:'refs/tags/v1.0.1',object:{type:'commit',sha:value}}}:{status:404};}
    expect(method).toBe('POST');expect(body).toEqual({ref:'refs/tags/v1.0.1',sha:M});writes++;refs[body.ref]=M;
    if(mode==='lost')throw Error('lost');return {status:201};
  }};
  if(mode==='conflict'){refs['refs/tags/v1.0.1']=T;plan.tags={...refs};}
  if(mode==='changed')refs['refs/tags/v2.0.0']=T;
  const execute=(await module()).publishTemplateTag(io,plan,async()=>{},async()=>{});
  if(['conflict','changed'].includes(mode)){await expect(execute).rejects.toThrow('PROMOTION_');expect(writes).toBe(0);}
  else {expect(await execute).toEqual({status:'PUBLISHED',tag:'v1.0.1'});expect(writes).toBe(1);}
});
it('uses the independent Governance App, one repository, exact permissions and revokes on failure',async()=>{
  const {withGovernanceCredential}=await module(),privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}),calls:string[]=[];
  const permissions={organization_administration:'write',contents:'write',metadata:'read'};
  const transport=async(url:string,init:any)=>{
    const p=new URL(url).pathname;calls.push(init.method+' '+p);
    const data=p==='/app'?{id:765,slug:'splrad-governance'}:p==='/orgs/splrad/installation'?{id:99,app_id:765,account:{id:302208797}}:
      p==='/app/installations/99/access_tokens'?{token:'fixture',permissions}:p==='/installation/repositories'?{total_count:1,repositories:[{id:1296724484,full_name:'splrad/steward'}]}:null;
    if(p.endsWith('/access_tokens'))expect(JSON.parse(init.body)).toEqual({repository_ids:[1296724484],permissions});
    return p==='/installation/token'?new Response(null,{status:204}):new Response(JSON.stringify(data),{status:p.endsWith('/access_tokens')?201:200,headers:{'content-type':'application/json'}});
  };
  await expect(withGovernanceCredential({GOVERNANCE_APP_ID:'765',GOVERNANCE_APP_PRIVATE_KEY:privateKey},async()=>{throw Error('business failure');},transport)).rejects.toThrow('business failure');
  expect(calls.at(-1)).toBe('DELETE /installation/token');
});
it('wires trusted native validation and serialized promotion without upstream artifacts or caches',async()=>{
  const {validationJobNames}=await module(),native=YAML.parse(await readFile('.github/workflows/pr-validation-native.yml','utf8'));
  expect(validationJobNames(native)).toHaveLength(7);expect(JSON.stringify(native)).not.toMatch(/PRIVATE_KEY|environment|secrets\./);
  const promote=YAML.parse(await readFile('.github/workflows/governance-promotion.yml','utf8')),bootstrap=YAML.parse(await readFile('.github/workflows/sync-managed.yml','utf8'));
  expect(promote.on.workflow_run).toEqual({workflows:['SPLRAD Steward / Native Validation'],types:['completed'],branches:['main']});
  expect(promote.on.schedule).toEqual([{cron:'37 1 * * *'}]);expect(promote.jobs.promote.concurrency).toEqual(bootstrap.jobs.bootstrap.concurrency);
  expect(JSON.stringify(promote)).not.toMatch(/download-artifact|actions\/cache/);
  expect(promote.jobs.promote.steps.filter((s:any)=>s.env?.GOVERNANCE_APP_PRIVATE_KEY)).toHaveLength(1);
  const preflight=promote.jobs.promote.steps.find((s:any)=>s.id==='source'),write=promote.jobs.promote.steps.find((s:any)=>s.env?.GOVERNANCE_APP_PRIVATE_KEY);
  expect(preflight.run).toBe('node scripts/governance-promotion.mjs --check-source');
  expect(JSON.stringify(preflight)).not.toMatch(/PRIVATE_KEY|secrets\./);
  expect(write.if).toBe("steps.source.outputs.eligible == 'true'");
  expect(promote.jobs.promote.steps.indexOf(preflight)).toBeLessThan(promote.jobs.promote.steps.indexOf(write));
});

it.each(['eligible','failed','moved','private-key','forged-preflight'])('preflight stays read-only and privileged entry independently verifies native facts: %s',async mode=>{
  const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
  const directory=await mkdtemp(join(tmpdir(),'promotion-preflight-'));
  try {
    const api=await module(),f=source(),definition=YAML.parse(await readFile('.github/workflows/pr-validation-native.yml','utf8'));
    f.jobs.splice(0,f.jobs.length,...api.validationJobNames(definition).map((name:string,i:number)=>({id:100+i,run_id:12,run_attempt:2,head_sha:M,name,status:'completed',conclusion:'success'})));
    const env:any={GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',GITHUB_REF:'refs/heads/main',STEWARD_CONTROLLER_SHA:M,GITHUB_RUN_ID:'50',GITHUB_EVENT_NAME:'workflow_run',SOURCE_VALIDATION_RUN_ID:'12',NATIVE_VALIDATION_WORKFLOW_ID:'5',GITHUB_TOKEN:'read-only-fixture',GITHUB_OUTPUT:join(directory,'output'),PROMOTION_EVIDENCE_DIRECTORY:directory};
    const transport=async(url:string,init:any)=>{expect(init.method).toBe('GET');const u=new URL(url),r=await f.request(init.method,u.pathname+u.search);return Response.json(r.value,{status:r.status});};
    if(mode==='failed')f.run.conclusion='failure';if(['moved','forged-preflight'].includes(mode))f.main=T;
    if(mode==='private-key'){
      env.GOVERNANCE_APP_PRIVATE_KEY='must-not-enter-preflight';
      await expect(api.preflight(env,transport)).rejects.toThrow('PREFLIGHT_PRIVILEGE');expect(f.calls).toEqual([]);return;
    }
    if(mode==='forged-preflight'){
      await writeFile(join(directory,'source-preflight.json'),JSON.stringify({status:'ELIGIBLE',sha:M}));
      await api.main({...env,GOVERNANCE_APP_PRIVATE_KEY:'must-not-be-used'},transport);
      expect(await readFile(join(directory,'observations.jsonl'),'utf8')).toContain('STALE');
      expect(f.calls.every(c=>c.startsWith('GET '))).toBe(true);return;
    }
    const result=await api.preflight(env,transport);
    expect(result.status).toBe(mode==='eligible'?'ELIGIBLE':mode==='failed'?'WAITING_VALIDATION':'STALE');
    expect(await readFile(env.GITHUB_OUTPUT,'utf8')).toBe(`eligible=${mode==='eligible'}\n`);
    expect(JSON.parse(await readFile(join(directory,'source-preflight.json'),'utf8'))).toEqual(result);
  }finally{await rm(directory,{recursive:true,force:true});}
});
it('publishes one fixed template wake only after a new tag; unknown responses never retry',async()=>{
  const {wakePublishedTemplate}=await module();
  for(const status of ['UNCHANGED','ALREADY_PUBLISHED']){
    let writes=0;await wakePublishedTemplate({request:async()=>{writes++;}},{status},async()=>{},async()=>{});expect(writes).toBe(0);
  }
  const calls:any[]=[],records:any[]=[];let checked=0;
  await wakePublishedTemplate({request:async(...args:any[])=>{calls.push(args);return {status:204};}},{status:'PUBLISHED'},async()=>{checked++;},async(value:any)=>records.push(value));
  expect(checked).toBe(1);expect(calls).toEqual([['POST','/repos/splrad/steward/dispatches',{event_type:'steward-template-event',client_payload:{schemaVersion:1}}]]);
  expect(records).toEqual([{kind:'template-wake',status:'ACCEPTED'}]);
  let attempts=0;await expect(wakePublishedTemplate({request:async()=>{attempts++;throw Error('lost');}},{status:'PUBLISHED'},async()=>{},async()=>{})).rejects.toThrow('lost');expect(attempts).toBe(1);
  await expect(wakePublishedTemplate({request:async()=>{throw Error('must not write');}},{status:'PUBLISHED'},async()=>{throw Error('main moved');},async()=>{})).rejects.toThrow('main moved');
});
