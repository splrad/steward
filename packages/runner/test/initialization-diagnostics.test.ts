import {it,expect,vi} from 'vitest';
import {generateKeyPairSync} from 'node:crypto';
import {nativeReleaseApp} from '../../github/src/app-auth.js';
// @ts-expect-error JavaScript CLI helper.
import {initializationDiagnostics} from '../../../scripts/initialization-diagnostics.mjs';
// @ts-expect-error JavaScript CLI entry.
import {initializeProduct,initializationFailureCode,main} from '../../../scripts/layerscape-release-initialize.mjs';
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
const secret='SENTINEL_PRIVATE_TOKEN_AND_RESPONSE';
it.each([{cleanupFails:false,scopeFails:false},{cleanupFails:true,scopeFails:false},{cleanupFails:true,scopeFails:true}])('official SDK cleans up both purposes and preserves first failure %j',async({cleanupFails,scopeFails})=>{
  const events:any[]=[],revoked:string[]=[],issued:any[]=[];
  const diag=initializationDiagnostics((value:unknown)=>events.push(value));
  const raw:typeof fetch=async(input,init)=>{
    const path=decodeURIComponent(new URL(String(input)).pathname),method=init?.method??'GET';let body:any;
    if(path==='/app')body={id:4243096,client_id:'Iv23liuSr0qd4WLJdZhH',slug:'splrad-steward'};
    else if(path==='/orgs/splrad/installation')body={id:145952003,app_id:4243096,account:{id:302208797},suspended_at:null};
    else if(path==='/users/splrad-steward[bot]')body={id:301115370,type:'Bot'};
    else if(path.endsWith('/access_tokens')) {
      const request=JSON.parse(String(init?.body));issued.push(request);
      body={token:secret+issued.length,expires_at:'2026-11-13T14:00:00.000Z',permissions:{...request.permissions,unexpected:secret},extra:secret};
    }else if(path==='/installation/repositories')body={total_count:scopeFails&&issued.length===2?2:1,repositories:[{id:1187527897,full_name:secret}]};
    else if(path==='/installation/token'&&method==='DELETE') {
      revoked.push(new Headers(init?.headers).get('authorization')!);
      return cleanupFails?Response.json({message:secret},{status:403}):new Response(null,{status:204});
    }else if(path==='/repos/splrad/LayerScape')throw Object.assign(new Error(secret),{status:409,request:{url:secret},stderr:secret});
    else throw new Error('unexpected fixture route');
    return Response.json(body);
  };
  const fetcher=diag.transport(raw);diag.stage('app-identity');const app=await nativeReleaseApp(key,fetcher,diag.captureFailure);
  let failure:unknown;
  try {await initializeProduct({repository:{id:1187527897,full_name:'splrad/LayerScape'},baseSha:'a'.repeat(40),releaseAdoption:{prNumber:176,sourceSha:'de10de20b5405d764bfda731ed91d11ac56b5b2c'}},
    {root:'unused-before-source-fetch',app,fetcher,stage:diag.stage,onFailure:diag.captureFailure});}catch(error){failure=error;}
  expect(failure).toBeDefined();expect(issued).toHaveLength(2);expect(revoked).toHaveLength(2);
  expect(issued.map(x=>x.repository_ids)).toEqual([[1187527897],[1187527897]]);
  expect(issued[0].permissions.contents).toBe('write');expect(issued[1].permissions.contents).toBe('read');
  const result=diag.failure(failure);expect(result.phase).toBe(scopeFails?'candidate-read-credential':'repository-read');expect(result.httpStatus).toBe(scopeFails?null:409);
  const cleanups=events.filter(x=>x.operation==='revoke');expect(cleanups.map(x=>x.credential)).toEqual(['credential-2','credential-1']);
  expect(cleanups.every(x=>x.phase==='credential-cleanup')).toBe(true);
  expect(cleanups.every(x=>Object.values(x.metadataApplicability).every(v=>v===false))).toBe(true);
  expect(cleanups.every(x=>x.expiresAt===null&&x.permissions===null&&x.repositoryIds===null&&x.totalCount===null)).toBe(true);
  expect(cleanups.map(x=>x.httpStatus)).toEqual([cleanupFails?403:204,cleanupFails?403:204]);
  expect(JSON.stringify({events,result,code:initializationFailureCode(failure)})).not.toContain(secret);
  expect(events.filter(x=>x.operation==='issue').every(x=>x.expiresAt==='2026-11-13T14:00:00.000Z')).toBe(true);
});
it('malformed diagnostic body does not consume the SDK response or reveal untrusted data',async()=>{
  const events:any[]=[],diag=initializationDiagnostics((x:unknown)=>events.push(x));
  const response=await diag.transport(async()=>new Response(secret,{status:201}))('https://api.github.com/app/installations/145952003/access_tokens',{method:'POST'});
  expect(await response.text()).toBe(secret);expect(events[0].metadata).toBe('UNAVAILABLE');expect(events[0]).toMatchObject({expiresAt:null,permissions:null,repositoryIds:null,totalCount:null});expect(JSON.stringify(events)).not.toContain(secret);
});
it('safe failure codes and stages are exact allowlists, not exception prefix matching',()=>{
 const diag=initializationDiagnostics();diag.stage(secret);const e=Object.assign(new Error('LAYERSCAPE_INITIALIZE_'+secret),{stdout:secret,stderr:secret});
 expect(initializationFailureCode(e)).toBe('LAYERSCAPE_INITIALIZE_STOPPED');expect(diag.failure(e).phase).toBe('unknown-stage');
 expect(JSON.stringify(diag.failure(e))).not.toContain(secret);
 expect(initializationFailureCode(new Error('LAYERSCAPE_INITIALIZE_STATE_CHANGED'))).toBe('LAYERSCAPE_INITIALIZE_STATE_CHANGED');
});

it('GraphQL HTTP 200 errors are visible without printing query or response content',async()=>{
 const events:any[]=[],diag=initializationDiagnostics((x:unknown)=>events.push(x));
 const body={errors:[{message:secret,path:[secret],extensions:{secret}}]};
 const response=await diag.transport(async()=>Response.json(body))('https://api.github.com/graphql',{method:'POST',body:JSON.stringify({query:secret})});
 expect(await response.json()).toEqual(body);expect(events[0].graphqlErrorCount).toBe(1);expect(JSON.stringify(events)).not.toContain(secret);
});

it('maps exact adoption and writer assertions but rejects arbitrary suffixes',()=>{
 const diag=initializationDiagnostics();diag.stage('adoption-reconcile');
 expect(diag.failure(new Error('RELEASE_ADOPTION: merged adoption PR')).failureCode).toBe('ADOPTION_03');
 expect(diag.failure(new Error('RELEASE_RECORD: writer protection identity')).failureCode).toBe('WRITER_PROTECTION_05');
 expect(diag.failure(new Error('RELEASE_ADOPTION: merged adoption PR '+secret)).failureCode).toBeNull();
 expect(diag.failure(new Error('RELEASE_RECORD: '+secret)).failureCode).toBeNull();
});

it.each([{}, {token:secret}, {token:secret,permissions:null}, {token:secret,permissions:[]}, {token:secret,permissions:{contents:secret}}, {token:secret,repositories:[{id:secret}]}])('missing or invalid token metadata stays explicitly unknown %j',async body=>{
 const events:any[]=[],diag=initializationDiagnostics((x:unknown)=>events.push(x));
 await diag.transport(async()=>Response.json(body))('https://api.github.com/app/installations/145952003/access_tokens',{method:'POST'});
 expect(events[0]).toMatchObject({expiresAt:null,permissions:null,repositoryIds:null,totalCount:null,metadataApplicability:{expiresAt:true,permissions:true,repositoryIds:true,totalCount:false}});
 expect(JSON.stringify(events)).not.toContain(secret);
});
it('scope metadata distinguishes absent fields from an observed empty collection',async()=>{
 const events:any[]=[],diag=initializationDiagnostics((x:unknown)=>events.push(x));
 for(const body of [{},{total_count:0,repositories:[]}])await diag.transport(async()=>Response.json(body))('https://api.github.com/installation/repositories',{method:'GET'});
 expect(events[0]).toMatchObject({expiresAt:null,permissions:null,repositoryIds:null,totalCount:null});
 expect(events[1]).toMatchObject({expiresAt:null,permissions:null,repositoryIds:[],totalCount:0});
});

it('main retains the original fixed code when both credential revocations fail',async()=>{
 const events:any[]=[],revoked:string[]=[];let issued=0;
 const transport:typeof fetch=async(input,init)=>{
  const path=decodeURIComponent(new URL(String(input)).pathname);let body:any;
  if(path==='/app')body={id:4243096,client_id:'Iv23liuSr0qd4WLJdZhH',slug:'splrad-steward'};
  else if(path==='/orgs/splrad/installation')body={id:145952003,app_id:4243096,account:{id:302208797},suspended_at:null};
  else if(path==='/users/splrad-steward[bot]')body={id:301115370,type:'Bot'};
  else if(path.endsWith('/access_tokens'))body={token:secret+(++issued)};
  else if(path==='/installation/repositories')body={total_count:1,repositories:[{id:1187527897}]};
  else if(path==='/installation/token'){revoked.push(path);return Response.json({message:secret},{status:403});}
  else if(path==='/repos/splrad/LayerScape')body={id:1187527897,full_name:'splrad/LayerScape',private:true};
  else throw new Error('unexpected fixture route');
  return Response.json(body);
 };
 const output=vi.spyOn(process.stdout,'write').mockImplementation((chunk:any)=>{events.push(JSON.parse(String(chunk)));return true;});
 vi.stubGlobal('fetch',transport);
 try {
  const controller='b'.repeat(40);
  await expect(main({GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',GITHUB_REF:'refs/heads/main',
   GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:'splrad/steward/.github/workflows/layerscape-release-initialize.yml@refs/heads/main',
   GITHUB_SHA:controller,WORKFLOW_SHA:controller,APPROVED_CONTROLLER_SHA:controller,AUTHORIZE_INITIALIZATION:'true',EXPECTED_PRODUCT_HEAD:'a'.repeat(40),STEWARD_APP_PRIVATE_KEY:key}))
   .rejects.toMatchObject({message:'LAYERSCAPE_INITIALIZE_REPOSITORY',diagnostic:{phase:'repository-read'}});
  expect(revoked).toHaveLength(2);
  expect(events.filter(x=>x.operation==='revoke').map(x=>x.httpStatus)).toEqual([403,403]);
  expect(JSON.stringify(events)).not.toContain(secret);
 }finally{output.mockRestore();vi.unstubAllGlobals();}
});

it.each([
 ['2026-02-30T12:00:00Z',null],['2026-13-01T00:00:00Z',null],['2026-11-13T24:00:00Z',null],
 ['2026-11-13T12:60:00Z',null],['2026-11-13T12:00:00Z','2026-11-13T12:00:00Z'],
 ['2028-02-29T12:00:00.123Z','2028-02-29T12:00:00.123Z'],
])('expiry requires an actual calendar timestamp %s',async(expires_at,expected)=>{
 const events:any[]=[],diag=initializationDiagnostics((x:unknown)=>events.push(x));
 await diag.transport(async()=>Response.json({token:secret,expires_at}))('https://api.github.com/app/installations/145952003/access_tokens',{method:'POST'});
 expect(events[0].expiresAt).toBe(expected);expect(JSON.stringify(events)).not.toContain(secret);
});
