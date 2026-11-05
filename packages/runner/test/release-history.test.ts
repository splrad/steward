import {expect,it} from 'vitest';
import {inspectCycleHistory,type HistorySnapshot} from '../src/release-history.js';
import {evidenceFixture,S,C,D,NOW,digest} from './native-evidence-fixture.js';
import type {CycleCompletionFact} from '../../core/src/release-history.js';
function fixture() {
  const f=evidenceFixture(),unit=f.context.cycle.units[0]!;Object.assign(unit,{releaseId:1,manifestDigest:digest('manifest'),notesDigest:digest('notes'),assets:[{id:'app',path:'app.zip',size:1,sha256:digest('f')}]});
  const pr={id:201,number:12,merged:true,merged_at:NOW,merge_commit_sha:S,user:{id:42},head:{ref:'release-candidate',repo:{id:1}},base:{ref:'main',repo:{id:1}}};
  const snapshot:HistorySnapshot={repositoryId:1,repository:'example/product',defaultBranch:'main',appBotId:42,head:D,defaultHead:S,releaseAdoption:{sourceSha:C,prNumber:1},reachable:[S],
    cycles:[{value:f.context.cycle}],domainRecords:[],repositoryHistory:[{commit:D,committedAt:NOW,value:{schemaVersion:2,repositoryId:1,defaultBranch:'main',revision:1,
      lastObservedDefaultSha:S,lastCompletedCycleId:null,activeCycleId:f.context.cycle.id,nextCheckAt:null,lastProgressAt:null,lastErrorCode:null,candidate:{id:'a'.repeat(64),prNumber:12,
        branch:'release-candidate',baseSha:C,generatedSnapshotPath:null,publishedHead:S,editingAckHead:null,statusCommentId:null,contentGenerationDigest:digest('content'),adoptionOverride:null,observedLabelEventIds:[],pendingWrite:null}}}]};
  const source={repositoryId:1,cycleId:f.context.cycle.id,sourceSha:S,deliveryConfigSha:D,requiredChannels:[],units:[{...unit,releaseId:1,authorId:42,manifestDigest:unit.manifestDigest!,notesDigest:unit.notesDigest!,assets:unit.assets.map(({path,size,sha256})=>({path,size,sha256}))}]};
  const {id:unitId,...release}=source.units[0]!;
  const fact:CycleCompletionFact={cycleId:f.context.cycle.id,kind:'live',provenanceComplete:true,source,observation:{source,sourceComplete:true,observedAt:NOW,releasesComplete:true,
    channelsComplete:true,releases:[{...release,unitId,sourceSha:S,draft:false,immutable:true,evidenceDigest:digest('raw')}],channels:[],consumptions:[],inFlightWaveKeys:[],unknownWriteKeys:[]}};
  const calls:string[]=[],ordinary=Array.from({length:200},(_,i)=>({id:i+1,number:i+1000,head:{ref:'ordinary'},base:{ref:'main'}}));let headReads=0,moving=false,denied=false;
  const io={async request(method:'GET'|'POST',path:string) {
    expect(method).toBe('GET');calls.push(path);
    if(path==='/repos/example/product')return f.response({id:1,full_name:'example/product',default_branch:'main',archived:false,disabled:false});
    if(path.includes('/commits/main'))return f.response({sha:moving&&headReads++>0?C:S});
    if(path.endsWith('/git/ref/heads/steward/release-state'))return f.response({object:{sha:D}});
    if(path.includes('pulls?state=closed')) {
      if(denied)return f.response({},403);
      const page=Number(new URL(path,'https://api.github.com').searchParams.get('page')??1),items=page===1?ordinary.slice(0,100):page===2?ordinary.slice(100):[pr];
      return f.response(items,200,page<3?{link:`<https://api.github.com/repos/example/product/pulls?state=closed&sort=created&direction=asc&per_page=100&page=${page+1}>; rel="next"`}:{});
    }
    if(path.includes(`/commits/${S}/pulls`))return f.response([pr]);
    if(path.endsWith('/pulls/12'))return f.response(pr);
    throw Error(path);
  }};
  return {snapshot,fact,pr,io,calls,setMoved:()=>{moving=true;},setDenied:()=>{denied=true;}};
}
it('covers more than two hundred closed PRs and commit-associated PRs before evaluating completion',async()=>{
  const f=fixture(),result=await inspectCycleHistory(f.snapshot,f.io,NOW,async()=>f.fact,undefined,async()=>true);
  expect(result.result).toBe('PASS');expect(result.discovered).toHaveLength(1);expect(f.calls.filter(path=>path.includes('state=closed'))).toHaveLength(3);
  expect(f.calls.some(path=>path.includes(`/commits/${S}/pulls`))).toBe(true);
});
it.each(['source-moved','permission','adoption','consumption-reader'])('leaves %s history unknown',async kind=>{
  const f=fixture();if(kind==='source-moved')f.setMoved();if(kind==='permission')f.setDenied();if(kind==='adoption')f.snapshot.releaseAdoption=null;
  const result=await inspectCycleHistory(f.snapshot,f.io,NOW,kind==='consumption-reader'?undefined:async()=>f.fact,undefined,async()=>true);
  expect(result.result).toBe('UNKNOWN');
});
it('discovers a merged fixed-branch PR even when all candidate and cycle caches are missing',async()=>{
  const f=fixture();f.pr.head.ref='steward/release-candidate';f.snapshot.repositoryHistory=[];f.snapshot.cycles=[];
  const result=await inspectCycleHistory(f.snapshot,f.io,NOW,undefined,undefined,async()=>true);
  expect(result.inventoryComplete).toBe(true);expect(result.discovered).toHaveLength(1);expect(result.result).toBe('UNKNOWN');
  expect(result.reasons).toContainEqual(expect.objectContaining({reason:'CYCLE_RECORD_RECONSTRUCTION_REQUIRED'}));
  expect(f.calls.some(path=>path.endsWith('/pulls/12'))).toBe(true);
});
it('does not classify an ordinary version-touch PR or a fork by title/body',async()=>{
  const f=fixture();f.pr.head.repo.id=2;
  const result=await inspectCycleHistory(f.snapshot,f.io,NOW,async()=>f.fact,undefined,async()=>true);expect(result.result).toBe('UNKNOWN');expect(result.discovered).toHaveLength(0);
});
it.each(['complete','unfinished','unverified-source','missing-native-pr'])('checks prior obligations before admitting a merged handoff: %s',async kind=>{
  const f=fixture(),next=structuredClone(f.snapshot.cycles[0]!.value),nextSha='e'.repeat(40);
  Object.assign(next,{id:`pr-13-${nextSha}`,prNumber:13,sourceSha:nextSha});
  const pr={...f.pr,id:202,number:13,merge_commit_sha:nextSha,merged_at:'2026-10-28T00:00:00Z'};
  f.snapshot.reachable.push(nextSha);f.snapshot.defaultHead=nextSha;
  if(kind==='unfinished')f.fact.observation.releases=[];
  const response=(value:unknown)=>({status:200,headers:new Headers(),bytes:Buffer.from(JSON.stringify(value))});
  const io={request:async(method:'GET'|'POST',path:string)=>{
    if(path.includes('/commits/main'))return response({sha:nextSha});
    if(path.includes('/commits/')&&path.includes('/pulls')||path.includes('pulls?state=closed'))return response(kind==='missing-native-pr'?[f.pr]:[f.pr,pr]);
    if(path.endsWith('/pulls/13'))return response(pr);
    return f.io.request(method,path);
  }};
  const checked:string[]=[];
  const result=await inspectCycleHistory(f.snapshot,io,NOW,async()=>f.fact,undefined,async(p,cycle)=>{
    checked.push(cycle!.id);return kind!=='unverified-source'||p.number!==13;
  },next);
  expect(result.result).toBe(kind==='complete'?'PASS':kind==='unfinished'?'WAIT':'UNKNOWN');
  if(kind!=='missing-native-pr')expect(checked).toContain(next.id);
  expect(result.pendingHandoff).toBe(next.id);
  expect(result.reasons.some(reason=>reason.cycleId===next.id&&reason.reason==='CYCLE_RECORD_RECONSTRUCTION_REQUIRED')).toBe(false);
});
