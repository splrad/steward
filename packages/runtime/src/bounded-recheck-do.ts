import {WingetSubmit} from './bounded-winget-submit.js';
import {ReleaseRelay} from './release-cycle-relay.js';
import {initialWake} from './bounded-initial-wake.js';
import {NativeCandidateCoordinator} from './bounded-native-event.js';
import { CandidateEventCoordinator } from './bounded-release-event.js';
import {BoundedRecheck,type Store,type RecordState} from './bounded-recheck.js';
import {FixedRecheckEffects} from './bounded-recheck-effects.js';
import {type BoundedEnv,ensure} from './bounded-recheck-github.js';
export class DurableRecheckStore implements Store {
 constructor(private storage:DurableObjectStorage){}
 async read(){const value=await this.storage.get<RecordState>('record');if(value)ensure(value.schemaVersion===1,'SCHEMA_VERSION');return value??null;}
 async transaction<T>(fn:(current:RecordState|null)=>{record:RecordState|null;result:T}){
  return this.storage.transaction(async txn=>{
   const current=await txn.get<RecordState>('record');if(current)ensure(current.schemaVersion===1,'SCHEMA_VERSION');
   const out=fn(current??null);
   if(out.record){await txn.put('record',out.record);if(out.record.nextAt===null)await txn.deleteAlarm();else await txn.setAlarm(out.record.nextAt);}
   return out.result;
  });
 }
}
/** Separate SQLite namespace; no shared ValidationCoordinator state or alarm slots. */
export class BoundedRecheckCoordinator {
 private store:DurableRecheckStore; private engine:BoundedRecheck;
 constructor(private state:DurableObjectState,private env:BoundedEnv){this.store=new DurableRecheckStore(state.storage);this.engine=new BoundedRecheck(this.store,new FixedRecheckEffects(env),Date.now,env.BOUNDED_PRODUCT_SHA);}
 async fetch(request:Request){
  ensure(request.method==='POST','INTERNAL_METHOD');const b=await request.json() as any;const action=new URL(request.url).pathname;
  let value:unknown;
  if(action==='/winget-register'){
   ensure(this.env.BOUNDED_RECHECK_ENABLED==='true' && b.registration?.identity?.stage==='winget-pr' &&
     typeof b.executionSha==='string' && /^[a-f0-9]{40}$/.test(b.executionSha) && b.anchorSha===this.env.BOUNDED_PRODUCT_SHA,'CHANNEL_INTERNAL_REGISTRATION');
   const engine=new BoundedRecheck(this.store,new FixedRecheckEffects(this.env),Date.now,b.executionSha,b.anchorSha);
   return Response.json(await engine.register(b.registration));
  }
  if(action==='/winget-submit'){await new WingetSubmit(this.state.storage,this.env).register(b);return Response.json({accepted:true});}
  if(action==='/release-cycle-status')return Response.json(await this.state.storage.get('releaseCycle')??null);
  if(action==='/release-cycle'){await new ReleaseRelay(this.state.storage,this.env).register(b);return Response.json({accepted:true});}
  if(action==='/native-receipt'){await new NativeCandidateCoordinator(this.state.storage,this.env).receipt(b);return Response.json({accepted:true});}
  if(action==='/native-event'){ensure(this.env.BOUNDED_RECHECK_ENABLED==='true','QUIESCED');const value=await new NativeCandidateCoordinator(this.state.storage,this.env).register(b);return Response.json(value);}
  if(action==='/event'){ensure(this.env.BOUNDED_RECHECK_ENABLED==='true','QUIESCED');await new CandidateEventCoordinator(this.state.storage,this.env).register(b);return Response.json({accepted:true});}
  if(action==='/register'){ensure(this.env.BOUNDED_RECHECK_ENABLED==='true','QUIESCED');await this.engine.register(b.registration);await initialWake(this.state.storage,this.env,()=>this.engine.wake(),b.wakeContext);value=await this.store.read();}
  else if(action==='/status')value=await this.store.read();
  else if(['/pause','/resume','/cancel'].includes(action)){if(action==='/resume')ensure(this.env.BOUNDED_RECHECK_ENABLED==='true','QUIESCED');value=await this.engine.control(action.slice(1) as 'pause'|'resume'|'cancel',b.expectedGeneration);}
  else if(action==='/receipt'){const r=await this.store.read();ensure(r?.intent?.key===b.requestKey,'RECEIPT_INTENT');await this.engine.wake();value=await this.store.read();}
  else return new Response(null,{status:404});
  return Response.json(value,{headers:{'Cache-Control':'no-store'}});
 }
 async alarm(){
  if(await this.state.storage.get('wingetSubmit')){await new WingetSubmit(this.state.storage,this.env).alarm();return;}
  if(await this.state.storage.get('releaseCycle')){await new ReleaseRelay(this.state.storage,this.env).alarm();return;}
  if(await this.state.storage.get('nativeEvent')){await new NativeCandidateCoordinator(this.state.storage,this.env).alarm();return;}
  if(await this.state.storage.get('event')){await new CandidateEventCoordinator(this.state.storage,this.env).alarm();return;}
  if(this.env.BOUNDED_RECHECK_ENABLED!=='true'){const r=await this.store.read();if(r?.status==='PENDING')await this.engine.control('pause',r.generation);return;}
  await this.engine.wake();
 }
}
