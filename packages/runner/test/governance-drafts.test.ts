import {expect,it} from 'vitest';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const module=()=>import(pathToFileURL(resolve('scripts/prepare-governance.mjs')).href);
function snapshot():any {return {
  policySha:'a'.repeat(40),
  base:{id:18883080,name:'SPLRAD Default Branch',source:'splrad',source_type:'Organization',target:'branch',bypass_actors:[{actor_type:'OrganizationAdmin',bypass_mode:'always'}],rules:[
    {type:'required_signatures'},
    {type:'pull_request',parameters:{required_approving_review_count:2}},
    {type:'required_status_checks',parameters:{required_status_checks:[{context:'existing-check',integration_id:9}]}},
    {type:'workflows',parameters:{workflows:[{repository_id:1296724484,path:'.github/workflows/pr-validation-native.yml',ref:'main'},{repository_id:1,path:'.github/workflows/other.yml',sha:'b'.repeat(40)}]}}
  ]},
  team:{id:91,slug:'primary-account-approval-exception',organization:{id:302208797}},members:[{id:44151430,login:'axiomoth',type:'User'}],
  governanceApp:{id:92,slug:'splrad-governance'},installation:{id:93,app_id:92,account:{id:302208797},repository_selection:'all',suspended_at:null},
  validationCheck:{name:'SPLRAD Validation',head_sha:'a'.repeat(40),status:'completed',conclusion:'success',app:{id:15368,slug:'github-actions'}}
};}
function effective(drafts:any) {return [
  {...drafts.foundation,id:18883080,source:'splrad',source_type:'Organization'},
  {...drafts.independent,id:2,source:'splrad',source_type:'Organization'}
];}
it('separates the sole approval exception from non-bypassable default-branch protections and preserves unrelated consumers',async()=>{
  const {prepareGovernance,assertApprovalUnion}=await module(),input=snapshot(),original=structuredClone(input),d=prepareGovernance(input);
  expect(input).toEqual(original);expect(d.foundation.bypass_actors).toEqual([]);
  expect(d.foundation.conditions).toEqual({repository_name:{include:['~ALL'],exclude:[],protected:false},ref_name:{include:['~DEFAULT_BRANCH'],exclude:[]}});
  expect(d.foundation.rules).toContainEqual({type:'required_signatures'});
  expect(d.foundation.rules.find((r:any)=>r.type==='pull_request').parameters).toMatchObject({required_approving_review_count:0,required_review_thread_resolution:true,required_reviewers:[],require_code_owner_review:false,require_last_push_approval:false,require_extra_approval_for_unattributed_changes:false});
  expect(d.independent.rules).toHaveLength(1);expect(d.independent.rules[0].parameters).toMatchObject({required_approving_review_count:1,required_review_thread_resolution:false});
  expect(d.independent.bypass_actors).toEqual([{actor_id:91,actor_type:'Team',bypass_mode:'pull_request'}]);
  expect(d.foundation.rules.find((r:any)=>r.type==='required_status_checks').parameters.required_status_checks).toEqual([{context:'existing-check',integration_id:9},{context:'SPLRAD Validation',integration_id:15368},{context:'SPLRAD PR Title',integration_id:15368}]);
  const workflows=d.foundation.rules.find((r:any)=>r.type==='workflows').parameters;
  expect(workflows.do_not_enforce_on_create).toBe(true);expect(workflows.workflows[0]).toEqual({repository_id:1296724484,path:'.github/workflows/pr-validation-native.yml',sha:input.policySha});
  expect(workflows.workflows[1]).toEqual(input.base.rules.at(-1).parameters.workflows[1]);
  expect(()=>assertApprovalUnion(effective(d),null,91)).not.toThrow();
});
it.each([
  ['extra team member',(s:any)=>s.members.push({id:5,login:'other',type:'User'})],
  ['wrong author identity',(s:any)=>s.members[0].id=5],
  ['wrong team organization',(s:any)=>s.team.organization.id=5],
  ['shared governance identity',(s:any)=>s.governanceApp.id=4243096],
  ['selected installation',(s:any)=>s.installation.repository_selection='selected'],
  ['suspended installation',(s:any)=>s.installation.suspended_at='2026-01-01'],
  ['unverified check source',(s:any)=>s.validationCheck.head_sha='b'.repeat(40)],
  ['unsuccessful check',(s:any)=>s.validationCheck.conclusion='failure'],
  ['ambiguous PR rules',(s:any)=>s.base.rules.push({type:'pull_request',parameters:{}})],
  ['conflicting check writer',(s:any)=>s.base.rules[2].parameters.required_status_checks.push({context:'SPLRAD Validation',integration_id:5})],
])('rejects unverified inputs: %s',async(_name,mutate)=>{const {prepareGovernance}=await module(),s=snapshot();(mutate as any)(s);expect(()=>prepareGovernance(s)).toThrow();});
it('consolidates equal runtime constraints into five rules while preserving their exact scopes and actors',async()=>{
  const {prepareGovernance}=await module(),d=prepareGovernance(snapshot());expect(d.runtime).toHaveLength(5);
  const named=(name:string)=>d.runtime.find((r:any)=>r.name===name);
  for(const r of d.runtime) {
    expect(r.conditions.repository_name).toEqual({include:['~ALL'],exclude:[],protected:false});
    if(r.name.endsWith('-integrity')||r.name.endsWith('-immutable'))expect(r.bypass_actors).toEqual([]);
    else expect(r.rules.every((rule:any)=>['creation','update'].includes(rule.type))).toBe(true);
  }
  expect(named('steward-build-immutable').rules).toEqual([{type:'update',parameters:{update_allows_fetch_and_merge:false}},{type:'deletion'}]);
  expect(named('steward-governance-writer').bypass_actors.map((a:any)=>a.actor_id)).toEqual([4243096,92]);
  expect(named('steward-ref-creator').conditions.ref_name.include).toEqual(['refs/heads/steward/build/*','refs/heads/steward/managed-sync','refs/heads/steward/release-candidate']);
  expect(named('steward-ref-integrity').conditions.ref_name.include).toEqual(['refs/heads/steward/release-state','refs/heads/steward/automation-health','refs/heads/steward/governance-state','refs/heads/steward/managed-sync','refs/heads/steward/release-candidate']);
});
// This finite configuration comparison checks the request bodies, not GitHub enforcement.
it.each([
  ['steward/release-state',[4243096],[4243096]],
  ['steward/automation-health',[4243096],[4243096]],
  ['steward/governance-state',[4243096,92],[4243096,92]],
  ['steward/managed-sync',[4243096],[4243096,92,7,8]],
  ['steward/release-candidate',[4243096],[4243096,92,7,8]],
  ['steward/build/cycle-1',[4243096],[]],
])('keeps per-actor create/update/force/delete constraints for %s',async(branch,creators,writers)=>{
  const {prepareGovernance}=await module(),{runtime}=prepareGovernance(snapshot());
  const ref=`refs/heads/${branch}`;
  const applicable=runtime.filter((r:any)=>r.conditions.ref_name.include.some((pattern:string)=>pattern.endsWith('/*')?ref.startsWith(pattern.slice(0,-1)):ref===pattern));
  const allowed=(operation:string,actorId:number)=>!applicable.some((r:any)=>r.rules.some((entry:any)=>entry.type===operation)
    && !r.bypass_actors.some((entry:any)=>entry.actor_type==='Integration'&&entry.actor_id===actorId&&entry.bypass_mode==='always'));
  for(const actorId of [4243096,92,7,8]) {
    expect(allowed('creation',actorId)).toBe((creators as number[]).includes(actorId));
    expect(allowed('update',actorId)).toBe((writers as number[]).includes(actorId));
    expect(allowed('deletion',actorId)).toBe(false);
    // Build refs reject every update, including non-fast-forward writes.
    expect(allowed('update',actorId)&&allowed('non_fast_forward',actorId)).toBe(false);
  }
});
it('keeps runtime constraints off default and unrelated branches',async()=>{
  const {prepareGovernance}=await module(),{runtime}=prepareGovernance(snapshot());
  for(const branch of ['main','feature/next','steward/build-other','steward/governance-state-other'])
    expect(runtime.some((r:any)=>r.conditions.ref_name.include.some((p:string)=>p.endsWith('/*')?`refs/heads/${branch}`.startsWith(p.slice(0,-1)):p===`refs/heads/${branch}`))).toBe(false);
});
it.each(['steward/release-state','steward/automation-health','steward/build/cycle-1'])('connects consolidated request bodies to the actual writer protection reader: %s',async branch=>{
  const {prepareGovernance}=await module();
  const {assertReleaseWriterProtection}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
  const all=prepareGovernance(snapshot()).runtime.map((rule:any,index:number)=>({...rule,id:700+index,name:`observed-${index}`}));
  const relevant=all.filter((r:any)=>r.conditions.ref_name.include.some((p:string)=>p.endsWith('/*')?`refs/heads/${branch}`.startsWith(p.slice(0,-1)):p===`refs/heads/${branch}`));
  const io={request:async(method:string,path:string)=>{
    expect(method).toBe('GET');
    const value=path.includes('/rules/branches/')?relevant.flatMap((r:any)=>r.rules.map((rule:any)=>({...rule,ruleset_id:r.id}))):all.find((r:any)=>path.endsWith(`/rulesets/${r.id}`));
    if(!value)throw Error('unexpected protection read '+path);
    return {status:200,headers:new Headers(),bytes:Buffer.from(JSON.stringify(value))};
  }};
  await expect(assertReleaseWriterProtection('example/product',branch,io)).resolves.toBeUndefined();
  const immutable=relevant.find((r:any)=>r.rules.some((rule:any)=>rule.type==='deletion'));
  immutable.bypass_actors=[{actor_type:'Integration',actor_id:4243096,bypass_mode:'always'}];
  await expect(assertReleaseWriterProtection('example/product',branch,io)).rejects.toThrow('writer integrity bypass');
});
it('scopes observed legacy branches to the exact native repository and rejects glob/path expansion',async()=>{
  const {prepareGovernance}=await module(),s=snapshot();s.legacyCandidates=[{repositoryId:15,branch:'release-please--branches--main'}];
  const result=prepareGovernance(s);expect(result.legacy).toHaveLength(2);
  expect(result.legacy[0].conditions).toEqual({repository_id:{repository_ids:[15]},ref_name:{include:['refs/heads/release-please--branches--main'],exclude:[]}});
  for(const branch of ['*','x/../y','x//y','x.lock','steward/release-candidate']) {s.legacyCandidates[0].branch=branch;expect(()=>prepareGovernance(s)).toThrow('LEGACY_BRANCH');}
});
it.each(['codeowners','last-push','extra-review','required-reviewers','other-ruleset','legacy','legacy-unknown','base-bypass','team-bypass','base-missing','approval-missing','threads','merge','scope'])('rejects effective approval conflicts: %s',async(kind)=>{
  const {prepareGovernance,assertApprovalUnion}=await module(),e=effective(prepareGovernance(snapshot()));let protection:any=null;
  const p=e[0].rules.find((r:any)=>r.type==='pull_request').parameters;
  if(kind==='codeowners')p.require_code_owner_review=true;
  if(kind==='last-push')p.require_last_push_approval=true;
  if(kind==='extra-review')p.require_extra_approval_for_unattributed_changes=true;
  if(kind==='required-reviewers')p.required_reviewers=[{reviewer:{id:9,type:'Team'},minimum_approvals:1}];
  if(kind==='other-ruleset')e.push({...e[0],id:3,source_type:'Repository',rules:[{type:'pull_request',parameters:{...p,required_approving_review_count:1}}]});
  if(kind==='legacy')protection={required_pull_request_reviews:{required_approving_review_count:1,require_code_owner_reviews:false,require_last_push_approval:false}};
  if(kind==='legacy-unknown')protection=undefined;
  if(kind==='base-bypass')e[0].bypass_actors=e[1].bypass_actors;
  if(kind==='team-bypass')e[1].bypass_actors[0].bypass_mode='always';
  if(kind==='base-missing')e.shift();
  if(kind==='approval-missing')e[1].rules=[];
  if(kind==='threads')e[1].rules[0].parameters.required_review_thread_resolution=true;
  if(kind==='merge')p.allowed_merge_methods=['merge'];
  if(kind==='scope')e[0].conditions.ref_name.exclude=['refs/heads/main'];
  expect(()=>assertApprovalUnion(e,protection,91)).toThrow();
});
