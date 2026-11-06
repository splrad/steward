import {expect,it} from 'vitest';
import {bootstrapRepository,bootstrapRulePolicyDigest,bootstrapVariable,decodeBootstrapRecovery} from '../src/repository-bootstrap.js';

function fixture() {
  const repository={id:12,name:'fixture',full_name:'splrad/fixture',default_branch:'develop',archived:false,disabled:false};
  const source={workflowId:42,runId:21,runAttempt:1,controllerSha:'a'.repeat(40)};
  const rules:any={7:{id:7,name:'Reviewed default branch',source_type:'Organization',source:'splrad',target:'branch',enforcement:'active',bypass_actors:[],
    conditions:{repository_name:{include:['~ALL'],exclude:['already-other'],protected:false},ref_name:{include:['~DEFAULT_BRANCH'],exclude:[]}},rules:[{type:'pull_request'}]}};
  const bindings=[{ruleId:7,policyDigest:bootstrapRulePolicyDigest(rules[7])}];
  const state:any={variable:null,refs:[],commits:[],files:{},writes:[],archives:[],sourceChecks:[],lose:new Set(),fail:new Set(),hook:null};
  const identity={name:'fixture[bot]',id:33,email:'33+fixture[bot]@users.noreply.github.com'};
  const io={async request(method:string,path:string,body?:any):Promise<{status:number;value:any}> {
    state.hook?.(method,path,body);const key=method+' '+path;
    if(state.fail.has(key))throw Error('transport');
    if(method!=='GET')state.writes.push({method,path,body:structuredClone(body)});
    let value:any=null,status=200;
    if(path==='/repos/splrad/fixture')value={...repository,owner:{id:302208797}};
    else if(path==='/repos/splrad/fixture/actions/variables'&&method==='POST') {if(state.variable!==null)return {status:409,value:{}};state.variable=body.value;status=201;}
    else if(path.endsWith('/actions/variables/'+bootstrapVariable)) {
      if(method==='GET') {status=state.variable===null?404:200;value=state.variable===null?{}:{name:bootstrapVariable,value:state.variable};}
      if(method==='PATCH')state.variable=body.value;
      if(method==='DELETE')state.variable=null;
    } else if(path==='/repos/splrad/fixture/git/matching-refs/')value=state.refs;
    else if(path.startsWith('/orgs/splrad/rulesets/')) {
      const id=Number(path.split('/').at(-1));if(!rules[id])return {status:404,value:{}};
      if(method==='PUT') {expect(Object.keys(body)).toEqual(['conditions']);rules[id].conditions=structuredClone(body.conditions);}
      value=rules[id];
    } else if(path==='/repos/splrad/fixture/contents/README.md'&&method==='PUT') {
      expect(state.variable).not.toBeNull();expect(JSON.parse(state.variable).phase).toBe('TEMP_EXCLUDED');expect(state.refs).toEqual([]);
      expect(body.branch).toBe('develop');expect(body).not.toHaveProperty('author');expect(body).not.toHaveProperty('committer');
      state.refs=[{ref:'refs/heads/develop',object:{sha:'b'.repeat(40)}}];
      state.commits=[{sha:'b'.repeat(40),parents:[],author:{id:33},commit:{message:body.message}}];
      state.files['b'.repeat(40)]={encoding:'base64',content:body.content};status=201;
    } else if(path.startsWith('/repos/splrad/fixture/commits?'))value=state.commits;
    else if(path.startsWith('/repos/splrad/fixture/commits/'))value=state.commits.find((c:any)=>path.endsWith(c.sha));
    else if(path.startsWith('/repos/splrad/fixture/contents/README.md?ref=')) {value=state.files[path.split('=')[1]!];status=value?200:404;}
    else throw Error('unexpected '+key);
    if(state.lose.delete(key))throw Error('response lost');return {status,value:structuredClone(value)};
  }};
  const services={identity,now:()=>new Date('2026-10-29T00:00:00Z').toISOString(),
    async verifySource(s:any){state.sourceChecks.push(s);if(state.badSource)throw Error('bad source');},
    async verifyProtection(){expect(rules[7].conditions.repository_name.exclude).not.toContain('fixture');if(state.badProtection)throw Error('protection');},
    async archive(record:any,origin:any){if(state.badArchive)throw Error('archive');state.archives.push({record,origin});return 'c'.repeat(40);}};
  return {repository,source,rules,bindings,state,io,services,run:()=>bootstrapRepository(repository,source,bindings,io,services)};
}

it('creates durable recovery before a narrow exclusion, then Contents first commit, restore, archive and delete',async()=>{
  const f=fixture();expect(await f.run()).toEqual({status:'READY',firstCommitSha:'b'.repeat(40),origin:'app',archive:'c'.repeat(40)});
  expect(f.state.variable).toBeNull();expect(f.rules[7].conditions.repository_name.exclude).toEqual(['already-other']);
  expect(f.state.writes[0].path).toMatch(/actions\/variables$/);expect(f.state.archives[0].record.phase).toBe('RESTORED');
  expect(f.state.writes.filter((w:any)=>w.path.includes('/git/refs'))).toEqual([]);
  expect(await f.run()).toEqual({status:'EXISTING'});expect(f.state.archives).toHaveLength(1);
});
it('binds required workflow to the verified controller while retaining every other rule-policy field',async()=>{
  const f=fixture(),rule=f.rules[7];
  rule.rules.push({type:'workflows',parameters:{do_not_enforce_on_create:true,workflows:[{repository_id:1296724484,path:'.github/workflows/pr-validation-native.yml',sha:f.source.controllerSha}]}});
  const policy=bootstrapRulePolicyDigest(rule,f.source.controllerSha);
  Object.assign(f.bindings[0]!,{policyDigest:policy,controllerWorkflow:true});
  expect((await f.run()).status).toBe('READY');
  const updated=structuredClone(rule);updated.rules[1].parameters.workflows[0].sha='d'.repeat(40);
  expect(bootstrapRulePolicyDigest(updated,'d'.repeat(40))).toBe(policy);
  expect(()=>bootstrapRulePolicyDigest(updated,f.source.controllerSha)).toThrow('CONTROLLER_WORKFLOW');
  updated.rules[0].type='deletion';expect(bootstrapRulePolicyDigest(updated,'d'.repeat(40))).not.toBe(policy);
  updated.rules[1].parameters.workflows[0].repository_id=999;expect(()=>bootstrapRulePolicyDigest(updated,'d'.repeat(40))).toThrow();
});
it('refuses a foreign required workflow pin before recovery or rule writes',async()=>{
  const f=fixture();f.rules[7].rules.push({type:'workflows',parameters:{workflows:[{repository_id:1296724484,path:'.github/workflows/pr-validation-native.yml',sha:f.source.controllerSha}]}});
  Object.assign(f.bindings[0]!,{policyDigest:bootstrapRulePolicyDigest(f.rules[7],f.source.controllerSha),controllerWorkflow:true});
  f.rules[7].rules[1].parameters.workflows[0].sha='e'.repeat(40);
  await expect(f.run()).rejects.toThrow('CONTROLLER_WORKFLOW');expect(f.state.writes).toEqual([]);
});
it('resumes recorded recovery after trusted controller promotion without changing rule responsibility',async()=>{
  const f=fixture();f.rules[7].rules.push({type:'workflows',parameters:{workflows:[{repository_id:1296724484,path:'.github/workflows/pr-validation-native.yml',sha:f.source.controllerSha}]}});
  Object.assign(f.bindings[0]!,{policyDigest:bootstrapRulePolicyDigest(f.rules[7],f.source.controllerSha),controllerWorkflow:true});
  f.state.badArchive=true;await expect(f.run()).rejects.toThrow();expect(f.state.variable).not.toBeNull();
  const oldSource=JSON.parse(f.state.variable).controllerSha;
  f.source.controllerSha='d'.repeat(40);f.rules[7].rules[1].parameters.workflows[0].sha=f.source.controllerSha;
  f.state.badArchive=false;expect((await f.run()).status).toBe('READY');
  expect(f.state.sourceChecks.some((s:any)=>s.controllerSha===oldSource)).toBe(true);
  expect(f.state.variable).toBeNull();expect(f.state.commits).toHaveLength(1);
});
for(const lost of ['POST /repos/splrad/fixture/actions/variables','PATCH /repos/splrad/fixture/actions/variables/'+bootstrapVariable,
  'PUT /orgs/splrad/rulesets/7','PUT /repos/splrad/fixture/contents/README.md','DELETE /repos/splrad/fixture/actions/variables/'+bootstrapVariable])
  it('recovers native lost response: '+lost,async()=>{const f=fixture();f.state.lose.add(lost);expect((await f.run()).status).toBe('READY');expect(f.state.variable).toBeNull();});
it('never relaxes protection when recovery cannot be written or read',async()=>{
  for(const failure of ['POST /repos/splrad/fixture/actions/variables','GET /repos/splrad/fixture/actions/variables/'+bootstrapVariable]) {
    const f=fixture();f.state.fail.add(failure);await expect(f.run()).rejects.toThrow();expect(f.state.writes.some((w:any)=>w.path.includes('/rulesets/'))).toBe(false);
  }
});
it('retains unknown, oversized, cross-repository and unregistered-rule records without mutation',async()=>{
  const base=fixture();base.state.badArchive=true;await expect(base.run()).rejects.toThrow();const valid=base.state.variable;
  for(const raw of ['invalid', ' '.repeat(32769),JSON.stringify({...JSON.parse(valid),repositoryId:13}),JSON.stringify({...JSON.parse(valid),unknown:true}),
    JSON.stringify({...JSON.parse(valid),affectedRules:[{...JSON.parse(valid).affectedRules[0],ruleId:99}]})]) {
    const f=fixture();f.state.variable=raw;await expect(f.run()).rejects.toThrow();expect(f.state.writes).toEqual([]);expect(f.state.variable).toBe(raw);
  }
  expect(()=>decodeBootstrapRecovery(valid,base.repository)).not.toThrow();
});
it('restores after Contents failure and retries from the same variable on the next wake',async()=>{
  const f=fixture();f.state.fail.add('PUT /repos/splrad/fixture/contents/README.md');await expect(f.run()).rejects.toThrow();
  expect(f.rules[7].conditions.repository_name.exclude).toEqual(['already-other']);expect(JSON.parse(f.state.variable).phase).toBe('RESTORED');
  f.state.fail.clear();expect((await f.run()).status).toBe('READY');
});
it('resumes after first commit even if restore failed and never creates a second commit',async()=>{
  const f=fixture();f.state.hook=(method:string,path:string,body:any)=>{
    if(method==='PUT'&&path.includes('/rulesets/')&&!body.conditions.repository_name.exclude.includes('fixture'))throw Error('restore down');
  };
  await expect(f.run()).rejects.toThrow('RESTORE_INCOMPLETE');expect(f.state.refs).toHaveLength(1);expect(f.state.variable).not.toBeNull();
  f.state.hook=null;expect((await f.run()).status).toBe('READY');
  expect(f.state.writes.filter((w:any)=>w.path.endsWith('/contents/README.md'))).toHaveLength(1);
});
it('keeps concurrent other exclusions and existing exclusions while restoring only its own exact name',async()=>{
  const f=fixture();f.state.hook=(method:string,path:string)=>{
    if(method==='PUT'&&path.endsWith('/contents/README.md'))f.rules[7].conditions.repository_name.exclude.push('another-private-repository');
  };
  expect((await f.run()).status).toBe('READY');expect(f.rules[7].conditions.repository_name.exclude).toEqual(['already-other','another-private-repository']);
  expect(JSON.stringify(f.state.archives)).not.toContain('another-private-repository');
  const g=fixture();g.rules[7].conditions.repository_name.exclude.push('fixture');g.services.verifyProtection=async()=>{};
  expect((await g.run()).status).toBe('READY');expect(g.state.writes.some((w:any)=>w.path.includes('/rulesets/'))).toBe(false);
  expect(g.rules[7].conditions.repository_name.exclude).toContain('fixture');
});
it('preserves an external first commit and records external origin instead of overwriting README',async()=>{
  const f=fixture();let injected=false;
  f.state.hook=(method:string,path:string)=>{
    if(!injected&&method==='GET'&&path.endsWith('/git/matching-refs/')&&f.state.variable&&JSON.parse(f.state.variable).phase==='TEMP_EXCLUDED') {
      injected=true;f.state.refs=[{ref:'refs/heads/develop',object:{sha:'d'.repeat(40)}}];
      f.state.commits=[{sha:'d'.repeat(40),parents:[],author:{id:55},commit:{message:'human first'}}];
    }
  };
  expect((await f.run()).origin).toBe('external');expect(f.state.writes.some((w:any)=>w.path.includes('/contents/'))).toBe(false);
});
it('keeps recovery after archive/protection failure and completes a new wake without reinitializing',async()=>{
  for(const flag of ['badArchive','badProtection']) {
    const f=fixture();f.state[flag]=true;await expect(f.run()).rejects.toThrow();expect(JSON.parse(f.state.variable).phase).toBe('RESTORED');
    f.state[flag]=false;expect((await f.run()).status).toBe('READY');expect(f.state.writes.filter((w:any)=>w.path.endsWith('/contents/README.md'))).toHaveLength(1);
  }
});
it('rejects rule policy drift and concurrent variable replacement',async()=>{
  const f=fixture();f.rules[7].bypass_actors.push({actor_id:5});await expect(f.run()).rejects.toThrow('RULE_POLICY_CHANGED');expect(f.state.writes).toEqual([]);
  const g=fixture();g.state.hook=(method:string,path:string)=>{if(method==='PUT'&&path.endsWith('/contents/README.md'))g.state.variable='external replacement';};
  await expect(g.run()).rejects.toThrow();expect(g.state.variable).toBe('external replacement');expect(g.state.archives).toEqual([]);
});
it('recovers PREPARED after a rule write but before its variable update before initializing',async()=>{
  const f=fixture();let first=true;
  f.state.hook=(method:string,path:string,body:any)=>{
    if(first&&method==='PATCH'&&body.value&&JSON.parse(body.value).affectedRules[0].lastWrittenConditionsDigest) {
      first=false;f.state.fail.add('GET /repos/splrad/fixture/actions/variables/'+bootstrapVariable);
      throw Error('process unavailable');
    }
  };
  await expect(f.run()).rejects.toThrow();f.state.hook=null;f.state.fail.clear();
  expect((await f.run()).status).toBe('READY');expect(f.rules[7].conditions.repository_name.exclude).not.toContain('fixture');
});

it('preserves unrelated required workflows in the policy digest and rejects duplicate controller bindings',()=>{
  const f=fixture(),rule=f.rules[7];
  const workflows=[{repository_id:1296724484,path:'.github/workflows/pr-validation-native.yml',sha:f.source.controllerSha},{repository_id:123,path:'.github/workflows/other.yml',sha:'b'.repeat(40)}];
  rule.rules.push({type:'workflows',parameters:{workflows}});
  const before=bootstrapRulePolicyDigest(rule,f.source.controllerSha);
  workflows[1]!.sha='c'.repeat(40);expect(bootstrapRulePolicyDigest(rule,f.source.controllerSha)).not.toBe(before);
  workflows.push({...workflows[0]!});expect(()=>bootstrapRulePolicyDigest(rule,f.source.controllerSha)).toThrow('CONTROLLER_WORKFLOW');
});
it('rejects a visibility change before any bootstrap writes',async()=>{
  const f=fixture();Object.assign(f.services,{requirePrivate:true});
  await expect(f.run()).rejects.toThrow('TARGET_CHANGED');expect(f.state.writes).toEqual([]);
});
