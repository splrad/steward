import {expect,it} from 'vitest';
import {inspectPublications,invokePublication,type PublicationFile} from '../src/release-publication.js';
import {evidenceFixture,S,C,D,START,NOW,digest} from './native-evidence-fixture.js';
import {inspectNativeCycle,type EvidenceStore,type ArchiveFile,type EvidenceTransport} from '../src/native-release-evidence.js';
function fixture() {
  const f=evidenceFixture();f.context.cycle.dispatches=[];
  const unit=f.context.cycle.units[0]!,bytes=Buffer.from('frozen');Object.assign(unit,{manifestDigest:digest('manifest'),notesDigest:digest('notes'),
    assets:[{id:'app',path:'app.zip',size:bytes.length,sha256:digest(bytes)}]});
  const run:any={id:900,repository:{id:1296724484},head_repository:{id:1296724484},workflow_id:20,path:'.github/workflows/release.yml',event:'schedule',head_sha:C,
    head_branch:'main',actor:{id:81},triggering_actor:{id:81},run_attempt:1,status:'in_progress',conclusion:null,created_at:START,updated_at:NOW,display_title:'Release'};
  const job:any={id:901,run_id:900,run_attempt:1,head_sha:C,name:'release-coordinator',status:'in_progress',conclusion:null,started_at:START,completed_at:null,
    steps:[{number:3,name:'business-release-coordinator',started_at:START,completed_at:null,conclusion:null}]};
  const calls:string[]=[],files:ArchiveFile[]=[],history:PublicationFile[]=[];let exists=false,readFailure=false;
  const centralIo:EvidenceTransport={async request(method,path) {
    calls.push(method+' '+path);if(method!=='GET')throw Error('central credentials are read only');
    if(path==='/repos/splrad/steward')return f.response({id:1296724484,full_name:'splrad/steward',default_branch:'main',archived:false,disabled:false});
    if(path.endsWith('/actions/workflows/20'))return f.response({id:20,path:run.path});
    if(path.endsWith('/jobs?per_page=100'))return f.response({total_count:1,jobs:[job]});
    if(path.includes('/actions/runs/900'))return f.response(run);
    throw Error('unexpected central path');
  }};
  const productIo:EvidenceTransport={anonymous:()=>productIo,async request(method,path) {
    calls.push(method+' '+path);if(readFailure)return f.response({},503);
    if(path==='/repos/example/product')return f.response({id:1,full_name:'example/product',private:false,archived:false,disabled:false});
    if(path.includes('/releases/assets/51'))return {status:200,headers:new Headers(),bytes};
    if(path.includes('/releases/50/assets'))return f.response([{id:51,name:'app.zip',size:bytes.length}]);
    if(path.includes('/commits/'))return f.response({sha:S});
    if(path.endsWith('/releases?per_page=100'))return f.response([]);
    if(path.includes('/releases/tags/')||path.endsWith('/releases/50'))return exists?f.response({id:50,tag_name:unit.tag,author:{id:42},body:'notes',draft:false,immutable:true}):f.response({},404);
    throw Error('unexpected product path');
  }};
  const store:EvidenceStore={async archive(next){calls.push('ARCHIVE_READBACK');files.push(...next);for(const file of next)history.push({path:file.path,commit:D,value:JSON.parse(file.content)});
    return {status:'APPLIED',head:D,files:[...files],records:[]};}};
  const current={runId:900,runAttempt:1,controllerSha:C,defaultBranch:'main'};
  const terminal=()=>{run.status='completed';run.conclusion='failure';job.status='completed';job.conclusion='failure';job.completed_at=NOW;job.steps[0].completed_at=NOW;job.steps[0].conclusion='failure';};
  const currentFacts=async()=>{const p=await inspectPublications(f.context,history,productIo,centralIo,NOW);return {unknownEvidence:p.missing,inFlightWaveKeys:p.native.attempts.filter(a=>a.status!=='completed').map(a=>a.runId),outcomes:p.native.attempts.flatMap(a=>a.invocations.map(i=>i.evidence.outcome))};};
  return {...f,productIo,centralIo,files,history,calls,store,current,run,job,terminal,currentFacts,setExists:()=>{exists=true;},setReadFailure:()=>{readFailure=true;}};
}
it('adopts a private start before the first write, ignores a lost response when the actual immutable bytes exist',async()=>{
  const f=fixture();let writes=0;
  const result=await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{
    expect(f.calls.at(-1)).not.toBe('BUSINESS_WRITE');expect(f.files[0]!.path).toContain('evidence/publication/');
    f.calls.push('BUSINESS_WRITE');writes++;f.setExists();throw Error('lost response');},NOW,()=>NOW);
  expect(result.publishInvoked).toBe(true);expect(writes).toBe(1);expect(f.calls.indexOf('ARCHIVE_READBACK')).toBeLessThan(f.calls.indexOf('BUSINESS_WRITE'));
  f.terminal();expect(await f.currentFacts()).toMatchObject({unknownEvidence:[]});
  expect(f.files[0]!.content).toContain('"businessStartedProven":true');
});
it.each(['UNKNOWN','UNCHANGED','missing-readback'])('does not write business after %s start adoption',async mode=>{
  const f=fixture();let writes=0;f.store.archive=async files=>({status:mode==='missing-readback'?'APPLIED':mode,head:D,records:[],files:mode==='missing-readback'?[]:files});
  const result=await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{writes++;},NOW,()=>NOW);
  expect(result.publishInvoked).toBe(false);expect(writes).toBe(0);
});
it('an interrupted native terminal entry counts exactly once and an in-flight entry waits',async()=>{
  const f=fixture();await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{throw Error('interrupted');},NOW,()=>NOW);
  const flying=await f.currentFacts();expect(flying.inFlightWaveKeys).toHaveLength(1);
  f.terminal();expect(await f.currentFacts()).toMatchObject({});
  const repeated=await invokePublication(f.context,f.current,f.history,f.store,f.productIo,f.centralIo,async()=>{throw Error('must not repeat');},NOW,()=>NOW);
  expect(repeated.reason).toBe('PUBLICATION_ALREADY_INVOKED');
});
it('unknown object reads remain UNKNOWN and wrong native sources cannot publish',async()=>{
  const f=fixture();await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{},NOW,()=>NOW);f.terminal();f.setReadFailure();
  expect((await f.currentFacts()).outcomes).toContain('UNKNOWN');
  const g=fixture();g.run.head_sha=S;await expect(invokePublication(g.context,g.current,[],g.store,g.productIo,g.centralIo,async()=>{},NOW,()=>NOW)).rejects.toThrow('current central source');
});
it('readback of a changing native step blocks the business write',async()=>{
  const f=fixture(),original=f.store.archive;f.store.archive=async files=>{const result=await original(files);f.terminal();return result;};let calls=0;
  expect((await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{calls++;},NOW,()=>NOW)).reason).toBe('PUBLICATION_SOURCE_CHANGED');expect(calls).toBe(0);
});
it('retains product and central failure facts without a combined failure budget',async()=>{
  const f=fixture();await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{},NOW,()=>NOW);f.terminal();
  const publication=await inspectPublications(f.context,f.history,f.productIo,f.centralIo,NOW),product=evidenceFixture(2);
  const result=await inspectNativeCycle(product.context,[],product.io,NOW,{complete:true,observations:[],publication});
  expect(result.readObservation.disposition).toBe('COMPLETE');
});
it.each([410,403])('central HTTP %i uses only complete original coverage and never treats access loss as expiry',async status=>{
  const f=fixture();await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{},NOW,()=>NOW);f.terminal();
  const terminal=await inspectPublications(f.context,f.history,f.productIo,f.centralIo,'2026-10-26T00:03:00.000Z');await f.store.archive(terminal.files);
  const original=f.centralIo.request;f.centralIo.request=async(method,path,limit,body)=>path.endsWith('/actions/runs/900')?f.response({},status):original(method,path,limit,body);
  const recovered=await inspectPublications(f.context,f.history,f.productIo,f.centralIo,'2026-11-26T00:00:00.000Z');
  expect(recovered.native.runs[0]?.availability).toBe(status===410?'expired':undefined);
});

async function draftFixture() {
  const f=fixture();await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{},NOW,()=>NOW);f.terminal();
  const unit=f.context.cycle.units[0]!,marker=`<!-- steward-release:${digest(JSON.stringify([f.context.repositoryId,unit.id,unit.tag,S,unit.manifestDigest]))} -->`;
  const release:any={id:50,tag_name:unit.tag,target_commitish:S,author:{id:42},body:marker,draft:true,immutable:false};
  let assets:any[]=[],inventory:any[]=[release],listStatus=200,reads=0,changeBody=false;
  const original=f.productIo.request,io:EvidenceTransport={async request(method,path,...args) {
    expect(method).toBe('GET');f.calls.push(method+' '+path);
    if(path.includes('/releases/tags/'))return f.response({},404);
    if(path.endsWith('/releases?per_page=100'))return f.response(inventory,listStatus);
    if(path.endsWith('/releases/50')){reads++;return f.response({...release,body:changeBody&&reads>1?'changed':release.body});}
    if(path.includes('/releases/50/assets'))return f.response(assets);
    return original(method,path,...args);
  }};
  return {...f,io,release,marker,setAssets:(value:any[])=>{assets=value;},setInventory:(value:any[])=>{inventory=value;},
    denyList:()=>{listStatus=403;},changeBody:()=>{changeBody=true;}};
}
it.each(['empty','partial','notes'] as const)('reconciles an existing %s draft by native ID without claiming publication success',async kind=>{
  const f=await draftFixture(),before=f.history.map(file=>file.value);
  if(kind==='partial') {
    f.context.cycle.units[0]!.assets.push({id:'second',path:'second.zip',size:6,sha256:digest('second')});
    f.setAssets([{id:51,name:'app.zip',size:6}]);
  }
  if(kind==='notes')f.release.body='notes';
  const p=await inspectPublications(f.context,f.history,f.io,f.centralIo,NOW);
  expect(p.native.complete).toBe(true);expect(p.missing).toEqual([]);
  expect(p.native.attempts.flatMap(a=>a.invocations.map(i=>i.evidence.outcome))).toEqual(['BUSINESS_FAILED']);
  expect(JSON.parse(p.files[0]!.content).objects).toEqual([expect.objectContaining({releaseId:50,status:'ABSENT',digest:expect.any(String),sourceUrl:'https://api.github.com/repos/example/product/releases/50'})]);
  expect(f.history.map(file=>file.value)).toEqual(before);
  const observed=await inspectNativeCycle(f.context,[],f.io,NOW,{complete:true,observations:[],publication:p});
  expect(observed.currentFacts.unknownEvidence).toEqual([]);expect(observed.currentFacts.conflictEvidence).toEqual([]);
});
it.each(['author','source','marker','asset','extra','duplicate','ambiguous','changed'] as const)('keeps a draft with %s conflict blocked',async kind=>{
  const f=await draftFixture();
  if(kind==='author')f.release.author.id=99;
  if(kind==='source')f.release.target_commitish=C;
  if(kind==='marker')f.release.body='unrelated draft';
  if(kind==='asset')f.setAssets([{id:51,name:'app.zip',size:7}]);
  if(kind==='extra')f.setAssets([{id:51,name:'other.zip',size:6}]);
  if(kind==='duplicate')f.setAssets([{id:51,name:'app.zip',size:6},{id:51,name:'app.zip',size:6}]);
  if(kind==='ambiguous')f.setInventory([f.release,{...f.release,id:52}]);
  if(kind==='changed')f.changeBody();
  const p=await inspectPublications(f.context,f.history,f.io,f.centralIo,NOW);
  expect(p.native.attempts.flatMap(a=>a.invocations.map(i=>i.evidence.outcome))).toEqual([kind==='duplicate'?'UNKNOWN':'FACT_CONFLICT']);
  const facts=(await inspectNativeCycle(f.context,[],f.io,NOW,{complete:true,observations:[],publication:p})).currentFacts;
  expect(facts.unknownEvidence.length+facts.conflictEvidence.length).toBeGreaterThan(0);
});
it('retains an old UNKNOWN receipt while fresh complete draft reads reconcile the current effect',async()=>{
  const f=await draftFixture();f.denyList();
  const unknown=await inspectPublications(f.context,f.history,f.io,f.centralIo,NOW);
  expect(unknown.native.attempts[0]!.invocations[0]!.evidence.outcome).toBe('UNKNOWN');
  expect((await inspectNativeCycle(f.context,[],f.io,NOW,{complete:true,observations:[],publication:unknown})).currentFacts.unknownEvidence.length).toBeGreaterThan(0);
  await f.store.archive(unknown.files);const retained=unknown.files[0]!.content;
  const recovered=await draftFixture();
  const observed=await inspectPublications(f.context,f.history,recovered.io,f.centralIo,NOW);
  expect(observed.native.attempts[0]!.invocations[0]!.evidence.outcome).toBe('BUSINESS_FAILED');
  expect(f.files.some(file=>file.content===retained)).toBe(true);
});

it('does not adopt a discovered draft when the next inventory page is denied',async()=>{
  const f=await draftFixture(),original=f.io.request;
  const io:EvidenceTransport={async request(method,path,...args) {
    if(path.endsWith('/releases?per_page=100')) {
      const response=f.response([f.release]);response.headers.set('link','<https://api.github.com/repos/example/product/releases?per_page=100&page=2>; rel="next"');return response;
    }
    if(path.endsWith('/releases?per_page=100&page=2'))return f.response({},403);
    return original(method,path,...args);
  }};
  const p=await inspectPublications(f.context,f.history,io,f.centralIo,NOW);
  expect(p.native.attempts[0]!.invocations[0]!.evidence.outcome).toBe('UNKNOWN');
  expect(JSON.parse(p.files[0]!.content).objects[0].releaseId).toBeNull();
  expect((await inspectNativeCycle(f.context,[],io,NOW,{complete:true,observations:[],publication:p})).currentFacts.unknownEvidence.length).toBeGreaterThan(0);
});

it.each(['stable','run-changed','attempt-changed'] as const)('compares each native endpoint with itself when Run and attempt creation differ by one second: %s',async mode=>{
  const f=fixture(),original=f.centralIo.request;let checking=false,runReads=0,attemptReads=0;
  f.centralIo.request=async(method,path,...args)=>{
    if(path.endsWith('/actions/runs/900')||path.endsWith('/actions/runs/900/attempts/1')) {
      const attempt=path.endsWith('/attempts/1'),value={...f.run};
      if(attempt)value.created_at=new Date(Date.parse(f.run.created_at)+1000).toISOString();
      if(checking) {
        if(attempt)attemptReads++;else runReads++;
        if(mode==='run-changed'&&!attempt&&runReads===3||mode==='attempt-changed'&&attempt&&attemptReads===2)
          value.updated_at=new Date(Date.parse(f.run.updated_at)+1000).toISOString();
      }
      return f.response(value);
    }
    return original(method,path,...args);
  };
  await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{f.setExists();},NOW,()=>NOW);
  f.terminal();checking=true;
  const result=await inspectPublications(f.context,f.history,f.productIo,f.centralIo,NOW);
  expect(result.native.complete).toBe(mode==='stable');
  expect(result.missing).toEqual(mode==='stable'?[]:['publication:900:native-evidence']);
  if(mode==='stable')expect(result.native.attempts[0]!.invocations[0]!.evidence.outcome).toBe('EFFECT_CONFIRMED');
});
