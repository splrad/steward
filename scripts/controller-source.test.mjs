import {test} from 'node:test';
import assert from 'node:assert/strict';
import {controllerSource,verifySourceProtection,assertSourceProtection,publishControllerSource,createSourceGuard} from './controller-source.mjs';
import {publishTemplateTag,promoteRequiredWorkflow} from './governance-promotion.mjs';
const old='1'.repeat(40),target='2'.repeat(40),other='3'.repeat(40),app=123;
const ref=s=>({ref:`refs/heads/${controllerSource}`,object:{type:'commit',sha:s}});
function protection(){return [
  {id:1,name:'validated-controller-source',target:'branch',source:'splrad',source_type:'Organization',enforcement:'active',conditions:{repository_id:{repository_ids:[1296724484]},ref_name:{include:[`refs/heads/${controllerSource}`],exclude:[]}},bypass_actors:[{actor_id:app,actor_type:'Integration',bypass_mode:'always'}],rules:['creation','update'].map(type=>type==='update'?{type,parameters:{update_allows_fetch_and_merge:false}}:{type})},
  {id:2,name:'validated-controller-no-tag',target:'tag',source:'splrad',source_type:'Organization',enforcement:'active',conditions:{repository_id:{repository_ids:[1296724484]},ref_name:{include:[`refs/tags/${controllerSource}`],exclude:[]}},bypass_actors:[],rules:['creation','update','deletion'].map(type=>type==='update'?{type,parameters:{update_allows_fetch_and_merge:false}}:{type})},
  {id:3,name:'validated-controller-integrity',target:'branch',source:'splrad',source_type:'Organization',enforcement:'active',conditions:{repository_id:{repository_ids:[1296724484]},ref_name:{include:[`refs/heads/${controllerSource}`],exclude:[]}},bypass_actors:[],rules:['deletion','non_fast_forward'].map(type=>type==='update'?{type,parameters:{update_allows_fetch_and_merge:false}}:{type})},
];}
function fixture(options={}){
  let current=options.absent?null:ref(options.initial??old),reads=0,guards=0;
  const rules=options.rules??protection(),writes=[],records=[];
  const io={async request(method,path,body){
    if(method==='GET'){
      if(path.includes('/rulesets?'))return {status:200,value:rules.map(({id,name})=>({id,name}))};
      if(path.endsWith('/rulesets/1'))return {status:200,value:rules[0]};
      if(path.endsWith('/rulesets/2'))return {status:200,value:rules[1]};
      if(path.endsWith('/rulesets/3'))return {status:200,value:rules[2]};
      if(path.includes('/git/ref/tags/'))return {status:options.tag?200:404,value:{}};
      if(path.includes('/compare/'))return {status:200,value:{status:options.diverged?'diverged':'ahead',base_commit:{sha:old},merge_base_commit:{sha:options.diverged?other:old}}};
      if(path.includes('/git/ref/heads/')){
        reads++;if(options.race&&reads===2)current=ref(other);
        return {status:current?200:404,value:current};
      }
    }
    writes.push({method,path,body});
    if(!options.noEffect)current=ref(target);
    if(options.lost)throw Error('response lost');
    return {status:options.absent?201:200};
  }};
  return {io,writes,records,run:()=>publishControllerSource(io,target,app,async()=>{guards++;if(options.mainMoved&&guards>=2)throw Error('MAIN_MOVED');},async r=>records.push(r))};
}

test('rechecks protection when a later promotion operation invokes its guard',async()=>{
  const rules=protection(),f=fixture({rules});let mainReads=0;
  const guard=createSourceGuard(f.io,app,async()=>{mainReads++;});
  await guard();rules[0].enforcement='disabled';
  await assert.rejects(guard(),/RULE_IDENTITY/);
  assert.equal(mainReads,2);assert.equal(f.writes.length,0);
});

test('protection removed after an unconfirmed pin write blocks its retry',async()=>{
  const rules=protection(),f=fixture({rules});let writes=0;
  const rule={id:18883080,source:'splrad',source_type:'Organization',target:'branch',enforcement:'active',name:'core',bypass_actors:[],conditions:{ref_name:{include:['~DEFAULT_BRANCH'],exclude:[]}},rules:[{type:'workflows',parameters:{workflows:[{repository_id:1296724484,path:'.github/workflows/pr-validation-native.yml',sha:old}]}}]};
  const io={async request(method,path,body){
    if(path==='/orgs/splrad/rulesets/18883080'){
      if(method==='GET')return {status:200,value:structuredClone(rule)};
      writes++;rules[0].enforcement='disabled';return {status:502};
    }
    return f.io.request(method,path,body);
  }};
  const guard=createSourceGuard(io,app,async()=>{}),records=[];
  await guard();
  await assert.rejects(promoteRequiredWorkflow(io,target,guard,async r=>records.push(r)),/RULE_IDENTITY/);
  assert.equal(writes,1);assert.ok(records.some(r=>r.kind==='rules-after'));
});

test('protection widened after initial preflight prevents template tag creation',async()=>{
  const rules=protection(),f=fixture({rules});let writes=0;
  const io={async request(method,path,body){
    if(path.endsWith('/git/matching-refs/tags/'))return {status:200,value:[]};
    if(path.endsWith('/git/ref/tags/v1.0.0')){rules[0].conditions.repository_id.repository_ids.push(1);return {status:404};}
    if(method==='POST'){writes++;return {status:201};}
    return f.io.request(method,path,body);
  }};
  const guard=createSourceGuard(io,app,async()=>{});await guard();
  await assert.rejects(publishTemplateTag(io,{status:'CREATE',commit:target,tag:'v1.0.0',tags:{}},guard,async()=>{}),/RULE_SCOPE/);
  assert.equal(writes,0);
});
test('requires exact branch and tag protection, including exclusive App bypass',()=>{
  verifySourceProtection(protection(),app);
  for(const mutate of [r=>r[0].bypass_actors.push({actor_type:'RepositoryRole',actor_id:5}),r=>r[1].bypass_actors.push({actor_type:'Integration',actor_id:app}),r=>r[2].bypass_actors.push({actor_type:'Integration',actor_id:app}),r=>r[2].rules.pop(),r=>r[1].enforcement='evaluate',r=>r[0].conditions.ref_name.include=['~ALL'],r=>r[0].rules.pop(),r=>r[1].rules.pop(),r=>r[0].source='foreign/repo']){
    const rules=protection();mutate(rules);assert.throws(()=>verifySourceProtection(rules,app),/CONTROLLER_SOURCE_/);
  }
});
test('first source publication and idempotence preserve exact identity',async()=>{
  const f=fixture({absent:true});assert.deepEqual(await f.run(),{status:'PUBLISHED',sha:target});
  assert.deepEqual(f.writes[0],{method:'POST',path:'/repos/splrad/steward/git/refs',body:{ref:`refs/heads/${controllerSource}`,sha:target}});
  const unchanged=fixture({initial:target});assert.equal((await unchanged.run()).status,'ALREADY_PUBLISHED');assert.equal(unchanged.writes.length,0);
});
test('fast-forward uses force:false and confirms an unknown write by readback',async()=>{
  const f=fixture({lost:true});assert.equal((await f.run()).status,'PUBLISHED');
  assert.equal(f.writes.length,1);assert.deepEqual(f.writes[0].body,{sha:target,force:false});
  assert.equal(f.records.at(-1).response,'unknown');
});
for(const [name,options,code] of [
  ['tag collision',{tag:true},'TAG_COLLISION'],['non-ancestor',{diverged:true},'NOT_DESCENDANT'],
  ['third-party ref movement',{race:true},'REF_CHANGED'],['main movement',{mainMoved:true},'MAIN_MOVED'],
])test(`rejects ${name} without any source write`,async()=>{
  const f=fixture(options);await assert.rejects(f.run(),new RegExp(code));assert.equal(f.writes.length,0);
});
test('lost write without effect stays unknown and is not blindly retried',async()=>{
  const f=fixture({lost:true,noEffect:true});await assert.rejects(f.run(),/WRITE_UNCONFIRMED/);assert.equal(f.writes.length,1);
});

test('accepts equivalent API objects regardless of JSON property order',()=>{
  const rules=protection();
  for(const rule of rules)rule.conditions={ref_name:{exclude:[],include:rule.conditions.ref_name.include},repository_id:{repository_ids:[1296724484]}};
  rules[0].bypass_actors=[{bypass_mode:'always',actor_type:'Integration',actor_id:app}];
  verifySourceProtection(rules,app);
});

for(const value of [true,undefined])test(`rejects unsafe or missing update allowance ${value}`,()=>{
  const rules=protection();rules[0].rules.find(r=>r.type==='update').parameters={update_allows_fetch_and_merge:value};
  assert.throws(()=>verifySourceProtection(rules,app),/RULE_UPDATE/);
});
test('omitted bypass actors fail closed before writes',async()=>{
  const rules=protection();delete rules[0].bypass_actors;const f=fixture({rules});
  await assert.rejects(f.run(),/RULE_BYPASS/);assert.equal(f.writes.length,0);
});

test('rejects protection scoped to another repository or a wider set',()=>{
  for(const ids of [[1],[1296724484,1]]){
    const rules=protection();rules[0].conditions.repository_id.repository_ids=ids;
    assert.throws(()=>verifySourceProtection(rules,app),/RULE_SCOPE/);
  }
});

test('completes omitted REST update parameters from the same native node',async()=>{
  const rules=protection();for(const r of rules){r.node_id=`node-${r.id}`;for(const entry of r.rules)if(entry.type==='update')delete entry.parameters;}
  const io={async request(method,path){
    if(path.includes('/rulesets?'))return {status:200,value:rules};
    if(path.includes('/rulesets/'))return {status:200,value:rules.find(r=>path.endsWith(`/${r.id}`))};
    return {status:404};
  },async graphql(query,{id}){const r=rules.find(r=>r.node_id===id);return {node:{id,databaseId:r.id,rules:{nodes:[{type:'UPDATE',parameters:{updateAllowsFetchAndMerge:false}}],pageInfo:{hasNextPage:false}}}};}};
  await assertSourceProtection(io,app);
  io.graphql=async(query,{id})=>({node:{id,databaseId:Number(id.split('-')[1]),rules:{nodes:[{type:'UPDATE',parameters:{updateAllowsFetchAndMerge:true}}],pageInfo:{hasNextPage:false}}}});
  await assert.rejects(assertSourceProtection(io,app),/RULE_UPDATE/);
});
