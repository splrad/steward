import {it,expect,vi} from 'vitest';
vi.mock('../src/pr-body-api.js',()=>({authorizeSingleRepository:vi.fn(async()=>undefined)}));
import {BoundedGitHub,CENTRAL} from '../src/bounded-recheck-github.js';
import {authorizeSingleRepository} from '../src/pr-body-api.js';
import {handleBoundedRecheckRequest} from '../src/bounded-recheck-api.js';
it('public registration cannot supply the trusted manual wake context',async()=>{let accesses=0;const registration={identity:{repositoryId:1187527897,cycleId:'cycle',channel:'candidate',version:'1.2.3',artifactDigest:'sha256:'+'a'.repeat(64),sourceSha:'b'.repeat(40),stage:'candidate',epoch:'epoch',upstreamPR:null},t0:1,policySha:'c'.repeat(40),deploymentSha:'d'.repeat(40)};const response=await handleBoundedRecheckRequest(new Request('https://test/internal/bounded-rechecks/v1/register',{method:'POST',body:JSON.stringify({registration,producer:{},wakeContext:{kind:'validated-manual-candidate'}})}),{BOUNDED_RECHECK_ENABLED:'true',BOUNDED_RECHECK:{idFromName(){accesses++;throw Error('must not access DO');}}} as any);expect(response?.status).toBe(403);expect(accesses).toBe(0);});

it('forwards the native Run policy to the candidate object after a controller upgrade',async()=>{
 const identity={repositoryId:125,cycleId:'cycle',channel:'candidate',version:'1.2.3',artifactDigest:'sha256:'+'a'.repeat(64),
   sourceSha:'b'.repeat(40),stage:'candidate',epoch:'epoch',upstreamPR:null};
 const locator={identity,runId:42,attempt:1,requestKey:'c'.repeat(64)},policy='d'.repeat(40);
 const run={id:42,run_attempt:1,repository:{id:CENTRAL.id},head_repository:{id:CENTRAL.id},head_sha:policy,
   event:'workflow_dispatch',path:'.github/workflows/release-observe.yml',display_title:'Observe candidate '+locator.requestKey};
 const native=vi.spyOn(BoundedGitHub.prototype,'json').mockResolvedValue(run);
 const object=vi.fn(async(request:Request)=>Response.json(await request.json()));
 const env={BOUNDED_CONTROLLER_SHA:'e'.repeat(40),BOUNDED_RECHECK:{idFromName:(s:string)=>s,get:()=>({fetch:object})}} as any;
 const request=(body:unknown)=>new Request('https://test/internal/bounded-rechecks/v1/receipt',{method:'POST',body:JSON.stringify(body)});
 try{
   const input=request(locator),response=await handleBoundedRecheckRequest(input,env);
   expect(authorizeSingleRepository).toHaveBeenCalledWith(input,env,identity.repositoryId);
   expect(await response?.json()).toEqual({...locator,policySha:policy});
   expect(native).toHaveBeenCalledWith(CENTRAL.id,`/repos/${CENTRAL.name}/actions/runs/42`);
   expect((await handleBoundedRecheckRequest(request({...locator,policySha:policy}),env))?.status).toBe(403);
   native.mockResolvedValue({...run,run_attempt:2});
   expect((await handleBoundedRecheckRequest(request(locator),env))?.status).toBe(403);
   expect(object).toHaveBeenCalledTimes(1);
 }finally{native.mockRestore();}
});
