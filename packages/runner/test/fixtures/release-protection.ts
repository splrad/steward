/** Mirrors the separate writer/integrity rules from baseline 4.3.2. */
export function releaseProtectionFixture(path: string): any | undefined {
  const clean=decodeURIComponent(path).split('?')[0]!;
  const build=clean.includes('/rules/branches/steward/build/');
  if(build||/\/rules\/branches\/steward\/(release-state|automation-health)$/.test(clean)) {
    return build?[{type:'creation',ruleset_id:92},{type:'update',ruleset_id:93},{type:'deletion',ruleset_id:93}]
      :[{type:'creation',ruleset_id:90},{type:'update',ruleset_id:90},{type:'non_fast_forward',ruleset_id:91},{type:'deletion',ruleset_id:91}];
  }
  const id=Number(clean.match(/\/rulesets\/(9[0-3])$/)?.[1]);
  if(!id)return undefined;
  const rules=id===90?[{type:'creation'},{type:'update',parameters:{update_allows_fetch_and_merge:false}}]
    :id===91?[{type:'non_fast_forward'},{type:'deletion'}]
    :id===92?[{type:'creation'}]:[{type:'update',parameters:{update_allows_fetch_and_merge:false}},{type:'deletion'}];
  return {id,enforcement:'active',target:'branch',rules,bypass_actors:[90,92].includes(id)?[{actor_type:'Integration',actor_id:4243096,bypass_mode:'always'}]:[]};
}
