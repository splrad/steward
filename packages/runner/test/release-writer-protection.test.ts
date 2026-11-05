import {expect,it} from 'vitest';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {releaseProtectionFixture} from './fixtures/release-protection.js';
const {assertReleaseWriterProtection}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
const repository='example/product';
function fixture(change=(value:any,_path:string)=>value) {
 const paths:string[]=[];
 return {paths,io:{request:async(method:string,path:string)=>{
  expect(method).toBe('GET');paths.push(path);
  const value=change(structuredClone(releaseProtectionFixture(path)),path);
  if(value===undefined)throw Error('unregistered protection fixture '+path);
  return {status:200,headers:new Headers(),bytes:Buffer.from(JSON.stringify(value))};
 }}};
}
it.each(['steward/release-state','steward/automation-health','steward/build/pr-1-source'])('accepts separate creation authority and integrity rules: %s',async branch=>{
 const f=fixture();await assertReleaseWriterProtection(repository,branch,f.io);
 expect(f.paths[0]).toContain('?per_page=100&page=1');
});
it.each(['missing-integrity','wrong-id','inactive','tag-target','missing-membership','integrity-bypass','wrong-app','extra-app','pull-request-bypass','combined','fetch-and-merge','missing-update-parameter'])('rejects weakened state protection: %s',async fault=>{
 const f=fixture((value,path)=>{
  if(Array.isArray(value)&&fault==='missing-integrity')return value.filter(r=>r.type!=='non_fast_forward');
  if(path.endsWith('/90')){
   if(fault==='wrong-id')value.id=99;if(fault==='inactive')value.enforcement='disabled';if(fault==='tag-target')value.target='tag';
   if(fault==='missing-membership')value.rules=value.rules.filter((r:any)=>r.type!=='update');
   if(fault==='wrong-app')value.bypass_actors[0].actor_id=99;
   if(fault==='extra-app')value.bypass_actors.push({...value.bypass_actors[0],actor_id:99});
   if(fault==='pull-request-bypass')value.bypass_actors[0].bypass_mode='pull_request';
   if(fault==='combined')value.rules.push({type:'deletion'});
   if(fault==='fetch-and-merge')value.rules[1].parameters.update_allows_fetch_and_merge=true;
   if(fault==='missing-update-parameter')delete value.rules[1].parameters;
  }
  if(path.endsWith('/91')&&fault==='integrity-bypass')value.bypass_actors=[{actor_type:'Integration',actor_id:4243096,bypass_mode:'always'}];
  return value;
 });
 await expect(assertReleaseWriterProtection(repository,'steward/release-state',f.io)).rejects.toThrow('RELEASE_RECORD:');
});
it('rejects an App update bypass on a supposedly immutable build ref',async()=>{
 const f=fixture((value,path)=>{if(path.endsWith('/93'))value.bypass_actors=[{actor_type:'Integration',actor_id:4243096,bypass_mode:'always'}];return value;});
 await expect(assertReleaseWriterProtection(repository,'steward/build/pr-1-source',f.io)).rejects.toThrow('writer integrity bypass');
});
it('reads every effective rule page before deciding protection is complete',async()=>{
 const f=fixture((value,path)=>path.includes('/rules/branches/')&&path.endsWith('page=1')?Array.from({length:100},(_,i)=>({type:'required_signatures',ruleset_id:i+100})):value);
 await assertReleaseWriterProtection(repository,'steward/release-state',f.io);
 expect(f.paths.some(path=>path.endsWith('page=2'))).toBe(true);
});
it.each([false,true])('uses the exact native GraphQL UPDATE parameter when REST omits it: %s',async value=>{
 const f=fixture((rule,path)=>{if(path.endsWith('/90')){rule.node_id='RRS_native_90';delete rule.rules[1].parameters;}return rule;});
 let reads=0;
 const fetcher:typeof fetch=async(input,init)=>{
  expect(String(input)).toBe('https://api.github.com/graphql');expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body)).variables).toEqual({id:'RRS_native_90'});reads++;
  return new Response(JSON.stringify({data:{node:{id:'RRS_native_90',databaseId:90,rules:{nodes:[{type:'UPDATE',parameters:{updateAllowsFetchAndMerge:value}}],pageInfo:{hasNextPage:false}}}}}),{status:200,headers:{'content-type':'application/json'}});
 };
 const result=assertReleaseWriterProtection(repository,'steward/release-state',f.io,{token:'isolated-fixture',fetcher});
 if(value)await expect(result).rejects.toThrow('fetch and merge exception');else await result;
 expect(reads).toBe(1);
});
it.each(['main','steward/governance-state','steward/build/../main'])('rejects unrelated or malformed protection target: %s',async branch=>{
 await expect(assertReleaseWriterProtection(repository,branch,fixture().io)).rejects.toThrow('writer protection target');
});
