import {createHash} from 'node:crypto';
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

it.each(['initial','mixed','known','unknown','array'])('binds compact candidate units to configured packages with a %s Release Please manifest',async kind=>{
 const id=125,name='splrad/example',head='a'.repeat(40),ref='refs/heads/trunk',root='/repos/'+name;
 const versions=kind==='initial'?{}:kind==='mixed'?{'packages/cli':'1.2.3'}:
   kind==='known'?{'packages/cli':'1.2.3','packages/docs':'0.1.0'}:kind==='array'?[]:{'packages/unknown':'1.2.3'};
 const inputs={
   '.github/delivery.json':{schemaVersion:3,repositoryAuthors:[{id:1,evidence:'fixture owner'}]},
   'release-please-config.json':{'separate-pull-requests':false,packages:{'packages/cli':{component:'cli'},'packages/docs':{component:'docs'}}},
   '.release-please-manifest.json':versions,
 };
 const blobs=new Map(Object.entries(inputs).map(([path,value])=>{
   const bytes=Buffer.from(JSON.stringify(value));
   const sha=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
   return [path,{path,mode:'100644',type:'blob',sha,size:bytes.length,encoding:'base64',content:bytes.toString('base64')}];
 }));
 const prototype=BoundedGitHub.prototype as unknown as {issueToken:()=>Promise<string>;installationScope:()=>Promise<unknown>};
 const token=vi.spyOn(prototype,'issueToken').mockResolvedValue('scoped-token');
 const scope=vi.spyOn(prototype,'installationScope').mockResolvedValue({total_count:1,repositories:[{
   id,full_name:name,private:false,visibility:'public',archived:false,disabled:false,fork:false,owner:{id:302208797},default_branch:'trunk',
 }]});
 const json=vi.spyOn(BoundedGitHub.prototype,'json').mockImplementation(async(repository,path,method='GET')=>{
   expect(repository).toBe(id);expect(method).toBe('GET');
   if(path===root+'/git/ref/heads/trunk')return {ref,object:{sha:head,type:'commit'}};
   if(path===root+'/git/trees/'+head+'?recursive=1')return {truncated:false,tree:[...blobs.values()]};
   expect(path.startsWith(root+'/contents/')).toBe(true);
   const blob=blobs.get(path.slice((root+'/contents/').length).split('?')[0]!);
   return {...blob,type:'file'};
 });
 try {
   const result=new BoundedGitHub({} as any).forCandidate(id);
   if(kind==='unknown'||kind==='array') await expect(result).rejects.toThrow(kind==='unknown'?'CANDIDATE_UNIT_COVERAGE':'CANDIDATE_DECLARATION');
   else await expect(result).resolves.toMatchObject({target:{id,name,units:[{id:'cli',path:'packages/cli'},{id:'docs',path:'packages/docs'}]}});
 }finally{json.mockRestore();scope.mockRestore();token.mockRestore();}
});