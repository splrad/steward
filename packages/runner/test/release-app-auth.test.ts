import { expect, it } from 'vitest';
import { GITHUB_API_VERSION } from '../../github/src/api-version.js';
import { generateKeyPairSync } from 'node:crypto';
import { nativeReleaseApp } from '../../github/src/app-auth.js';
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
function fixture() {
  let sequence=0,extraScope=false,wrongBot=false;
  const minted:any[]=[],revoked:string[]=[],scopes=new Map<string,any>();
  const fetcher=(async(input,init)=>{
    const url=new URL(String(input)),headers=new Headers(init?.headers),method=init?.method??'GET';
    expect(url.origin).toBe('https://api.github.com');expect(headers.get('X-GitHub-Api-Version')).toBe(GITHUB_API_VERSION);
    let data:any;const path=decodeURIComponent(url.pathname);
    if(path==='/app')data={id:4243096,client_id:'Iv23liuSr0qd4WLJdZhH',slug:'splrad-steward'};
    else if(path==='/orgs/splrad/installation')data={id:145952003,app_id:4243096,account:{id:302208797},suspended_at:null};
    else if(path==='/users/splrad-steward[bot]')data={id:wrongBot?4243096:301115370,type:'Bot'};
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
  return {fetcher,minted,revoked,setExtraScope:()=>extraScope=true,setWrongBot:()=>wrongBot=true};
}
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
