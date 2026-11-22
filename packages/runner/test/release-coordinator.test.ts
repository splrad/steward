import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const {fetchState}=await import(pathToFileURL(resolve('scripts/release-coordinator.mjs')).href);
it.each([false,true])('validates both governance writers and the integrity rule before reading state, separate rule credential=%s',async split=>{
  const repository={id:12,full_name:'test/product',default_branch:'main'},reads:string[]=[];
  let actors=[4243096,900],integrity:any[]=[],omitBypass=false;
  let rulesActive=false;
  const fetcher=async(input:any,init:any)=>{
    const path=decodeURIComponent(new URL(String(input)).pathname);reads.push(path);expect(init.method).toBe('GET');
    const ref=path.includes('/git/ref/');
    expect(new Headers(init.headers).get('authorization')?.split(' ').at(-1)).toBe(!ref&&split?'fixture-rules':'fixture-token');
    expect(rulesActive).toBe(!ref&&split);
    if(ref)return new Response('{}',{status:404,headers:{'content-type':'application/json'}});
    const data=path.includes('/rules/branches/')?[
      {type:'creation',ruleset_id:1},{type:'update',ruleset_id:1},{type:'non_fast_forward',ruleset_id:2},{type:'deletion',ruleset_id:2}
    ]:{id:path.endsWith('/1')?1:2,target:'branch',enforcement:'active',
      ...(omitBypass?{}:{bypass_actors:path.endsWith('/1')?actors.map(actor_id=>({actor_id,actor_type:'Integration',bypass_mode:'always'})):integrity}),
      rules:path.endsWith('/1')?[{type:'creation'},{type:'update',parameters:{update_allows_fetch_and_merge:false}}]:[{type:'non_fast_forward'},{type:'deletion'}]};
    return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  };
  const read=(governanceAppId:any=900)=>fetchState('',repository,'fixture-token','steward/governance-state',{
    governanceAppId,fetcher,withGovernanceRules:split?async(verify:(token:string)=>Promise<void>)=>{
      rulesActive=true;
      try {await verify('fixture-rules');} finally {rulesActive=false;}
    }:undefined
  });
  await expect(read()).rejects.toThrow('RELEASE_BOOTSTRAP_REQUIRED');
  expect(reads.at(-1)).toBe('/repos/test/product/git/ref/heads/steward/governance-state');
  reads.length=0;actors=[4243096];await expect(read()).rejects.toThrow('QUALITY_PROTECTION');
  actors=[4243096,900];integrity=[{actor_id:4243096}];await expect(read()).rejects.toThrow('QUALITY_INTEGRITY');
  integrity=[];omitBypass=true;await expect(read()).rejects.toThrow('QUALITY_PROTECTION');
  await expect(read(null)).rejects.toThrow('QUALITY_GOVERNANCE_ID_PENDING');
  expect(reads.some(path=>path.includes('/git/ref/'))).toBe(false);
  expect(rulesActive).toBe(false);
});
