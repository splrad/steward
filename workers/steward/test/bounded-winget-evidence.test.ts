import registrations from '../../../config/release/event-repositories.json' with {type:'json'};
import {WingetSubmit} from '../src/bounded-winget-submit.js';
import {FixedRecheckEffects} from '../src/bounded-recheck-effects.js';
import {createHash} from 'node:crypto';
import {registerWingetRun} from '../src/bounded-winget-evidence.js';
import {BoundedRecheck} from '../src/bounded-recheck.js';
import {DurableRecheckStore} from '../src/bounded-recheck-do.js';
import {SqliteDurableStorage} from './bounded-storage.js';
import {describe,it,expect} from 'vitest';
import {wingetInputs,currentWinget,verifyIndexItem,bindPull,reportBinding} from '../src/bounded-winget-evidence.js';
import {digest} from '../src/bounded-recheck-github.js';
import {objectKey} from '../src/bounded-recheck.js';
const c={id:'pr-12-'+ 'a'.repeat(40),sourceSha:'a'.repeat(40),controllerSha:'b'.repeat(40),deliveryConfigSha:'c'.repeat(40),units:[{id:'layerscape',version:'1.0.0',releaseId:20,manifestDigest:'d'.repeat(64)}],requiredChannels:[{unitId:'layerscape',channelId:'winget'}]};
const identity={repositoryId:1187527897,cycleId:c.id,channel:'winget',version:'1.0.0',artifactDigest:'sha256:'+'d'.repeat(64),sourceSha:c.sourceSha,stage:'winget-index',epoch:'same',upstreamPR:{number:33,nodeId:'PR_33'}} as any;
describe('fixed WinGet protocol',()=>{
 it('matches original eight inputs and canonical key, independent of timer slot',()=>{const i=wingetInputs(c,'e'.repeat(40));expect(Object.keys(i).sort()).toEqual(['controller_sha','cycle_id','execution_sha','mode','operation_key','request_key','source_sha','targets_json']);const expected=digest(JSON.stringify([1,1187527897,c.id,c.sourceSha,c.deliveryConfigSha,[['layerscape','winget','1.0.0',20,'d'.repeat(64)]]])).slice(7);expect(i.operation_key).toBe(expected);expect(i.request_key).toBe(digest(JSON.stringify(['observe',expected,'e'.repeat(40)])).slice(7));expect(i.mode).toBe('observe');});
 it('matches the central runner digest for the registered package and frozen cycle',async()=>{
   const {channelTargetsDigest}=await import('../../../packages/runner/dist/index.js');
   const registered=registrations.filter(row=>row.externalAdapters.some(adapter=>
     adapter.channelId==='winget'&&adapter.location==='SPLRAD.LayerScape.Deployer'));
   expect(registered).toHaveLength(1);
   const inputs=wingetInputs(c,'e'.repeat(40));
   expect(inputs.operation_key).toBe(channelTargetsDigest({repositoryId:registered[0]!.id,cycle:c},JSON.parse(inputs.targets_json)));
 });
 it('requires a frozen WinGet obligation before deriving observation inputs',()=>{
   expect(()=>wingetInputs({...c,requiredChannels:[]},'e'.repeat(40))).toThrow();
 });
 it('one object owns both phases but different upstream PRs cannot collide',()=>{expect(objectKey(identity)).toBe(objectKey({...identity,stage:'winget-pr'}));expect(objectKey(identity)).not.toBe(objectKey({...identity,upstreamPR:{number:34,nodeId:'PR_34'}}));});
 it('successful run alone or wrong PR evidence cannot prove indexed',()=>{const item={unitId:'layerscape',channelId:'winget',version:'1.0.0',readStatus:'OK',exists:true,accepted:true,indexed:true,digest:null,observedAt:new Date().toISOString(),evidenceKind:'github-pr:34'};expect(verifyIndexItem(item,{identity} as any)).toBe(false);item.evidenceKind='github-pr:33';expect(verifyIndexItem(item,{identity} as any)).toBe(true);expect(verifyIndexItem({...item,indexed:false},{identity} as any)).toBe(false);item.observedAt=new Date(Date.now()-600001).toISOString();expect(verifyIndexItem(item,{identity} as any)).toBe(false);});
 it('rejects other version/fork branch and arbitrary target',()=>{expect(()=>bindPull({node_id:'PR_33',head:{ref:'steward/SPLRAD.LayerScape.Deployer/2.0.0'}},'1.0.0','PR_33')).toThrow();expect(()=>wingetInputs({...c,units:[{...c.units[0],id:'other'}]},'e'.repeat(40))).toThrow();});
 it('rejects old-attempt artifact and mismatched report identity',()=>{const now=Date.now(),run={id:10,run_attempt:2,head_sha:'e'.repeat(40)},job={started_at:new Date(now-50000).toISOString(),completed_at:new Date(now).toISOString()},v={schemaVersion:1,cycleId:c.id,sourceSha:c.sourceSha,executionSha:run.head_sha,controllerSha:c.controllerSha,targetsDigest:'key',nativeRunId:10,runAttempt:2,items:[{observedAt:new Date(now-10000).toISOString()}]};expect(()=>reportBinding(v,run,c,'key',job,new Date(now-60000).toISOString())).toThrow('CHANNEL_TIME');v.runAttempt=1;expect(()=>reportBinding(v,run,c,'key',job,new Date(now-1000).toISOString())).toThrow('CHANNEL_REPORT');});
});

async function submitFixture(){
 const now=Date.now(),start=new Date(now-30000).toISOString(),end=new Date(now-1000).toISOString(),run={id:44,run_attempt:1,workflow_id:55,actor:{id:301115370},repository:{id:1187527897},head_repository:{id:1187527897},path:'.github/workflows/steward-release-channels.yml',head_sha:'e'.repeat(40),head_branch:'main',event:'workflow_dispatch',status:'completed',conclusion:'success',display_title:'Channels submit '+'f'.repeat(64),created_at:start};
 const inputs=wingetInputs(c,run.head_sha),request={requestKey:'f'.repeat(64),purpose:'channel-submit',canonicalRunId:44,executionSha:run.head_sha,workflowId:55,ref:'main',sentAt:start,inputs:{...inputs,mode:'submit',request_key:'f'.repeat(64)}};
 const cycle={...structuredClone(c),prNumber:12,dispatches:[request],publications:[],channelFacts:[],executionEvidence:[],completionObservations:[],completedEvidencePath:null,repairOf:null,approvedRepairDecision:null};
 const report={schemaVersion:1,cycleId:cycle.id,sourceSha:cycle.sourceSha,executionSha:run.head_sha,controllerSha:cycle.controllerSha,targetsDigest:inputs.operation_key,nativeRunId:44,runAttempt:1,items:[{unitId:'layerscape',channelId:'winget',version:'1.0.0',releaseId:20,manifestDigest:'d'.repeat(64),nativeObjectId:'33',digest:'d'.repeat(64),accepted:false,indexed:false,consumed:false,observedAt:new Date(now-5000).toISOString()}]};
 const pull={number:33,node_id:'PR_33',created_at:new Date(now-3600000).toISOString(),merged:true,merged_at:new Date(now-60000).toISOString(),head:{ref:'steward/SPLRAD.LayerScape.Deployer/1.0.0',repo:{full_name:'axiomoth/winget-pkgs'}},base:{repo:{full_name:'microsoft/winget-pkgs'}}};
 const registry=structuredClone(registrations),registryReads:string[]=[];
 const g={async json(_id:number,path:string){
   if(path.includes('/contents/config/release/event-repositories.json')){
     expect(_id).toBe(1296724484);
     expect(path).toBe('/repos/splrad/steward/contents/config/release/event-repositories.json?ref='+cycle.controllerSha);
     registryReads.push(path);
     const bytes=Buffer.from(JSON.stringify(registry));
     return {path:'config/release/event-repositories.json',type:'file',encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};
   }
   if(path.endsWith('/actions/runs/44/attempts/1'))return run;if(path.endsWith('/git/ref/heads/steward/release-state'))return {ref:'refs/heads/steward/release-state',object:{type:'commit',sha:'1'.repeat(40)}};if(path.includes('/contents/cycles/')){const bytes=Buffer.from(JSON.stringify(cycle));return {path:`cycles/${cycle.id}.json`,type:'file',encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};}if(path.includes('/attempts/1/jobs?'))return {total_count:1,jobs:[{name:'submit/winget/layerscape',run_id:44,run_attempt:1,head_sha:run.head_sha,status:'completed',conclusion:'success',started_at:start,completed_at:end}]};throw Error(path);},async artifact(_id:number,runId:number,name:string,file:string){expect(runId).toBe(44);expect(name).toBe('channel-'+'f'.repeat(64)+'-layerscape-winget-44-1');expect(file).toBe('report.json');return {value:report,artifactId:66,digest:digest('zip'),createdAt:new Date(now-2000).toISOString()};}};
 const storage=new SqliteDurableStorage(),store=new DurableRecheckStore(storage as any);let outcome:any={kind:'index',mergedAt:Date.parse(pull.merged_at),evidence:'native-merge'};const engine=new BoundedRecheck(store,{observe:async()=>outcome,confirm:async()=>outcome},()=>now,run.head_sha);
 const stub={async fetch(req:Request){const b=await req.json() as any;return Response.json(new URL(req.url).pathname==='/status'?await store.read():await engine.register(b.registration));}};
 const env={BOUNDED_RECHECK_ENABLED:'true',BOUNDED_CONTROLLER_SHA:c.controllerSha,BOUNDED_PRODUCT_SHA:run.head_sha,BOUNDED_DEPLOYMENT_SHA:'2'.repeat(40),BOUNDED_RECHECK:{idFromName:(s:string)=>s,get:()=>stub}} as any;
 const payload={action:'completed',repository:{id:1187527897},workflow_run:run};return {g,env,payload,pull,cycle,report,registry,registryReads,store,engine,setOutcome:(v:any)=>{outcome=v;}};
}
describe('submit artifact to durable PR/index integration',()=>{
 it('registers native submit evidence then preserves index time/budget on duplicate submit',async()=>{const f=await submitFixture();await registerWingetRun(f.env,'workflow_run',f.payload,f.g,async()=>f.pull);let r=(await f.store.read())!;expect(r.identity.upstreamPR).toEqual({number:33,nodeId:'PR_33'});expect(r.t0).toBe(Date.parse(f.pull.created_at));await f.engine.wake();f.setOutcome({kind:'pending'});await f.engine.wake();r=(await f.store.read())!;expect(r.identity.stage).toBe('winget-index');expect(r.t0).toBe(Date.parse(f.pull.merged_at));const original=structuredClone(r);await registerWingetRun(f.env,'workflow_run',f.payload,f.g,async()=>f.pull);expect(await f.store.read()).toEqual(original);});
 it.each(['missing','other repository','duplicate repository','duplicate adapter','ambiguous location','wrong location','wrong unit'] as const)('rejects %s in the cycle controller registry before registration',async kind=>{
   const f=await submitFixture(),product=f.registry.find(row=>row.id===1187527897)!;
   const adapter=product.externalAdapters.find(row=>row.channelId==='winget')!;
   switch(kind){
     case 'missing': product.externalAdapters=product.externalAdapters.filter(row=>row!==adapter);break;
     case 'other repository': product.id=1234;break;
     case 'duplicate repository': f.registry.push({...structuredClone(product),id:1234,name:'splrad/another'});break;
     case 'duplicate adapter': product.externalAdapters.push({...adapter});break;
     case 'ambiguous location': product.externalAdapters.push({...adapter,location:'Other.Package'});break;
     case 'wrong location': adapter.location='Other.Package';break;
     case 'wrong unit': adapter.unitId='another';break;
   }
   await expect(registerWingetRun(f.env,'workflow_run',f.payload,f.g,async()=>f.pull)).rejects.toThrow('CHANNEL_WINGET_REGISTRATION');
   expect(await f.store.read()).toBeNull();
 });
 it('allows independently registered WinGet packages for other repositories and units',async()=>{
   const f=await submitFixture(),product=f.registry.find(row=>row.id===1187527897)!;
   product.externalAdapters.push({unitId:'other',channelId:'winget',location:'Other.Unit'});
   f.registry.push({...product,id:1234,name:'splrad/another',externalAdapters:[{unitId:'layerscape',channelId:'winget',location:'Other.Product'}]});
   await registerWingetRun(f.env,'workflow_run',f.payload,f.g,async()=>f.pull);
   expect((await f.store.read())?.identity.upstreamPR?.number).toBe(f.pull.number);
 });
 it('observes and deduplicates an admitted cycle using its frozen identity',async()=>{
   const f=await submitFixture();
   await registerWingetRun(f.env,'workflow_run',f.payload,f.g,async()=>f.pull);
   const admitted=(await f.store.read())!;
   f.registry.length=0;
   expect((await currentWinget(f.g,admitted,f.env)).inputs).toEqual(wingetInputs(f.cycle,admitted.executionSha!));
   await registerWingetRun(f.env,'workflow_run',f.payload,f.g,async()=>f.pull);
   expect(f.registryReads).toHaveLength(1);
   expect(await f.store.read()).toEqual(admitted);
 });
 it.each(['canonicalRun','manifest','attempt','PR'] as const)('rejects forged %s before durable registration',async kind=>{const f=await submitFixture();if(kind==='canonicalRun')f.cycle.dispatches[0]!.canonicalRunId=999;if(kind==='manifest')f.report.items[0]!.manifestDigest='0'.repeat(64);if(kind==='attempt')f.report.runAttempt=2;if(kind==='PR')f.pull.head.ref='steward/SPLRAD.LayerScape.Deployer/2.0.0';await expect(registerWingetRun(f.env,'workflow_run',f.payload,f.g,async()=>f.pull)).rejects.toThrow();expect(await f.store.read()).toBeNull();});
});

it('changing only the deployment product pin cannot replace an existing unknown index execution',async()=>{const f=await submitFixture();await registerWingetRun(f.env,'workflow_run',f.payload,f.g,async()=>f.pull);await f.engine.wake();f.setOutcome({kind:'unknown'});await f.engine.wake();const original=(await f.store.read())!,before=await currentWinget(f.g,original,f.env);expect(original.intent).not.toBeNull();expect(before.inputs.execution_sha).toBe('e'.repeat(40));f.env.BOUNDED_PRODUCT_SHA='9'.repeat(40);await expect(currentWinget(f.g,original,f.env)).rejects.toThrow('CHANNEL_EXECUTION_PIN');expect(await f.store.read()).toEqual(original);});

it('new PR registration freezes execution pin atomically and index transition preserves it',async()=>{const f=await submitFixture();await registerWingetRun(f.env,'workflow_run',f.payload,f.g,async()=>f.pull);const initial=(await f.store.read())!;expect(initial.executionSha).toBe('e'.repeat(40));await f.engine.wake();expect((await f.store.read())?.executionSha).toBe(initial.executionSha);expect((await f.store.read())?.identity.stage).toBe('winget-index');});
it.each(['missing','changed'])('unknown index %s pin fails closed without fetching a different Run or losing intent',async kind=>{const f=await submitFixture();await registerWingetRun(f.env,'workflow_run',f.payload,f.g,async()=>f.pull);await f.engine.wake();f.setOutcome({kind:'unknown'});await f.engine.wake();const original=(await f.store.read())!;if(kind==='missing')await f.store.transaction(r=>{delete r!.executionSha;return {record:r,result:null};});else f.env.BOUNDED_PRODUCT_SHA='9'.repeat(40);let calls=0;const reader={json:async()=>{calls++;throw Error('UNEXPECTED_LOOKUP');},artifact:async()=>{calls++;throw Error('UNEXPECTED_ARTIFACT');}},engine=new BoundedRecheck(f.store,new FixedRecheckEffects(f.env,()=>reader),()=>original.nextAt!,f.env.BOUNDED_PRODUCT_SHA);await engine.wake();const after=(await f.store.read())!;expect(calls).toBe(0);expect(after.status).toBe('NEEDS_ATTENTION');expect(after.reason).toBe('CHANNEL_EXECUTION_PIN');expect(after.intent?.key).toBe(original.intent?.key);expect(after.t0).toBe(original.t0);expect(after.deadline).toBe(original.deadline);expect(after.executionSha).toBe(kind==='missing'?undefined:'e'.repeat(40));});
it('rejects new candidate registration without creating a stored record',async()=>{
 const storage=new SqliteDurableStorage(),store=new DurableRecheckStore(storage as any);
 const engine=new BoundedRecheck(store,{observe:async()=>({kind:'unknown'}),confirm:async()=>({kind:'unknown'})});
 await expect(engine.register({identity:{...identity,channel:'candidate',stage:'candidate',upstreamPR:null},t0:Date.now()-1,
   policySha:'a'.repeat(40),deploymentSha:'b'.repeat(40)})).rejects.toThrow('CANDIDATE_OBSERVATION_RETIRED');
 expect(await store.read()).toBeNull();
});

it.each(['missing-trusted-pin','payload-pin'])('winget execution source cannot be supplied by %s',async kind=>{const storage=new SqliteDurableStorage(),store=new DurableRecheckStore(storage as any),engine=new BoundedRecheck(store,{observe:async()=>({kind:'unknown'}),confirm:async()=>({kind:'unknown'})},()=>Date.now(),kind==='payload-pin'?'e'.repeat(40):undefined),registration:any={identity,t0:Date.now()-1,policySha:'a'.repeat(40),deploymentSha:'b'.repeat(40)};if(kind==='payload-pin')registration.executionSha='9'.repeat(40);await expect(engine.register(registration)).rejects.toThrow(kind==='payload-pin'?'CLOSED_SCHEMA':'EXECUTION_PIN_REQUIRED');expect(await store.read()).toBeNull();});
it('binds a combined submit receipt to the original GHCR and WinGet targets; index remains WinGet-only',async()=>{
 const f=await submitFixture(), request=f.cycle.dispatches[0]!;
 f.cycle.requiredChannels.push({unitId:'layerscape',channelId:'ghcr-assets'});
 const winget=JSON.parse(request.inputs.targets_json)[0], targets=[{...winget,channelId:'ghcr-assets'},winget];
 request.inputs.targets_json=JSON.stringify(targets);
 const fields=targets.map(t=>[t.unitId,t.channelId,t.version,t.releaseId,t.manifestDigest]);
 f.report.targetsDigest=digest(JSON.stringify([1,1187527897,c.id,c.sourceSha,c.deliveryConfigSha,fields])).slice(7);
 await registerWingetRun(f.env,'workflow_run',f.payload,f.g,async()=>f.pull);
 const record=(await f.store.read())!;
 expect(record.identity.channel).toBe('winget');
 expect(JSON.parse((await currentWinget(f.g,record,f.env)).inputs.targets_json)).toEqual([winget]);
});

it('keeps a failed native submit job distinguishable from a registered upstream PR',async()=>{
 const f=await submitFixture();
 const storage=new SqliteDurableStorage();
 const reader={...f.g,json:async(id:number,path:string,...args:any[])=>{
   if(path.includes('/jobs?'))return {total_count:1,jobs:[{name:'submit/winget/layerscape',conclusion:'failure'}]};
   return (f.g.json as Function)(id,path,...args);
 }};
 const channel=new WingetSubmit(storage as any,f.env,()=>reader as any,()=>1000);
 const run=f.payload.workflow_run;
 await channel.register({id:run.id,attempt:run.run_attempt,title:run.display_title});
 await channel.alarm();
 expect(await storage.get('wingetSubmit')).toMatchObject({state:'unknown'});
 expect(await f.store.read()).toBeNull();
});

it('preserves the submit verification retry floor across restarts',async()=>{
 const f=await submitFixture(),storage=new SqliteDurableStorage();
 let now=1000,reads=0;
 const reader={...f.g,json:async(id:number,path:string,...args:any[])=>{
   if(path.includes('/jobs?')){
     if(++reads===1)throw Error('RETRY_AFTER:1800');
     return {total_count:1,jobs:[{name:'submit/winget/layerscape',conclusion:'failure'}]};
   }
   return (f.g.json as Function)(id,path,...args);
 }};
 const channel=()=>new WingetSubmit(storage as any,f.env,()=>reader as any,()=>now);
 const run=f.payload.workflow_run;
 await channel().register({id:run.id,attempt:run.run_attempt,title:run.display_title});
 await channel().alarm();expect(await storage.get('__alarm')).toBe(1801000);
 now+=60000;await channel().alarm();expect(reads).toBe(1);
 now=1801000;await channel().alarm();expect(reads).toBe(2);
 expect(await storage.get('wingetSubmit')).toMatchObject({state:'unknown',tries:2});
});
