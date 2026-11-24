import { expect, it } from 'vitest';
import { GITHUB_API_VERSION } from '../../github/src/api-version.js';
import { generateKeyPairSync } from 'node:crypto';
import { nativeReleaseApp } from '../../github/src/app-auth.js';
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
function fixture() {
  let sequence=0,extraScope=false,wrongBot=false,deliveryRepo=1;
  const minted:any[]=[],revoked:string[]=[],scopes=new Map<string,any>();
  const fetcher=(async(input,init)=>{
    const url=new URL(String(input)),headers=new Headers(init?.headers),method=init?.method??'GET';
    expect(url.origin).toBe('https://api.github.com');expect(headers.get('X-GitHub-Api-Version')).toBe(GITHUB_API_VERSION);
    let data:any;const path=decodeURIComponent(url.pathname);
    if(path==='/app')data={id:4243096,client_id:'Iv23liuSr0qd4WLJdZhH',slug:'splrad-steward'};
    else if(path==='/orgs/splrad/installation')data={id:145952003,app_id:4243096,account:{id:302208797},suspended_at:null};
    else if(path==='/users/splrad-steward[bot]')data={id:wrongBot?4243096:301115370,type:'Bot'};
    else if(path==='/app/hook/deliveries') data=[{id:19,guid:'12345678-abcd-4000-8000-123456789abc',event:'pull_request',action:'opened',installation_id:145952003,repository_id:1}];
    else if(path==='/app/hook/deliveries/19') data={guid:'12345678-abcd-4000-8000-123456789abc',event:'pull_request',action:'opened',installation_id:145952003,repository_id:1,request:{payload:{action:'opened',repository:{id:deliveryRepo},installation:{id:145952003}}}};
    else if(path==='/app/installations/145952003/access_tokens'&&method==='POST') {
      const body=JSON.parse(String(init?.body));
      // The reviewed GitHub API rejects the legacy field before minting a token.
      if(Object.hasOwn(body.permissions,'variables'))return new Response(JSON.stringify({message:'The permissions requested are not granted to this installation.'}),{status:422,headers:{'content-type':'application/json'}});
      const token=`ghs_offline_${++sequence}`;minted.push(body);scopes.set(token,body);
      data={token,expires_at:new Date(Date.now()+55*60_000).toISOString(),permissions:body.permissions,repository_selection:'selected'};
    } else if(path==='/installation/repositories') {
      const scope=scopes.get(headers.get('authorization')!.split(' ').at(-1)!);expect(scope).toBeDefined();
      const ids=scope.repository_ids??[1,2],selected=extraScope&&scope.repository_ids?[...ids,99]:ids;
      data={total_count:selected.length,repositories:selected.map((id:number)=>({id,full_name:`private/repository-${id}`,default_branch:'main',archived:false,disabled:false}))};
    } else if(path==='/installation/token'&&method==='DELETE') {revoked.push(headers.get('authorization')!.split(' ').at(-1)!);return new Response(null,{status:204});}
    else throw new Error('Unregistered auth fixture');
    return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  return {fetcher,minted,revoked,setExtraScope:()=>extraScope=true,setWrongBot:()=>wrongBot=true,setDeliveryRepo:(id:number)=>deliveryRepo=id};
}
it('recovers the original pull delivery by GUID, then restricts label access to one repository',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);
  const guid='12345678-abcd-4000-8000-123456789abc';
  expect(await app.readPullDelivery(guid)).toMatchObject({action:'opened',repository:{id:1}});
  f.setDeliveryRepo(2);
  await expect(app.readPullDelivery(guid)).rejects.toThrow('PULL_DELIVERY_IDENTITY');
  await app.forRepository(1,async()=>{},'release-label');
  expect(f.minted).toEqual([{repository_ids:[1],permissions:{metadata:'read',contents:'read',pull_requests:'write'}}]);
  expect(f.revoked).toHaveLength(1);
});
it('scopes Pages maintenance to one product, without Pages deployment or workflow write permission',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);
  await expect(app.forPagesRepository(12,async()=>{throw Error('fixture Pages failure');})).rejects.toThrow('fixture Pages failure');
  expect(f.minted).toEqual([{repository_ids:[12],permissions:{metadata:'read',contents:'write',actions:'write',administration:'read',actions_variables:'read',deployments:'read',attestations:'read',organization_administration:'write'}}]);
  expect(f.revoked).toHaveLength(1);
});
it('rejects widened Pages maintenance credentials before any product operation',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);f.setExtraScope();let called=false;
  await expect(app.forPagesRepository(12,async()=>{called=true;})).rejects.toThrow('PAGES_TOKEN_SCOPE');expect(called).toBe(false);expect(f.revoked).toHaveLength(1);
});
it('discovers using metadata only, scopes each new token to one repository, and revokes every token',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);
  expect(app.appBotId).toBe(301115370);expect((await app.discover()).map(repo=>repo.id)).toEqual([1,2]);
  const tokens:string[]=[];await app.forRepository(1,async token=>tokens.push(token));await app.forRepository(1,async token=>tokens.push(token));
  expect(new Set(tokens).size).toBe(2);expect(f.minted[0]).toEqual({permissions:{metadata:'read'}});
  expect(f.minted.slice(1).every(body=>JSON.stringify(body.repository_ids)==='[1]'&&body.permissions.actions==='write'&&body.permissions.contents==='write'&&body.permissions.checks==='read'&&body.permissions.administration==='read'&&body.permissions.organization_administration==='write')).toBe(true);
  expect(f.minted.slice(1).some(body=>body.permissions.issues||body.permissions.pull_requests)).toBe(false);expect(f.revoked).toHaveLength(3);
});
it('rejects widened token scope before any repository operation, while revoking it',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);f.setExtraScope();let calls=0;
  await expect(app.forRepository(1,async()=>{calls++;})).rejects.toThrow('RELEASE_TOKEN_SCOPE');expect(calls).toBe(0);expect(f.revoked).toHaveLength(1);
});
it('rejects the App ID when used as the bot user ID',async()=>{
  const f=fixture();f.setWrongBot();await expect(nativeReleaseApp(key,f.fetcher)).rejects.toThrow('RELEASE_APP_BOT_IDENTITY');expect(f.minted).toHaveLength(0);
});
it('revokes a scoped token when repository processing throws',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);
  await expect(app.forRepository(1,async()=>{throw new Error('fixture failure');})).rejects.toThrow('fixture failure');expect(f.revoked).toHaveLength(1);
});
it('separates candidate write permission from the read-only Release Please credential',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);let called=false;
  await app.forCandidateRepository(1,async(write,read)=>{called=true;expect(write).not.toBe(read);});
  expect(called).toBe(true);expect(f.revoked).toHaveLength(2);
  expect(f.minted[0]).toEqual({repository_ids:[1],permissions:{metadata:'read',contents:'write',pull_requests:'write',issues:'write',administration:'read',actions:'read',organization_administration:'write'}});
  expect(f.minted[1]).toEqual({repository_ids:[1],permissions:{metadata:'read',contents:'read',pull_requests:'read',issues:'read'}});
});
it('scopes quality to contents/checks write and PR/actions read, revoking on failure',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);
  await expect(app.forQualityRepository(1,async()=>{throw Error('fixture quality error');})).rejects.toThrow('fixture quality error');
  expect(f.minted).toEqual([{repository_ids:[1],permissions:{metadata:'read',contents:'write',checks:'write',pull_requests:'read',actions:'read',organization_administration:'write'}}]);
  expect(f.revoked).toHaveLength(1);
});
it('refuses a widened quality credential before any Check or state write',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);f.setExtraScope();let calls=0;
  await expect(app.forQualityRepository(1,async()=>{calls++;})).rejects.toThrow('QUALITY_TOKEN_SCOPE');expect(calls).toBe(0);expect(f.revoked).toHaveLength(1);
});
it('scopes template writes separately from bootstrap/protection reads and revokes both on failure',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);
  expect(app.appBotLogin).toBe('splrad-steward[bot]');
  await expect(app.forTemplateRepository(12,async(write,read)=>{expect(write).not.toBe(read);throw Error('fixture template failure');})).rejects.toThrow('fixture template failure');
  expect(f.minted).toEqual([
    {repository_ids:[12],permissions:{metadata:'read',contents:'write',pull_requests:'write',workflows:'write'}},
    {repository_ids:[12],permissions:{metadata:'read',contents:'read',pull_requests:'read',actions_variables:'read',actions:'read',organization_administration:'write'}}
  ]);
  expect(f.revoked).toHaveLength(2);
});
it('rejects widened template credentials before invoking delivery',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);f.setExtraScope();let calls=0;
  await expect(app.forTemplateRepository(12,async()=>{calls++;})).rejects.toThrow('TEMPLATE_TOKEN_SCOPE');
  expect(calls).toBe(0);expect(f.revoked).toHaveLength(2);
});

it('scopes registry reads, registration request reads and PR writes to separate admin-repository tokens',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);
  await expect(app.forRepository(12,async()=>{},'registration-write')).rejects.toThrow('REGISTRATION_ADMIN_REPOSITORY_ID');
  await expect(app.forRepository(12,async()=>{},'registry-read')).rejects.toThrow('REGISTRATION_ADMIN_REPOSITORY_ID');
  const registry=await app.forRepository(1447987054,async token=>token,'registry-read');
  const read=await app.forRepository(1447987054,async token=>token,'registration-read');
  expect(registry).not.toBe(read);
  await app.forRepository(1447987054,async token=>expect(token).not.toBe(read),'registration-write');
  expect(f.minted).toEqual([
    {repository_ids:[1447987054],permissions:{metadata:'read',contents:'read'}},
    {repository_ids:[1447987054],permissions:{metadata:'read',contents:'read',actions:'read'}},
    {repository_ids:[1447987054],permissions:{metadata:'read',contents:'write',pull_requests:'write'}}
  ]);
  expect(f.revoked).toHaveLength(3);
});

it('scopes the projection writer to Contents and revokes the rule reader independently',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);
  await app.forRepository(12,async writer=>{
    await app.forRepository(12,async reader=>expect(reader).not.toBe(writer),'maintenance-rules');
    expect(f.revoked).toHaveLength(1);
    expect(f.revoked).not.toContain(writer);
  },'registry-projection');
  expect(f.minted).toEqual([
    {repository_ids:[12],permissions:{metadata:'read',contents:'write'}},
    {repository_ids:[12],permissions:{metadata:'read',organization_administration:'write'}}
  ]);
  expect(f.revoked).toHaveLength(2);
});

it.each([false,true])('borrows only candidate-read capability and revokes it, operation fails=%s',async fails=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);
  const operation=app.forCandidateReadRepository(12,async read=>{expect(read).toBeTruthy();if(fails)throw Error('read failed');return 'read complete';});
  if(fails)await expect(operation).rejects.toThrow('read failed');else await expect(operation).resolves.toBe('read complete');
  expect(f.minted).toEqual([{repository_ids:[12],permissions:{metadata:'read',contents:'read',pull_requests:'read',issues:'read'}}]);
  expect(f.revoked).toHaveLength(1);
});
it('rejects widened candidate-read scope before callback and revokes the credential',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);f.setExtraScope();let called=false;
  await expect(app.forCandidateReadRepository(12,async()=>{called=true;})).rejects.toThrow('RELEASE_TOKEN_SCOPE');
  expect(called).toBe(false);expect(f.revoked).toHaveLength(1);
});

it('revokes independent PR reader and release writer when a nested adoption read fails',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);
  await expect(app.forRepository(12,async()=>app.forCandidateReadRepository(12,async()=>{throw Error('event page denied');}))).rejects.toThrow('event page denied');
  expect(f.minted).toHaveLength(2);expect(f.revoked).toHaveLength(2);
  expect(f.minted[0].permissions.pull_requests).toBeUndefined();expect(f.minted[1].permissions.pull_requests).toBe('read');
});
it.each(['valid','missing-list','wrong-node','revoke-failure','scope'])('reads two fixed central rules and revokes the rule credential: %s',async mode=>{
  const f=fixture(),calls:string[]=[];
  if(mode==='scope')f.setExtraScope();
  const native=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input)).pathname,method=init?.method??'GET';
    const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    if(path==='/installation/token'&&mode==='revoke-failure')return respond({message:'revoke rejected'},403);
    if(path.includes('/rulesets/')||path==='/graphql'){
      const token=new Headers(init?.headers).get('authorization')?.split(' ').at(-1);
      expect(token).toBe('ghs_offline_1');
      calls.push(method+' '+path);
      if(path==='/graphql'){
        const body=JSON.parse(String(init?.body));
        expect(body.query.trimStart()).toMatch(/^query\(/);expect(body.variables).toEqual({id:'fixed-writer'});
        return respond({data:{node:{id:'fixed-writer',databaseId:mode==='wrong-node'?1:26678450,
          rules:{nodes:[{type:'UPDATE',parameters:{updateAllowsFetchAndMerge:false}}],pageInfo:{hasNextPage:false}}}}});
      }
      expect(method).toBe('GET');
      const id=Number(path.split('/').at(-1));
      return respond({id,source_type:'Organization',source:'splrad',node_id:'fixed-writer',
        bypass_actors:mode==='missing-list'?undefined:[],rules:id===26678450?[{type:'update'}]:[{type:'deletion'}]});
    }
    return f.fetcher(input,init);
  };
  const app=await nativeReleaseApp(key,native);
  if(mode==='valid'){
    const rules=await app.readCentralMaintenanceRules();
    expect(calls).toEqual(['GET /repos/splrad/steward/rulesets/26678449','GET /repos/splrad/steward/rulesets/26678450','POST /graphql']);
    expect(rules[1]?.rules?.at(-1)).toMatchObject({parameters:{update_allows_fetch_and_merge:false}});
    expect(JSON.stringify(rules)).not.toContain('ghs_offline');
  } else await expect(app.readCentralMaintenanceRules()).rejects.toThrow();
  expect(f.minted).toEqual([{repository_ids:[1296724484],permissions:{metadata:'read',organization_administration:'write'}}]);
  if(mode!=='revoke-failure')expect(f.revoked).toHaveLength(1);
  if(mode==='scope')expect(calls).toEqual([]);
});

it('binds central maintenance to one repo with no organization or administration permission',async()=>{
  const f=fixture(),app=await nativeReleaseApp(key,f.fetcher);
  await expect(app.forRepository(12,async()=>{},'maintenance')).rejects.toThrow('MAINTENANCE_REPOSITORY_ID');
  expect(f.minted).toHaveLength(0);
  await app.forRepository(1296724484,async()=>{},'maintenance');
  expect(f.minted).toEqual([{repository_ids:[1296724484],permissions:{metadata:'read',contents:'write',actions:'write'}}]);
  expect(f.revoked).toHaveLength(1);
});
