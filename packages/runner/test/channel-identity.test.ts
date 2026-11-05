import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { pipelineChannelIdentity } from '../src/release-pipeline.js';
import { channelTargetsDigest, prepareChannelDispatch } from '../src/release-run.js';
import { productPipelineFixture } from './product-pipeline-fixture.js';
import { C, D, START, digest } from './native-evidence-fixture.js';
afterEach(()=>vi.restoreAllMocks());
function fixture(mode:'submit'|'observe'='observe') {
  const f=productPipelineFixture(),cycle=f.context.cycle,unit=cycle.units[0]!;
  Object.assign(unit,{releaseId:20,manifestDigest:'d'.repeat(64),notesDigest:'e'.repeat(64),assets:[{id:'app',path:'app.exe',size:3,sha256:'f'.repeat(64)}]});
  cycle.requiredChannels=[{unitId:'app',channelId:'winget'}];
  const delivery:any=f.delivery;delivery.units[0].channels=[{id:'winget',required:true,location:'SPLRAD.LayerScape.Deployer'}];
  const bytes=Buffer.from(JSON.stringify(delivery)),blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');cycle.deliveryConfigSha=blob;
  f.input.state.repository.defaultBranch='trunk';
  const targets=[{unitId:'app',channelId:'winget',version:unit.version,releaseId:20,manifestDigest:unit.manifestDigest!}];
  const request=prepareChannelDispatch(f.context,10,'trunk',D,'submit',targets,START);cycle.dispatches=[request];
  const key=channelTargetsDigest(f.context,targets);
  const inputs={...request.inputs,mode,...(mode==='observe'?{operation_key:key,request_key:digest(JSON.stringify(['observe',key,D]))}:{})} as Parameters<typeof pipelineChannelIdentity>[0];
  const run={...f.runs.get(1),head_sha:D,head_branch:'trunk',path:'.github/workflows/steward-release-channels.yml',display_title:'Channels '+inputs.request_key};
  const environment={...f.environment,GITHUB_SHA:D,GITHUB_REF:'refs/heads/trunk'};
  const calls:string[]=[];
  const io={request:async(method:string,path:string)=>{
    expect(method).toBe('GET');calls.push(path);
    if(path.endsWith('/product'))return f.response({id:1,full_name:'example/product',default_branch:'trunk',archived:false,disabled:false});
    if(path.endsWith('/release-state'))return f.response({object:{sha:f.input.state.head}});
    if(path.endsWith('/runs/100'))return f.response(run);
    if(path.endsWith(`delivery.json?ref=${cycle.sourceSha}`))return f.response({type:'file',encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha:blob});
    throw Error('Unexpected channel read '+path);
  }};
  return {...f,inputs,run,environment,io,calls,request};
}
it('reads original S delivery with current non-main R and permits probe without canonical binding or business budget',async()=>{
  const f=fixture();expect(await pipelineChannelIdentity(f.inputs,f.input.state,f.environment,f.gh,f.io)).toMatchObject({status:'OBSERVE',run:{headSha:D},context:{cycle:{sourceSha:f.context.cycle.sourceSha,controllerSha:C}}});
  expect(f.calls.some(path=>path.includes('delivery.json?ref='+D))).toBe(false);
  expect(f.calls.some(path=>path.includes('/attempts/'))).toBe(false);
});
it('business waits for native canonical binding while source check remains independent',async()=>{
  const f=fixture('submit');
  expect(await pipelineChannelIdentity(f.inputs,f.input.state,f.environment,f.gh,f.io,'source')).toMatchObject({status:'SOURCE'});
  expect(await pipelineChannelIdentity(f.inputs,f.input.state,f.environment,f.gh,f.io)).toEqual({status:'NOT_BOUND',reason:'NATIVE_BINDING_PENDING'});
  f.request.canonicalRunId=101;f.request.nativeResponseEvidencePath='evidence/dispatch/'+D+'.json';expect(await pipelineChannelIdentity(f.inputs,f.input.state,f.environment,f.gh,f.io)).toEqual({status:'REJECTED',reason:'NON_CANONICAL_RUN'});
});
it('records native R drift before an unrelated state append, while unchanged R still requires the original state head',async()=>{
  const f=fixture('submit'),original=f.io.request;
  const io={request:async(method:string,path:string)=>path.endsWith('/release-state')?f.response({object:{sha:'e'.repeat(40)}}):original(method,path)};
  expect(await pipelineChannelIdentity(f.inputs,f.input.state,f.environment,f.gh,io,'source')).toEqual({status:'UNKNOWN',reason:'STATE_SOURCE_MOVED'});
  f.run.head_sha='f'.repeat(40);
  expect(await pipelineChannelIdentity(f.inputs,f.input.state,f.environment,f.gh,io,'source')).toEqual({status:'REJECTED',reason:'SOURCE_REF_MOVED'});
});
it.each(['moved','human','source','targets','input','branch','controller'])('rejects %s channel source before any business or secret use',async kind=>{
  const f=fixture();
  if(kind==='moved')f.run.head_sha='f'.repeat(40);
  if(kind==='human')f.run.actor={id:7};
  if(kind==='source')f.context.cycle.deliveryConfigSha='f'.repeat(40);
  if(kind==='targets')f.inputs.targets_json=f.inputs.targets_json.replace('winget','ghcr-assets');
  if(kind==='input')(f.inputs as any).command='shell';
  if(kind==='branch')f.environment.GITHUB_REF='refs/heads/main';
  if(kind==='controller')f.inputs.controller_sha=D;
  const result=pipelineChannelIdentity(f.inputs,f.input.state,f.environment,f.gh,f.io);
  if(kind==='moved')expect(await result).toEqual({status:'REJECTED',reason:'SOURCE_REF_MOVED'});else await expect(result).rejects.toThrow();
});
