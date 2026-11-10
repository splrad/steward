import {completeNativeRuleParameters} from './native-rule-parameters.mjs';
import {isDeepStrictEqual} from 'node:util';
const repository='splrad/steward',api=`/repos/${repository}`;
export const controllerSource='steward/validated-controller';
const branch=`refs/heads/${controllerSource}`,tag=`refs/tags/${controllerSource}`;
const check=(ok,code)=>{if(!ok)throw Error(`CONTROLLER_SOURCE_${code}`);};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const same=isDeepStrictEqual;
async function read(io,path,absent=false){
  const response=await io.request('GET',path);
  if(absent&&response.status===404)return null;
  check(response.status===200,'READ_UNCONFIRMED');return response.value;
}
/** Exact namespace protection is required because git-refs merges branch/tag names. */
export function verifySourceProtection(rules,appId){
  check(Number.isSafeInteger(appId)&&appId>0,'APP');
  check(Array.isArray(rules),'RULES');
  for(const [name,target,ref,types,actors] of [
    ['validated-controller-source','branch',branch,['creation','update'],[{actor_id:appId,actor_type:'Integration',bypass_mode:'always'}]],
    ['validated-controller-no-tag','tag',tag,['creation','update','deletion'],[]],
    ['validated-controller-integrity','branch',branch,['deletion','non_fast_forward'],[]],
  ]){
    const matching=rules.filter(rule=>rule.name===name);check(matching.length===1,'RULE_IDENTITY');
    const rule=matching[0];
    check(Number.isSafeInteger(rule.id)&&rule.id>0&&rule.source==='splrad'&&rule.source_type==='Organization'
      &&rule.enforcement==='active'&&rule.target===target,'RULE_IDENTITY');
    check(same(rule.conditions,{repository_id:{repository_ids:[1296724484]},ref_name:{include:[ref],exclude:[]}}),'RULE_SCOPE');
    check(same(rule.bypass_actors,actors),'RULE_BYPASS');
    check(Array.isArray(rule.rules)&&types.every(type=>rule.rules.some(r=>r.type===type)),'RULE_TYPES');
    check(rule.rules.every(r=>r.type!=='update'||r.parameters?.update_allows_fetch_and_merge===false),'RULE_UPDATE');
  }
}
export async function assertSourceProtection(io,appId){
  const candidates=[];
  for(let page=1;page<=100;page++){
    const batch=await read(io,`/orgs/splrad/rulesets?per_page=100&page=${page}`);
    check(Array.isArray(batch),'RULE_LIST');candidates.push(...batch);
    if(batch.length<100)break;
    check(page<100,'RULE_PAGINATION');
  }
  const selected=candidates.filter(rule=>['validated-controller-source','validated-controller-no-tag','validated-controller-integrity'].includes(rule.name));
  check(selected.length===3&&selected.every(r=>Number.isSafeInteger(r.id)&&r.id>0)&&new Set(selected.map(r=>r.id)).size===3,'RULE_IDENTITY');
  const rules=[];for(const r of selected){
    const rule=await read(io,`/orgs/splrad/rulesets/${r.id}`);check(rule.id===r.id,'RULE_IDENTITY');rules.push(await completeNativeRuleParameters(io,rule));
  }
  verifySourceProtection(rules,appId);
  check(await read(io,`${api}/git/ref/tags/${encodeURIComponent(controllerSource)}`,true)===null,'TAG_COLLISION');
}
export function createSourceGuard(io,appId,assertCurrent){
  return async()=>{await assertCurrent();await assertSourceProtection(io,appId);};
}
/** This is a checked non-force write with readback, not a compare-and-swap. */
export async function publishControllerSource(io,target,appId,assertCurrent,record){
  check(sha(target)&&typeof assertCurrent==='function'&&typeof record==='function','INPUT');
  await assertCurrent();await assertSourceProtection(io,appId);
  const path=`${api}/git/ref/heads/${encodeURIComponent(controllerSource)}`;
  const ref=await read(io,path,true);
  const valid=r=>r?.ref===branch&&r.object?.type==='commit'&&sha(r.object.sha);
  check(ref===null||valid(ref),'REF_TYPE');
  await record({kind:'controller-source-before',target,observed:ref});
  if(ref?.object.sha===target){await assertCurrent();return {status:'ALREADY_PUBLISHED',sha:target};}
  if(ref){
    const comparison=await read(io,`${api}/compare/${ref.object.sha}...${target}`);
    check(comparison.status==='ahead'&&comparison.base_commit?.sha===ref.object.sha
      &&comparison.merge_base_commit?.sha===ref.object.sha,'NOT_DESCENDANT');
  }
  await assertCurrent();await assertSourceProtection(io,appId);
  const before=await read(io,path,true);
  check(ref===null?before===null:valid(before)&&before.object.sha===ref.object.sha,'REF_CHANGED');
  let response='unknown';
  try {response=(await io.request(ref?'PATCH':'POST',ref?`${api}/git/refs/heads/${encodeURIComponent(controllerSource)}`:`${api}/git/refs`,
    ref?{sha:target,force:false}:{ref:branch,sha:target})).status;}catch{}
  const after=await read(io,path,true);
  await record({kind:'controller-source-after',response,target,observed:after});
  check(valid(after)&&after.object.sha===target,'WRITE_UNCONFIRMED');
  await assertCurrent();await assertSourceProtection(io,appId);
  return {status:'PUBLISHED',sha:target};
}
