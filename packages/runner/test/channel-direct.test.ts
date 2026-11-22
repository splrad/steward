import { expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { evidenceFixture,D,END,NOW,START,digest } from './native-evidence-fixture.js';
import { channelEvidenceFile,channelTargetsDigest,observeNativeChannels,readDirectChannelTargets,retainedChannelObservations,directChannelFile,verifyDirectChannelRead } from '../src/release-run.js';
import { jobFact,nativeRunFact } from '../src/native-release-evidence.js';
import { decodeStateFile } from '../../core/src/release-observation.js';
const blob=(b:Buffer)=>createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
async function fixture(channelIds=['ghcr-assets']) {
  const f=evidenceFixture(),cycle=f.context.cycle,unit=cycle.units[0]!;cycle.dispatches=[];
  Object.assign(unit,{releaseId:20,manifestDigest:'d'.repeat(64),notesDigest:'e'.repeat(64),assets:[{id:'app',path:'app.exe',size:1,sha256:'f'.repeat(64)}]});
  cycle.requiredChannels=channelIds.map(channelId=>({unitId:'app',channelId}));
  cycle.channelFacts=channelIds.includes('winget')?[{unitId:'app',channelId:'winget',nativeObjectId:'33'}]:[];
  const delivery={schemaVersion:1,repositoryAuthors:[{id:7,evidence:'Fixture original author'}],units:[{id:'app',path:'.',notesPath:'.release-notes/app.md',assets:[{id:'app',name:'app.exe',mediaType:'application/octet-stream'}],
    channels:channelIds.map(id=>({id,required:true,location:id==='winget'?'SPLRAD.LayerScape.Deployer':'ghcr.io/example/product'}))}]};
  const bytes=Buffer.from(JSON.stringify(delivery));cycle.deliveryConfigSha=blob(bytes);
  const targets=cycle.requiredChannels.map(c=>({...c,version:unit.version,releaseId:20,manifestDigest:unit.manifestDigest!}));
  const workflow=await readFile('templates/release/steward-release-channels.yml'),posts:any[]=[],calls:string[]=[],probeRuns:any[]=[];
  const pr={number:33,state:'open',merged:false,head:{ref:`steward/SPLRAD.LayerScape.Deployer/${unit.version}`},base:{repo:{full_name:'microsoft/winget-pkgs'}}};
  const io={request:async(method:string,path:string,_limit?:number,body?:object)=>{
    calls.push(method+' '+path);if(method==='POST'){posts.push(body);return f.response({});}
    if(path.endsWith('/product'))return f.response({id:1,full_name:'example/product',archived:false,disabled:false,default_branch:'trunk'});
    if(path.includes('/commits/'))return f.response({sha:D});
    if(path.endsWith('/pulls/33'))return f.response(pr);
    if(path.endsWith('actions/workflows/steward-release-channels.yml'))return f.response({id:10,path:'.github/workflows/steward-release-channels.yml',state:'active'});
    if(path.includes('/contents/')){const file=path.split('/contents/')[1]!.split('?')[0],b=path.includes('delivery.json')?bytes:workflow;return f.response({type:'file',path:file,encoding:'base64',content:b.toString('base64'),size:b.length,sha:blob(b)});}
    if(path.includes('/runs?'))return f.response({total_count:probeRuns.length,workflow_runs:probeRuns});
    throw Error('unexpected '+path);
  }};
  const oras=async(args:readonly string[])=>JSON.stringify(args[0]==='repo'?{name:'example/product',tags:[unit.version]}:{digest:'sha256:'+'a'.repeat(64),size:100});
  return {...f,cycle,unit,targets,io,oras,posts,calls,pr,probeRuns};
}
it('uses readable registry and pending upstream PR directly, archives native fields, and does not dispatch probe',async()=>{
  const f=await fixture(['ghcr-assets','winget']);
  const result=await observeNativeChannels(f.context,[],'unused','controller','token',f.io,NOW,f.oras);
  expect(result.probe).toBe('OBSERVED');expect(f.posts).toEqual([]);expect(result.reads.map(r=>r.readStatus)).toEqual(['OK','PENDING']);
  const file=result.files[0]!;decodeStateFile('steward/release-state',file.path,Buffer.from(file.content),1);
  const record={...file,commit:D,value:JSON.parse(file.content)};
  expect(retainedChannelObservations(f.context,[record],NOW).reads).toEqual(result.reads);
  expect(retainedChannelObservations(f.context,[record],'2026-10-26T01:00:00.000Z').reads).toEqual([]);
});
it.each([401,403,404,429])('unknown registry read %s never proves absence and automatically dispatches read-only probe',async status=>{
  const f=await fixture();const result=await observeNativeChannels(f.context,[],'unused','controller','token',f.io,NOW,async()=>{throw Error(String(status));});
  expect(result.reads).toEqual([]);expect(result.files).toEqual([]);expect(result.probe).toBe('REQUESTED');
  expect(f.posts).toHaveLength(1);expect(f.posts[0].inputs.mode).toBe('observe');expect(f.cycle.dispatches).toEqual([]);
});
it('requires an independent channel probe after a v3 product has frozen its delivery',async()=>{
  const f=await fixture();
  f.cycle.workflowDelivery=true;
  f.cycle.dispatches.push(f.request);
  f.unit.channelDeliveries=[{channelId:'ghcr-assets',delivery:{runId:100,attempt:1,artifactId:350,digest:'sha256:'+digest('archive')},
    assets:[{id:'data',path:'data.tgz',size:123,sha256:digest('data')}]}];
  const oras=async()=>{throw Error('compact source is verified through the product channel workflow');};
  const observe=(history:Parameters<typeof observeNativeChannels>[1])=>observeNativeChannels(f.context,history,'unused','controller','token',f.io,NOW,oras);
  const requested=await observe([]);
  expect(requested).toMatchObject({probe:'REQUESTED',reads:[],files:[],results:[]});
  const input=f.posts[0].inputs;
  expect(input.mode).toBe('observe');
  expect(JSON.parse(input.targets_json)).toEqual(f.targets);
  const rawRun={...f.runs.get(1),id:200,path:'.github/workflows/steward-release-channels.yml',head_sha:D,head_branch:'trunk',
    display_title:input.request_key,conclusion:'success'};
  const rawJob={...f.jobs.get(1)![0],id:201,run_id:200,head_sha:D,name:'observe',conclusion:'success',steps:[]};
  f.probeRuns.push(rawRun);
  const payload={schemaVersion:1,cycleId:f.cycle.id,sourceSha:f.cycle.sourceSha,executionSha:D,controllerSha:f.cycle.controllerSha,
    targetsDigest:channelTargetsDigest(f.context,f.targets),nativeRunId:200,runAttempt:1,
    items:[{unitId:'app',channelId:'ghcr-assets',version:f.unit.version,observedAt:START,readStatus:'OK',exists:true,digest:'sha256:'+digest('registry'),
      accepted:true,indexed:true,evidenceKind:'ghcr-assets'}]};
  const value={schemaVersion:1 as const,repositoryId:1,cycleId:f.cycle.id,sourceSha:f.cycle.sourceSha,observedAt:NOW,kind:'PROBE' as const,
    run:nativeRunFact(rawRun),job:jobFact(rawJob),artifact:{id:400,name:'probe-artifact',digest:'sha256:'+digest('probe'),createdAt:END},payload:JSON.stringify(payload)};
  const record={...channelEvidenceFile(value),commit:D,value};
  const observed=await observe([record]);
  expect(observed).toMatchObject({probe:'OBSERVED',reads:payload.items,results:[]});
  expect(retainedChannelObservations(f.context,[record],NOW).reads).toEqual(payload.items);
  expect(f.posts).toHaveLength(1);
});

it('proves version absence only with a successful exact registry inventory',async()=>{
  const f=await fixture();const result=await readDirectChannelTargets(f.context,f.targets,f.io,NOW,async()=>JSON.stringify({name:'example/product',tags:[]}));
  expect(result.reads[0]).toMatchObject({readStatus:'NOT_FOUND_CONFIRMED',exists:false,accepted:false,indexed:false,digest:null});
});
it('falls back for an unreadable native response shape and rejects contradictory simultaneous reads',async()=>{
  const f=await fixture();expect((await observeNativeChannels(f.context,[],'unused','controller','token',f.io,NOW,async()=>'{}')).probe).toBe('REQUESTED');
  const first=await readDirectChannelTargets(f.context,f.targets,f.io,NOW,f.oras);
  const second=await readDirectChannelTargets(f.context,f.targets,f.io,NOW,async()=>JSON.stringify({name:'example/product',tags:[]}));
  const records=[...first.files,...second.files].map(file=>({...file,commit:D,value:JSON.parse(file.content)}));
  expect(()=>retainedChannelObservations(f.context,records,NOW)).toThrow('conflicting simultaneous');
});
it('uses product native index only for the merged WinGet target, preserving readable registry evidence',async()=>{
  const f=await fixture(['ghcr-assets','winget']);f.pr.merged=true;f.pr.state='closed';
  const result=await observeNativeChannels(f.context,[],'unused','controller','token',f.io,NOW,f.oras);
  expect(result.reads.map(r=>r.channelId)).toEqual(['ghcr-assets']);
  expect(JSON.parse(f.posts[0].inputs.targets_json).map((r:any)=>r.channelId)).toEqual(['winget']);
});
it.each(['source','location','version','descriptor','path','future'])('rejects substituted direct native evidence: %s',async kind=>{
  const f=await fixture(),result=await readDirectChannelTargets(f.context,f.targets,f.io,NOW,f.oras),value=JSON.parse(result.files[0]!.content);
  if(kind==='source')value.sourceSha=D;
  if(kind==='location')value.sources[0].location='ghcr.io/other/package';
  if(kind==='version')value.sources[0].version='99.0.0';
  if(kind==='descriptor')value.sources[0].body=JSON.stringify({tags:{name:'example/product',tags:[f.unit.version]},descriptor:{digest:'wrong',size:100}});
  if(kind==='future')value.sources[0].observedAt=value.observedAt='2099-01-01T00:00:00.000Z';
  if(kind==='source')expect(()=>directChannelFile(value)).toThrow();
  else {const file=directChannelFile(value);if(kind==='path')file.path=result.files[0]!.path.replace(/\/[^/]+$/,'/'+'f'.repeat(64)+'.json');
    expect(()=>verifyDirectChannelRead(f.context,{...file,commit:D,value},NOW)).toThrow();}
});
