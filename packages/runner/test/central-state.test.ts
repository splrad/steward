import {expect,it} from 'vitest';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const {fetchState,recordCentralHealth,coordinateReleaseWake,releaseParticipation}=await import(pathToFileURL(resolve('scripts/release-coordinator.mjs')).href);
const {validateReleaseConfiguration}=await import(pathToFileURL(resolve('scripts/release-adoption.mjs')).href);
const repository={id:1296724484,full_name:'splrad/steward',default_branch:'main',archived:false,disabled:false};
const sha='a'.repeat(40),head='b'.repeat(40);
const summary={observedAt:'2026-11-13T12:00:00.000Z',scanCompletedAt:null,errorCodes:['RELEASE_BOOTSTRAP_REQUIRED'],counts:{scanned:1,completed:0,waiting:1,failed:0,unknown:1}};
it('shares adopted config validation while retaining an empty first-release manifest',()=>{
  const d={units:[{path:'.'}]},c={'separate-pull-requests':false,packages:{'.':{'release-type':'simple'}}};
  expect(()=>validateReleaseConfiguration(d,c,{})).not.toThrow();
  expect(()=>validateReleaseConfiguration(d,c,{'.':'0.0.0'})).not.toThrow();
  expect(()=>validateReleaseConfiguration(d,{...c,'separate-pull-requests':true},{})).toThrow('adopted configuration');
  for(const version of [null,7,{},'bad','v1.0.0',''])expect(()=>validateReleaseConfiguration(d,c,{'.':version})).toThrow('adopted configuration');
});
it('allows only protected fixed central missing refs, never product 404 or forbidden reads',async()=>{
  let status=404,protectedWriter=true,confirmationStatus=200,confirmed:any=[];
  const fetcher=async(input:any)=>{
    const path=decodeURIComponent(new URL(String(input)).pathname);
    if(path.endsWith('/splrad/steward'))return new Response(JSON.stringify(repository));
    if(path.includes('/git/matching-refs/'))return new Response(JSON.stringify(confirmed),{status:confirmationStatus});
    if(path.includes('/git/ref/'))return new Response('{}',{status});
    const data=path.includes('/rules/branches/')?[
      {type:'creation',ruleset_id:1},{type:'update',ruleset_id:1},{type:'non_fast_forward',ruleset_id:2},{type:'deletion',ruleset_id:2}
    ]:{id:path.endsWith('/1')?1:2,target:'branch',enforcement:'active',bypass_actors:path.endsWith('/1')&&protectedWriter?[{actor_id:4243096,actor_type:'Integration',bypass_mode:'always'}]:[],
      rules:path.endsWith('/1')?[{type:'creation'},{type:'update',parameters:{update_allows_fetch_and_merge:false}}]:[{type:'non_fast_forward'},{type:'deletion'}]};
    return new Response(JSON.stringify(data));
  };
  for(const ref of ['steward/release-state','steward/automation-health'])expect((await fetchState('',repository,'fixture',ref,{fetcher,centralFirstUse:true})).snapshot.head).toBeNull();
  await expect(fetchState('',repository,'fixture','steward/release-state',{fetcher})).rejects.toThrow('RELEASE_BOOTSTRAP_REQUIRED');
  await expect(fetchState('',{...repository,id:7},'fixture','steward/release-state',{fetcher,centralFirstUse:true})).rejects.toThrow('RELEASE_CENTRAL_STATE_IDENTITY');
  status=403;await expect(fetchState('',repository,'fixture','steward/release-state',{fetcher,centralFirstUse:true})).rejects.toThrow('RELEASE_STATE_UNAVAILABLE');
  status=404;confirmationStatus=403;await expect(fetchState('',repository,'fixture','steward/release-state',{fetcher,centralFirstUse:true})).rejects.toThrow('RELEASE_STATE_UNAVAILABLE');
  confirmationStatus=200;confirmed=[{ref:'refs/heads/steward/release-state',object:{type:'commit',sha}}];await expect(fetchState('',repository,'fixture','steward/release-state',{fetcher,centralFirstUse:true})).rejects.toThrow('RELEASE_STATE_MOVED');confirmed=[];
  status=404;protectedWriter=false;await expect(fetchState('',repository,'fixture','steward/release-state',{fetcher,centralFirstUse:true})).rejects.toThrow();
});
function fixture(){
  let bytes:Buffer|null=null,existing=false,writes=0;
  const run={id:77,workflow_id:11,run_attempt:1,repository:{id:repository.id},head_repository:{id:repository.id},path:'.github/workflows/release.yml',head_sha:sha,head_branch:'main',event:'schedule'};
  const refresh=async()=>({snapshot:{repositoryId:repository.id,targetRef:'steward/automation-health',head:existing?head:null,currentPaths:bytes?['health.json']:[]},remote:'https://github.com/splrad/steward.git',
    io:{request:async()=>({status:200,bytes:Buffer.from(JSON.stringify(run))})},readBytes:async()=>{if(!bytes)throw Error('missing health file');return bytes;}});
  const input={refresh,summary,repository,controllerSha:sha,runId:77,runAttempt:1,directory:resolve('fixture-health')};
  const write=async(request:any)=>{writes++;expect(request.expectedHead).toBe(existing?head:null);expect(request.changes[0].previousSha256).toBe(bytes?createHash('sha256').update(bytes).digest('hex'):null);bytes=Buffer.from(request.changes[0].content);existing=true;return {status:'APPLIED',head};};
  return {input,write,run,missingExisting:()=>{existing=true;},written:()=>bytes&&JSON.parse(bytes.toString()),writes:()=>writes};
}
it('archives a real first incomplete scan and reads it back without manufacturing success',async()=>{
  const f=fixture();await recordCentralHealth(f.input,f.write);
  expect(f.written()).toMatchObject({...summary,runId:77,runAttempt:1,workflowId:11,controllerSha:sha});
  await recordCentralHealth(f.input,f.write);expect(f.writes()).toBe(1);
  const complete={...summary,observedAt:'2026-11-13T12:05:00.000Z',scanCompletedAt:'2026-11-13T12:05:00.000Z',errorCodes:[],counts:{scanned:1,completed:1,waiting:0,failed:0,unknown:0}};
  await recordCentralHealth({...f.input,summary:complete},f.write);expect(f.writes()).toBe(2);expect(f.written().scanCompletedAt).toBe(complete.scanCompletedAt);
  await recordCentralHealth({...f.input,summary:{...summary,observedAt:'2026-11-13T12:10:00.000Z'}},f.write);expect(f.writes()).toBe(3);expect(f.written().scanCompletedAt).toBeNull();
});
it('refuses an existing ref missing health.json, a foreign native run, and unconfirmed writes',async()=>{
  const missing=fixture();missing.missingExisting();await expect(recordCentralHealth(missing.input,missing.write)).rejects.toThrow('missing health file');expect(missing.writes()).toBe(0);
  const foreign=fixture();foreign.run.head_branch='other';await expect(recordCentralHealth(foreign.input,foreign.write)).rejects.toThrow('RUN_IDENTITY');expect(foreign.writes()).toBe(0);
  const unknown=fixture();await expect(recordCentralHealth(unknown.input,async()=>({status:'UNKNOWN',head:null}))).rejects.toThrow('WRITE_UNCONFIRMED');
  const lost=fixture();await expect(recordCentralHealth(lost.input,async()=>({status:'APPLIED',head}))).rejects.toThrow('READBACK');
});
it('retains maintenance and bootstrap failures after product side effects, without repeating service',async()=>{
  let writes=0;const reports:any[]=[];
  const result=await coordinateReleaseWake({maintenance:async()=>{throw Error('missing');},discover:async()=>[{id:1},{id:2}],observe:async(r:any)=>{if(r.id===1)throw Error('RELEASE_BOOTSTRAP_REQUIRED');return {};},
    service:async()=>{writes++;return {status:'WAIT'};},health:async(s:any)=>reports.push(s)});
  expect(writes).toBe(1);expect(result.scanCompletedAt).toBeNull();expect(result.errorCodes).toEqual(['MAINTENANCE_UNAVAILABLE','RELEASE_BOOTSTRAP_REQUIRED']);expect(reports).toEqual([result]);
});
it('excludes proven unconfigured governance repositories while retaining missing or damaged product obligations',async()=>{
  let productState=false,centralMaintenance=false,partial=false,truncated=false,status=200,oldRelease=false;
  const io={request:async(_method:string,path:string)=>{
    let value:any;
    if(path===`/repos/${repository.full_name}`)value=repository;
    else if(path.includes('git/ref/heads/main'))value={ref:'refs/heads/main',object:{type:'commit',sha}};
    else if(path.includes('matching-refs/heads/steward/release-state'))value=productState||centralMaintenance?[{ref:'refs/heads/steward/release-state',object:{type:'commit',sha:head}}]:[];
    else if(path.includes(`git/trees/${head}`))value={truncated:false,tree:[...(centralMaintenance?[{path:'maintenance',type:'tree',mode:'040000'}]:[]),{path:centralMaintenance?'maintenance/12.json':'state.json',type:'blob',mode:'100644'}]};
    else if(path.includes('git/trees/'))value={truncated,tree:partial?[{path:'release-please-config.json',type:'blob',mode:'100644'}]:[]};
    else if(path.includes('matching-refs'))value=[];
    else if(path.includes('releases?'))value=oldRelease?[{id:1}]:[];
    else throw Error('unexpected read');
    return {status,bytes:Buffer.from(JSON.stringify(value))};
  }};
  expect((await releaseParticipation(repository,io)).status).toBe('NOT_APPLICABLE');
  centralMaintenance=true;expect((await releaseParticipation(repository,io)).status).toBe('NOT_APPLICABLE');centralMaintenance=false;
  productState=true;await expect(releaseParticipation(repository,io)).rejects.toThrow('CONFIGURATION_REQUIRED');productState=false;
  partial=true;await expect(releaseParticipation(repository,io)).rejects.toThrow('CONFIGURATION_REQUIRED');partial=false;
  oldRelease=true;await expect(releaseParticipation(repository,io)).rejects.toThrow('CONFIGURATION_REQUIRED');oldRelease=false;
  truncated=true;await expect(releaseParticipation(repository,io)).rejects.toThrow('INCOMPLETE');truncated=false;
  status=403;await expect(releaseParticipation(repository,io)).rejects.toThrow('UNAVAILABLE');
});
it.each([
  {path:'maintenance/12.json',type:'blob',mode:'120000'},
  {path:'maintenance/12.json',type:'commit',mode:'160000'},
  {path:'maintenance/12.json',type:'blob',mode:'100755'},
  {path:'maintenance/nested',type:'tree',mode:'040000'},
  {path:'foreign',type:'tree',mode:'040000'},
])('retains malformed central state obligations: $path $mode',async entry=>{
  const io={request:async(_method:string,path:string)=>{
    let value:any;
    if(path===`/repos/${repository.full_name}`)value=repository;
    else if(path.includes('git/ref/heads/main'))value={ref:'refs/heads/main',object:{type:'commit',sha}};
    else if(path.includes('matching-refs/heads/steward/release-state'))value=[{ref:'refs/heads/steward/release-state',object:{type:'commit',sha:head}}];
    else if(path.includes(`git/trees/${head}`))value={truncated:false,tree:[{path:'maintenance',type:'tree',mode:'040000'},entry]};
    else if(path.includes('git/trees/'))value={truncated:false,tree:[]};
    else throw Error('unexpected read');
    return {status:200,bytes:Buffer.from(JSON.stringify(value))};
  }};
  await expect(releaseParticipation(repository,io)).rejects.toThrow('RELEASE_CONFIGURATION_REQUIRED');
});
it('keeps Pages independent and completes a scan of explicitly inapplicable repositories without generation',async()=>{
  let pages=0,service=0;
  const s=await coordinateReleaseWake({discover:async()=>[{id:1}],pages:async()=>{pages++;return {status:'DISABLED'};},observe:async()=>({status:'NOT_APPLICABLE'}),service:async()=>{service++;return {};},health:async()=>{}});
  expect(pages).toBe(1);expect(service).toBe(0);expect(s.scanCompletedAt).not.toBeNull();expect(s.counts.completed).toBe(1);
});
it('records service-stage participation drift as an incomplete failed scan rather than ordinary waiting',async()=>{
  let sideEffects=0;const reports:any[]=[];
  const s=await coordinateReleaseWake({discover:async()=>[{id:1},{id:2}],observe:async()=>({status:'APPLICABLE'}),
    service:async(r:any)=>{if(r.id===1)throw Error('RELEASE_PARTICIPATION_CHANGED');sideEffects++;return {status:'WAIT'};},health:async(s:any)=>reports.push(s)});
  expect(s.scanCompletedAt).toBeNull();expect(s.errorCodes).toContain('RELEASE_PARTICIPATION_CHANGED');expect(s.counts.failed).toBe(1);expect(s.counts.waiting).toBe(1);expect(sideEffects).toBe(1);expect(reports).toEqual([s]);
});
it.each(['release-candidate','build/','releases'])('rejects changed absence evidence for %s',async changed=>{
  const counts=new Map<string,number>();
  const io={request:async(_method:string,path:string)=>{
    let v:any;
    if(path===`/repos/${repository.full_name}`)v=repository;
    else if(path.includes('git/ref/heads/main'))v={ref:'refs/heads/main',object:{type:'commit',sha}};
    else if(path.includes('git/trees/'))v={truncated:false,tree:[]};
    else {const n=(counts.get(path)??0)+1;counts.set(path,n);v=n>1&&path.includes(changed)?[{id:1}]:[];}
    return {status:200,bytes:Buffer.from(JSON.stringify(v))};
  }};
  await expect(releaseParticipation(repository,io)).rejects.toThrow('RELEASE_PARTICIPATION_CHANGED');
});
it('validates exact product blobs, retains bootstrap requirements and rejects head/state drift',async()=>{
  const product={...repository,id:7,full_name:'test/product'};
  const values:Record<string,unknown>={
    '.github/delivery.json':{schemaVersion:1,repositoryAuthors:[{id:7,evidence:'Offline authorship'}],units:[{id:'app',path:'.',notesPath:'.release-notes/app.md',assets:[{id:'app',name:'app-${version}.zip',mediaType:'application/zip'}],channels:[]}]},
    'release-please-config.json':{'separate-pull-requests':false,packages:{'.':{'release-type':'simple','version-file':'VERSION'}}},'.release-please-manifest.json':{'.':'0.0.0'}};
  let heads=0,states=0,moveHead=false,moveState=false,badBlob=false;
  const blobs=Object.fromEntries(Object.entries(values).map(([path,value])=>{const b=Buffer.from(JSON.stringify(value));return [path,{type:'file',path,encoding:'base64',size:b.length,sha:createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'),content:b.toString('base64')}];}));
  const io={request:async(_method:string,path:string)=>{
    let value:any;
    if(path==='/repos/test/product')value=product;
    else if(path.includes('git/ref/heads/main'))value={ref:'refs/heads/main',object:{type:'commit',sha:++heads>1&&moveHead?head:sha}};
    else if(path.includes('matching-refs/heads/steward/release-state'))value=++states>1&&moveState?[{ref:'refs/heads/steward/release-state',object:{type:'commit',sha:head}}]:[];
    else if(path.includes('git/trees/'))value={truncated:false,tree:Object.values(blobs).map(b=>({path:b.path,sha:b.sha,type:'blob',mode:'100644'}))};
    else if(path.includes('/contents/')){const name=path.split('/contents/')[1]!.split('?')[0]!;value={...blobs[name],...(badBlob?{content:Buffer.from('{}').toString('base64')}:{})};}
    else throw Error('unexpected read');
    return {status:200,bytes:Buffer.from(JSON.stringify(value))};
  }};
  expect((await releaseParticipation(product,io)).status).toBe('APPLICABLE');
  let serviced=false;const result=await coordinateReleaseWake({discover:async()=>[product],observe:async()=>{await releaseParticipation(product,io);throw Error('RELEASE_BOOTSTRAP_REQUIRED');},service:async()=>{serviced=true;},health:async()=>{}});
  expect(serviced).toBe(false);expect(result.errorCodes).toContain('RELEASE_BOOTSTRAP_REQUIRED');
  heads=states=0;moveHead=true;await expect(releaseParticipation(product,io)).rejects.toThrow('PARTICIPATION_CHANGED');
  heads=states=0;moveHead=false;moveState=true;await expect(releaseParticipation(product,io)).rejects.toThrow('PARTICIPATION_CHANGED');
  heads=states=0;moveState=false;badBlob=true;await expect(releaseParticipation(product,io)).rejects.toThrow('CONFIGURATION_INVALID');
});
