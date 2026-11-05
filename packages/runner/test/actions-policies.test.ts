import {it,expect} from 'vitest';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const module=()=>import(pathToFileURL(resolve('tools/settings-sync/actions-policies.mjs')).href);
const registration=()=>({id:7,name:'Reviewed events',source_type:'Organization',source:'splrad',enforcement:'active',
  conditions:{repository_id:{repository_ids:[12]},workflow_path:{include:['~ALL'],exclude:['.github/workflows/pr-title.yml']}},
  acceptedEvents:['push'],desiredEvents:['push','pull_request','workflow_dispatch','workflow_run','schedule','release','workflow_call']});
const registry=()=>({schemaVersion:1,organization:{login:'splrad',id:302208797},repositories:[{full_name:'splrad/fixture',id:12}],policies:[registration()]});
function fixture(){
  const row:any=registration();delete row.acceptedEvents;delete row.desiredEvents;
  const state:any={value:{...row,target:'actions',rules:[{type:'restrict_action_events',parameters:{allowed_events:['push']}},
    {type:'restrict_actions_actors',parameters:{allowed_actors:[{id:35,type:'Team'}]}}]},calls:[],loseResponse:false,loseBefore:false};
  const request=async(method:string,path:string,body?:any)=>{
    state.calls.push({method,path,body:structuredClone(body)});state.hook?.(method,path);
    if(state.denied&&path.startsWith('/repos/'))return {status:403,data:{message:'Forbidden'}};
    if(method==='GET'&&path.includes('has_parents=true'))return {status:200,data:{total_count:1,policies:[{...state.value,
      _links:{self:{href:'https://api.github.com/orgs/splrad/actions/policies/7'}}}]}};
    if(method==='GET'&&path==='/orgs/splrad/actions/policies/7')return {status:200,data:structuredClone(state.value)};
    if(method==='PUT'&&path==='/orgs/splrad/actions/policies/7'){
      if(state.loseBefore){state.loseBefore=false;throw Error('before apply');}
      Object.assign(state.value,structuredClone(body));
      if(state.loseResponse){state.loseResponse=false;throw Error('response lost');}
      return {status:200,data:structuredClone(state.value)};
    }throw Error('UNEXPECTED_POLICY_ENDPOINT');
  };
  return {state,request};
}
it('applies only a registered event rule, preserves stricter actor rules, and deduplicates the next read',async()=>{
  const {reconcileActionsPolicies}=await module(),f=fixture();const actor=structuredClone(f.state.value.rules[1]);
  const result=await reconcileActionsPolicies(f.request,registry(),true);
  expect(result.results[0].status).toBe('APPLIED');expect(f.state.value.rules[1]).toEqual(actor);
  expect(f.state.calls.find((r:any)=>r.method==='PUT').body).toEqual({rules:f.state.value.rules});
  expect((await reconcileActionsPolicies(f.request,registry(),true)).results[0].status).toBe('UNCHANGED');
  expect(f.state.calls.filter((r:any)=>r.method==='PUT')).toHaveLength(1);
});
it('reads response loss back before retry; retries only a proven unapplied difference',async()=>{
  const {reconcileActionsPolicies}=await module();
  for(const before of [false,true]){
    const f=fixture();if(before)f.state.loseBefore=true;else f.state.loseResponse=true;
    const result=await reconcileActionsPolicies(f.request,registry(),true);
    expect(result.results[0].status).toBe('APPLIED');
    expect(f.state.calls.filter((r:any)=>r.method==='PUT')).toHaveLength(before?2:1);
  }
});
it('permission denial anywhere prevents all writes and never means no policies',async()=>{
  const {reconcileActionsPolicies}=await module(),f=fixture();f.state.denied=true;
  await expect(reconcileActionsPolicies(f.request,registry(),true)).rejects.toThrow('READ_UNKNOWN');
  expect(f.state.calls.every((r:any)=>r.method==='GET')).toBe(true);
});
it('external event narrowing and path or enforcement drift are preserved',async()=>{
  const {reconcileActionsPolicies}=await module();
  for(const kind of ['events','path','enforcement']){
    const f=fixture();
    if(kind==='events')f.state.value.rules[0].parameters.allowed_events=['workflow_dispatch'];
    if(kind==='path')f.state.value.conditions.workflow_path.exclude=[];
    if(kind==='enforcement')f.state.value.enforcement='disabled';
    await expect(reconcileActionsPolicies(f.request,registry(),true)).rejects.toThrow();
    expect(f.state.calls.every((r:any)=>r.method==='GET')).toBe(true);
  }
});
it('prewrite concurrency aborts before replacing newly added actor restrictions',async()=>{
  const {reconcileActionsPolicies}=await module(),f=fixture();let reads=0;
  f.state.hook=(method:string,path:string)=>{if(method==='GET'&&path.endsWith('/policies/7')&&++reads===4)f.state.value.rules[1].parameters.allowed_actors.push({id:36,type:'Team'});};
  await expect(reconcileActionsPolicies(f.request,registry(),true)).rejects.toThrow('CONCURRENT_CHANGE');
  expect(f.state.calls.every((r:any)=>r.method==='GET')).toBe(true);
});
it('title permission requires the exact executing path and other workflows exclude that event',async()=>{
  const {validateActionsRegistry}=await module();
  const title=registry();title.policies[0]!.conditions.workflow_path={include:['.github/workflows/pr-title.yml'],exclude:[]};
  title.policies[0]!.desiredEvents=['pull_request_target'];expect(validateActionsRegistry(title)).toBe(title);
  for(const path of ['.github/workflows/*.yml','templates/repository/.github/workflows/pr-title.yml']){
    const bad=structuredClone(title);bad.policies[0]!.conditions.workflow_path.include=[path];expect(()=>validateActionsRegistry(bad)).toThrow('WORKFLOW_PATH');
  }
  const bad=registry();bad.policies[0]!.desiredEvents.push('pull_request_target');expect(()=>validateActionsRegistry(bad)).toThrow('TITLE_ONLY');
});
it('complete pagination retains inherited policy details and rejects duplicates, count drift or untrusted detail hosts',async()=>{
  const {readActionsPolicies}=await module();
  for(const mode of ['complete','duplicate','drift','host']){
    const calls:string[]=[];
    const request=async(_method:string,path:string)=>{
      calls.push(path);
      if(!path.includes('?')){const id=Number(path.split('/').at(-1));return {status:200,data:{id,name:'Parent '+id,source_type:'Enterprise',source:'fixture',enforcement:'active',target:'actions',conditions:{},rules:[]}};}
      const second=path.endsWith('page=2'),ids=second?[mode==='duplicate'?1:101]:Array.from({length:100},(_,i)=>i+1);
      return {status:200,data:{total_count:second&&mode==='drift'?102:101,policies:ids.map(id=>({id,name:'Parent '+id,source_type:'Enterprise',source:'fixture',enforcement:'active',
        _links:{self:{href:(mode==='host'?'https://untrusted.invalid':'https://api.github.com')+'/enterprises/fixture/actions/policies/'+id}}}))}};
    };
    if(mode==='complete'){expect(await readActionsPolicies(request,'/orgs/splrad')).toHaveLength(101);expect(calls).toContain('/orgs/splrad/actions/policies?has_parents=true&per_page=100&page=2');}
    else await expect(readActionsPolicies(request,'/orgs/splrad')).rejects.toThrow();
  }
});
it('NOP and no registrations never create policies; public archives contain digests without private policy names',async()=>{
  const {reconcileActionsPolicies,actionsPolicyObservations}=await module(),f=fixture();
  f.state.value.name='PRIVATE-CANARY';const r=registry();r.policies=[];
  const result=await reconcileActionsPolicies(f.request,r,true);
  expect(result.results).toEqual([]);expect(f.state.calls.every((v:any)=>v.method==='GET')).toBe(true);
  const observation=actionsPolicyObservations(result,{name:'fixture',full_name:'splrad/fixture'});
  expect(JSON.stringify(observation)).not.toContain('PRIVATE-CANARY');expect(observation.policies[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  const noop=fixture();expect((await reconcileActionsPolicies(noop.request,registry(),false)).results[0].status).toBe('PLANNED');
  expect(noop.state.calls.every((v:any)=>v.method==='GET')).toBe(true);
});
it('native inherited repository projection links preserve owner identity and reject unrelated repository paths',async()=>{
  const {readActionsPolicies}=await module();
  for(const other of [false,true]){
    const request=async(_method:string,path:string)=>{
      const value={id:7,name:'Inherited',source_type:'Organization',source:'splrad',enforcement:'active',target:'actions',conditions:{},rules:[]};
      return {status:200,data:path.includes('?')?{total_count:1,policies:[{...value,_links:{self:{href:`https://api.github.com/repos/splrad/${other?'other':'fixture'}/actions/policies/7`}}}]}:value};
    };
    if(other)await expect(readActionsPolicies(request,'/repos/splrad/fixture')).rejects.toThrow('DETAIL_SOURCE');
    else expect((await readActionsPolicies(request,'/repos/splrad/fixture'))[0].value.source_type).toBe('Organization');
  }
});
