import {PagesRetry} from './pages-completion.js';
import {WorkflowEvent} from './quality-event.js';
import {ReleaseImpactIntake} from './pr-release-impact.js';
import {ReleasePromotion} from './release-promotion.js';
import {WingetSubmit} from './bounded-winget-submit.js';
import {ReleaseRelay} from './release-cycle-relay.js';
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
 private impact:ReleaseImpactIntake;
 constructor(private state:DurableObjectState,private env:BoundedEnv){
  this.store=new DurableRecheckStore(state.storage);
  this.impact=new ReleaseImpactIntake(state.storage,env);
  this.engine=new BoundedRecheck(this.store,new FixedRecheckEffects(env),Date.now,env.BOUNDED_PRODUCT_SHA);
 }
 async fetch(request:Request){
  ensure(request.method==='POST','INTERNAL_METHOD');const b=await request.json() as any;const action=new URL(request.url).pathname;
  if(action==='/release-impact'){await this.impact.accept(b);return Response.json({accepted:true});}
  if(action==='/pages-intake'){await new PagesRetry(this.state.storage,this.env).intake(b);return Response.json({accepted:true});}
  if(action==='/pages-receipt'){return Response.json({confirmed:await new PagesRetry(this.state.storage,this.env).receipt(b)});}
  if(action==='/pages-watch'){await new PagesRetry(this.state.storage,this.env).watch(b);return Response.json({accepted:true});}
  if(action==='/pages-retry'){await new PagesRetry(this.state.storage,this.env).schedule(b);return Response.json({accepted:true});}
  if(action==='/quality-event'||action==='/quality-promoted'){
    const event=new WorkflowEvent(this.state.storage,this.env);
    if(action.endsWith('-promoted'))await event.forward();else await event.register(b);
    return Response.json({accepted:true});
  }
  if(action==='/generation')return Response.json({generation:(await this.state.storage.get<number>('generation'))??0});
  if(action==='/wait'||action==='/promoted'){await new ReleasePromotion(this.state.storage,this.env).update(action,b);return Response.json({accepted:true});}
  if(action==='/release-promoted'){await new ReleaseRelay(this.state.storage,this.env).wakePromoted(b.policy,false,b.controller);return Response.json({accepted:true});}
  if(action==='/winget-register'){
   ensure(this.env.BOUNDED_RECHECK_ENABLED==='true' && b.registration?.identity?.stage==='winget-pr' &&
     typeof b.executionSha==='string' && /^[a-f0-9]{40}$/.test(b.executionSha) && b.anchorSha===this.env.BOUNDED_PRODUCT_SHA,'CHANNEL_INTERNAL_REGISTRATION');
   const engine=new BoundedRecheck(this.store,new FixedRecheckEffects(this.env),Date.now,b.executionSha,b.anchorSha);
   return Response.json(await engine.register(b.registration));
  }
  if(action==='/winget-submit'){await new WingetSubmit(this.state.storage,this.env).register(b);return Response.json({accepted:true});}
  if(action==='/release-cycle-status')return Response.json(await this.state.storage.get('releaseCycle')??null);
  if(action==='/release-cycle'){await new ReleaseRelay(this.state.storage,this.env).register(b.hint??b,b.source);return Response.json({accepted:true});}
  if(action!=='/status')return new Response(null,{status:404});
  return Response.json(await this.store.read(),{headers:{'Cache-Control':'no-store'}});
 }
 async alarm(){
  if(await this.state.storage.get('pagesIntake')||await this.state.storage.get('pagesRetry')||await this.state.storage.get('pagesWatch')){await new PagesRetry(this.state.storage,this.env).alarm();return;}
  // Historical objects keep their stored receipts without a writer.
  if(await this.state.storage.get('configurationEvent')||await this.state.storage.get('nativeEvent')||
     await this.state.storage.get('event'))return;
  if(await this.state.storage.get('qualityEvent')){await new WorkflowEvent(this.state.storage,this.env).alarm();return;}
  if(await this.state.storage.get('promotionPolicy')){await new ReleasePromotion(this.state.storage,this.env).alarm();return;}
  if(await this.state.storage.get('wingetSubmit')){await new WingetSubmit(this.state.storage,this.env).alarm();return;}
  if(await this.state.storage.get('releaseCycle')||await this.state.storage.get('releaseIntake')){await new ReleaseRelay(this.state.storage,this.env).alarm();return;}
  const record=await this.store.read();
  if(!record||record.identity.stage==='candidate')return;
  if(this.env.BOUNDED_RECHECK_ENABLED!=='true'){if(record.status==='PENDING')await this.engine.control('pause',record.generation);return;}
  await this.engine.wake();
 }
}
