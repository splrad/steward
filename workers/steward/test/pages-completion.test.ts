import {readFileSync} from 'node:fs';
import {ReleaseTestDb} from './release-test-db.js';
import {describe,it,expect,vi} from 'vitest';
import {GitHubRetryError} from '../src/bounded-retry-after.js';
import {SqliteDurableStorage} from './bounded-storage.js';
import {PagesRetry,forwardPagesCompletion} from '../src/pages-completion.js';
import {handleWebhook} from '../src/index.js';
import {BoundedGitHub,TARGET,CENTRAL,type GitReader} from '../src/bounded-recheck-github.js';

const pin='b'.repeat(40),source='a'.repeat(40),receiver='pages-maintenance-event.yml',workflowPath='.github/workflows/pages.yml';
const env={BOUNDED_RECHECK_ENABLED:'true',BOUNDED_CONTROLLER_SHA:pin,INSTALLATION_ID:'41',ORGANIZATION_ID:'42',STEWARD_WEBHOOK_SECRET:'offline-test'} as any;
function fixture(storage=new SqliteDurableStorage(),product={id:Number(TARGET.id),name:String(TARGET.name)}){
  const site={repositoryId:product.id,repository:product.name,workflowId:8};
  const repo={id:product.id,full_name:product.name,private:false,has_pages:true,archived:false,disabled:false,fork:false};
  const run={id:12,run_attempt:1,repository:repo,head_repository:repo,workflow_id:8,path:workflowPath,head_sha:source,
    created_at:new Date(Date.now()-60000).toISOString(),event:'push',status:'completed',conclusion:'cancelled',updated_at:'2026-11-17T00:00:00Z'};
  const payload={repository:repo,installation:{id:41},organization:{id:42},workflow_run:structuredClone(run),action:'completed'};
  const db=new ReleaseTestDb();
  db.database.exec(readFileSync(new URL('../../../packages/runtime/migrations/0020_pages_completion_dispatches.sql',import.meta.url),'utf8'));
  db.database.exec(readFileSync(new URL('../../../packages/runtime/migrations/0021_pages_completion_retry_after.sql',import.meta.url),'utf8'));
  const config={...env,ISSUE_SNAPSHOTS:db.binding(),BOUNDED_RECHECK:{idFromName:(x:string)=>x,get:()=>({
    fetch:async(req:Request)=>{
      expect(new URL(req.url).pathname).toBe('/pages-intake');
      await new PagesRetry(storage as any,config,()=>g,[site]).intake(await req.json() as any);
      return Response.json({});
    }
  })}};
  const result={lost:false,visible:true,rejections:0,rejectionStatus:429,denied:false};
  const receipt={id:99,path:'.github/workflows/'+receiver,display_title:'Pages completion '+product.id+' 12 1',event:'workflow_dispatch',
    actor:{id:301115370},repository:{id:CENTRAL.id},head_repository:{id:CENTRAL.id},head_branch:'main',head_sha:pin};
  const centralSites=[site];
  const workflow={id:8,path:workflowPath,state:'active'}, prior:any={total_count:0,workflow_runs:[]};
  const json=vi.fn(async(id:number,path:string,method?:string,body?:unknown)=>{
    if(id===product.id&&path==='/repos/'+product.name)return repo;
    if(id===product.id&&path.endsWith('/actions/runs/12'))return run;
    if(id===product.id&&path.endsWith('/actions/workflows/pages.yml'))return workflow;
    if(id===CENTRAL.id&&path.includes('/contents/config/pages-completion.json?ref=')){
      const bytes=Buffer.from(JSON.stringify({publicSites:centralSites}));
      return {type:'file',path:'config/pages-completion.json',encoding:'base64',size:bytes.length,content:bytes.toString('base64')};
    }
    if(id===CENTRAL.id&&path.includes('/'+receiver+'/runs?'))return prior;
    if(id===CENTRAL.id&&path.endsWith('/'+receiver))return {state:'active',path:'.github/workflows/'+receiver};
    if(id===CENTRAL.id&&path.endsWith('/git/ref/heads/main'))return {object:{sha:pin}};
    if(method==='POST'&&id===CENTRAL.id&&path==='/repos/splrad/steward/actions/workflows/'+receiver+'/dispatches'){
      if(result.denied)throw Error('GITHUB_HTTP_403');
      if(result.rejections>0){result.rejections--;throw new GitHubRetryError(result.rejectionStatus,'180',true);}
      if(result.visible)Object.assign(prior,{total_count:1,workflow_runs:[receipt]});
      if(result.lost)throw Error('lost response');
      return body;
    }
    throw Error('unexpected native request');
  });
  const g={json} as unknown as GitReader;
  return {site,centralSites,receipt,result,config,db,payload,run,workflow,prior,json,g,forward:()=>forwardPagesCompletion(config,'workflow_run',payload,[site])};
}
describe('fixed public Pages completion bridge',()=>{
  it('uses the existing webhook HMAC gate',async()=>{
    const f=fixture();
    const r=await handleWebhook(new Request('https://unit.invalid/github/webhook',{method:'POST',
      headers:{'x-github-event':'workflow_run'},body:JSON.stringify(f.payload)}),env);
    expect(r.status).toBe(401);
  });
  it('the shipped empty registry performs zero API calls',async()=>{
    const f=fixture();await forwardPagesCompletion(env,'workflow_run',f.payload);expect(f.json).not.toHaveBeenCalled();
  });
  it('revalidates the public product Run before the sole fixed dispatch',async()=>{
    const f=fixture();await f.forward();
    const writes=f.json.mock.calls.filter(c=>c[2]==='POST');
    expect(writes).toEqual([[CENTRAL.id,'/repos/splrad/steward/actions/workflows/'+receiver+'/dispatches','POST',
      {ref:'main',inputs:{repository_id:String(TARGET.id),workflow_id:'8',run_id:'12',attempt:'1',policy_sha:pin}}]]);
  });
  it.each([['queued',null],['in_progress',null],['completed','failure'],['completed','success']])(
    'records the same dispatch once when its receiver is %s/%s',async(status,conclusion)=>{
      const f=fixture();
      Object.assign(f.receipt,{status,conclusion});
      await f.forward();
      await f.forward();
      expect(f.json.mock.calls.filter(call=>call[2]==='POST')).toHaveLength(1);
      const row=f.db.database.prepare('SELECT central_run_id FROM pages_completion_dispatches').get();
      expect(row).toEqual({central_run_id:f.receipt.id});
    });
  it('atomically reserves once across two concurrent deliveries',async()=>{
    const f=fixture();await Promise.all([f.forward(),f.forward()]);
    expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(1);
    expect(f.db.database.prepare('SELECT central_run_id FROM pages_completion_dispatches').get()?.central_run_id).toBe(99);
  });
  it('reconciles a lost response without another write',async()=>{
    const f=fixture();f.result.lost=true;
    await f.forward();await f.forward();expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(1);
  });
  it('keeps an unknown reservation across redelivery and later confirms the original receipt',async()=>{
    const f=fixture();f.result.visible=false;
    await expect(f.forward()).rejects.toThrow('PAGES_DISPATCH_UNCONFIRMED');
    await expect(f.forward()).rejects.toThrow('PAGES_DISPATCH_UNCONFIRMED');
    f.run.run_attempt=2; // The original dispatch can still be confirmed after the product has advanced.
    Object.assign(f.prior,{total_count:1,workflow_runs:[f.receipt]});
    await f.forward();expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(1);
  });
  it.each([3,4])('bounds the recovery handoff at original run attempt %i',async attempt=>{
    const f=fixture();
    f.payload.workflow_run.run_attempt=f.run.run_attempt=attempt;
    f.receipt.display_title=`Pages completion ${TARGET.id} 12 ${attempt}`;
    await f.forward();
    const posts=f.json.mock.calls.filter(c=>c[2]==='POST');
    const rows=f.db.database.prepare('SELECT attempt,central_run_id FROM pages_completion_dispatches').all();
    if(attempt===3){
      expect(posts).toHaveLength(1);
      expect(posts[0]?.[3]).toMatchObject({inputs:{run_id:'12',attempt:'3'}});
      expect(rows).toEqual([{attempt:3,central_run_id:f.receipt.id}]);
    }else{
      expect(posts).toEqual([]);
      expect(rows).toEqual([]);
    }
  });
  it.each(['privatePayload','privateReadback','notInstalled','foreignFork','wrongAttempt','paused','notEnrolled','removedCentrally','expired'] as const)('suppresses %s',async why=>{
    const f=fixture();
    if(why==='privatePayload')f.payload.repository.private=true;
    if(why==='privateReadback')f.run.repository={...f.run.repository,private:true};
    if(why==='notInstalled')f.payload.installation.id=50;
    if(why==='foreignFork')f.run.head_repository={...f.run.repository,id:99 as any};
    if(why==='wrongAttempt')f.run.run_attempt++;
    if(why==='expired')f.run.created_at=new Date(Date.now()-31*86400_000).toISOString();
    if(why==='paused')f.workflow.state='disabled_manually';
    if(why==='notEnrolled')f.site.workflowId++;
    if(why==='removedCentrally')f.centralSites.length=0;
    await f.forward();expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toEqual([]);
  });
});

it.each([429,403])('recovers explicit rate limit %s at its floor with one accepted POST',async status=>{
 const storage=new SqliteDurableStorage(),f=fixture(storage),now=Date.now();
 const clock=vi.spyOn(Date,'now').mockReturnValue(now);
 const object=()=>new PagesRetry(storage as any,f.config,()=>f.g,[f.site]);
 try{
   const posts=()=>f.json.mock.calls.filter(c=>c[2]==='POST').length;
   f.result.rejectionStatus=status;f.result.rejections=2;await f.forward();
   expect(await storage.get('__alarm')).toBe(now+180000);expect(posts()).toBe(1);
   await f.forward();
   await object().alarm();expect(posts()).toBe(1);
   clock.mockReturnValue(now+180000);await object().alarm();
   expect(posts()).toBe(2);expect(await storage.get('__alarm')).toBe(now+360000);
   clock.mockReturnValue(now+360000);await object().alarm();await object().alarm();await f.forward();
   expect(posts()).toBe(3);expect(await storage.get('pagesRetry')).toBeUndefined();
   expect(f.db.database.prepare('SELECT count(*) n,central_run_id FROM pages_completion_dispatches').get()).toEqual({n:1,central_run_id:99});
 }finally{clock.mockRestore();}
});

it('retains the D1 reservation after an uncertain 503 and reconciles on redelivery without another POST',async()=>{
 const f=fixture();f.result.rejections=1;f.result.rejectionStatus=503;f.result.visible=false;
 await expect(f.forward()).rejects.toThrow('RETRY_AFTER:180');
 await expect(f.forward()).rejects.toThrow('PAGES_DISPATCH_UNCONFIRMED');
 Object.assign(f.prior,{total_count:1,workflow_runs:[f.receipt]});
 await f.forward();expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(1);
 expect(f.db.database.prepare('SELECT central_run_id FROM pages_completion_dispatches').get()?.central_run_id).toBe(99);
});
it('a restored retry ticket cannot reacquire a newer reservation after rollback or restart',async()=>{
 const storage=new SqliteDurableStorage(),f=fixture(storage);let ticket:any;
 f.result.rejections=1;await f.forward();ticket=await storage.get('pagesRetry');
 const obj=()=>new PagesRetry(storage as any,f.config,()=>f.g,[f.site]);
 f.db.database.prepare('UPDATE pages_completion_dispatches SET reserved_at=?,retry_after=NULL').run(new Date(ticket.due).toISOString());
 const clock=vi.spyOn(Date,'now').mockReturnValue(ticket.due);
 try{await obj().alarm();await obj().alarm();}finally{clock.mockRestore();}
 expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(1);expect(await storage.get('pagesRetry')).toBeUndefined();
});

it('does not issue a retry ticket for an ordinary permission-denied 403',async()=>{
 const f=fixture();f.result.denied=true;f.result.visible=false;
 await expect(f.forward()).rejects.toThrow('GITHUB_HTTP_403');
 await expect(f.forward()).rejects.toThrow('PAGES_DISPATCH_UNCONFIRMED');
 expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(1);
});

it.each([false,true])('bounds receipt-only alarm recovery when the receipt becomes visible: %s',async visible=>{
 const store=new SqliteDurableStorage(),f=fixture(store);
 const object=()=>new PagesRetry(store as any,f.config,()=>f.g,[f.site]);
 f.result.visible=false;await expect(f.forward()).rejects.toThrow('PAGES_DISPATCH_UNCONFIRMED');
 if(visible)Object.assign(f.prior,{total_count:1,workflow_runs:[f.receipt]});
 const clock=vi.spyOn(Date,'now');
 try{
   for(let i=0;i<5;i++){
     const alarm=await store.get<number>('__alarm');if(alarm===undefined)break;
     clock.mockReturnValue(alarm);await object().alarm();
   }
 }finally{clock.mockRestore();}
 expect(await store.get('__alarm')).toBeUndefined();
 expect(await store.get('pagesWatch')).toBeUndefined();
 expect(f.db.database.prepare('SELECT central_run_id FROM pages_completion_dispatches').get()?.central_run_id).toBe(visible?99:null);
 expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(1);
});

it('honors a receipt GET retry floor beyond the remaining observation window',async()=>{
 const store=new SqliteDurableStorage(),f=fixture(store);
 const object=()=>new PagesRetry(store as any,f.config,()=>f.g,[f.site]);
 f.result.visible=false;await expect(f.forward()).rejects.toThrow('PAGES_DISPATCH_UNCONFIRMED');
 const first=(await store.get<number>('__alarm'))!,clock=vi.spyOn(Date,'now').mockReturnValue(first);
 try{
   f.json.mockRejectedValueOnce(new GitHubRetryError(429,'601',false));
   await object().alarm();
   const callsBeforeRedelivery=f.json.mock.calls.length;await expect(f.forward()).rejects.toThrow('PAGES_DISPATCH_UNCONFIRMED');
   expect(f.json.mock.calls).toHaveLength(callsBeforeRedelivery);
   const deadline=(await store.get<number>('__alarm'))!;
   expect(deadline-first).toBeGreaterThan(5*60000);expect(deadline-first).toBeLessThanOrEqual(601000);
   const calls=f.json.mock.calls.length;clock.mockReturnValue(deadline);await object().alarm();
   expect(f.json.mock.calls).toHaveLength(calls);expect(await store.get('__alarm')).toBeUndefined();
   expect(f.db.database.prepare('SELECT retry_after,central_run_id FROM pages_completion_dispatches').get()).toEqual({retry_after:null,central_run_id:null});
 }finally{clock.mockRestore();}
});

it('requires a durable watch before reserving or dispatching',async()=>{
 const f=fixture();
 f.config.BOUNDED_RECHECK.get=()=>({fetch:async()=>new Response(null,{status:503})});
 await expect(f.forward()).rejects.toThrow('PAGES_INTAKE_REGISTRATION');
 expect(f.db.database.prepare('SELECT COUNT(*) AS n FROM pages_completion_dispatches').get()?.n).toBe(0);
 expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(0);
});

it('reconstructs a rejected ticket from D1 without redelivery when the first ticket write failed',async()=>{
 const storage=new SqliteDurableStorage(),f=fixture(storage);let unavailable=true;
 const object=()=>new PagesRetry(storage as any,f.config,()=>f.g,[f.site]);
 const persist=storage.put.bind(storage);
 storage.put=async(key,value)=>{if(key==='pagesRetry'&&unavailable)throw Error('DO_UNAVAILABLE');await persist(key,value);};
 f.result.rejections=1;await expect(f.forward()).rejects.toThrow('DO_UNAVAILABLE');
 const row=f.db.database.prepare('SELECT reserved_at,retry_after FROM pages_completion_dispatches').get()!;
 expect(row.retry_after).toBeGreaterThan(Date.now());expect(await storage.get('pagesRetry')).toBeUndefined();
 unavailable=false;
 const probe=await storage.get<number>('__alarm');expect(probe).toBeGreaterThan(Date.now());
 const clock=vi.spyOn(Date,'now').mockReturnValue(probe!);
 try{
   await object().alarm();
   expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(1);
   const retry=await storage.get<number>('__alarm');expect(retry).toBeGreaterThanOrEqual(Number(row.retry_after));
   clock.mockReturnValue(Math.max(probe!,retry!));await object().alarm();await object().alarm();
 }finally{clock.mockRestore();}
 expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(2);
 expect(f.db.database.prepare('SELECT retry_after,central_run_id FROM pages_completion_dispatches').get()).toEqual({retry_after:null,central_run_id:99});
});

it('keeps a reservation unconfirmed if writing the rejection proof fails',async()=>{
 const f=fixture();f.result.rejections=1;f.result.visible=false;
 f.db.database.exec("CREATE TRIGGER fail_marker BEFORE UPDATE OF retry_after ON pages_completion_dispatches BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
 await expect(f.forward()).rejects.toThrow('injected failure');
 f.db.database.exec('DROP TRIGGER fail_marker');
 await expect(f.forward()).rejects.toThrow('PAGES_DISPATCH_UNCONFIRMED');
 expect(f.db.database.prepare('SELECT retry_after FROM pages_completion_dispatches').get()).toEqual({retry_after:null});
 expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(1);
});

it.each(['quiesced','other pin'])('rearms a rejected Pages dispatch while %s and resumes at its original pin',async mode=>{
 const store=new SqliteDurableStorage(),f=fixture(store);
 const object=()=>new PagesRetry(store as any,f.config,()=>f.g,[f.site]);
 f.result.rejections=1;await f.forward();
 const clock=vi.spyOn(Date,'now').mockReturnValue((await store.get<number>('__alarm'))!);
 try{
   if(mode==='quiesced')f.config.BOUNDED_RECHECK_ENABLED='false';else f.config.BOUNDED_CONTROLLER_SHA=source;
   await object().alarm();
   expect(await store.get<number>('__alarm')).toBeGreaterThan(Date.now());
   expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(1);
   f.config.BOUNDED_RECHECK_ENABLED='true';f.config.BOUNDED_CONTROLLER_SHA=pin;
   clock.mockReturnValue((await store.get<number>('__alarm'))!);await object().alarm();
   expect(f.db.database.prepare('SELECT central_run_id FROM pages_completion_dispatches').get()?.central_run_id).toBe(99);
 }finally{clock.mockRestore();}
});

it('recovers a newer D1 rejection when the second alarm ticket could not be persisted',async()=>{
 const store=new SqliteDurableStorage(),f=fixture(store),now=Date.now();
 const clock=vi.spyOn(Date,'now').mockReturnValue(now);
 const object=()=>new PagesRetry(store as any,f.config,()=>f.g,[f.site]);
 try{
   f.result.rejections=2;await f.forward();const first=await store.get<any>('pagesRetry');
   const put=store.put.bind(store);let fail=true;
   store.put=async(key,value)=>{
     if(key==='pagesRetry'&&fail&&(value as any).reservation!==first.reservation){fail=false;throw Error('DO_STORAGE_INTERRUPTED');}
     return put(key,value);
   };
   clock.mockReturnValue(first.due);await object().alarm();
   const next=f.db.database.prepare('SELECT reserved_at,retry_after FROM pages_completion_dispatches').get()!;
   expect(next.reserved_at).not.toBe(first.reservation);expect(await store.get<any>('pagesRetry')).toMatchObject({reservation:first.reservation});
   clock.mockReturnValue((await store.get<number>('__alarm'))!);await object().alarm();
   expect(await store.get('pagesRetry')).toMatchObject({reservation:next.reserved_at,due:next.retry_after});
   expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(2);
   clock.mockReturnValue(Number(next.retry_after));await object().alarm();await object().alarm();
   expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(3);
   expect(f.db.database.prepare('SELECT central_run_id FROM pages_completion_dispatches').get()?.central_run_id).toBe(99);
 }finally{clock.mockRestore();}
});

it('recovers a second registered public repository after preflight is throttled without redelivery',async()=>{
 const store=new SqliteDurableStorage(),other={id:7654321,name:'splrad/another-product'},f=fixture(store,other);
 const obj=()=>new PagesRetry(store as any,f.config,()=>f.g,[f.site]);
 const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now());
 try{
   f.json.mockRejectedValueOnce(new GitHubRetryError(429,'600',false));
   await expect(f.forward()).rejects.toThrow('RETRY_AFTER:600');const start=Date.now();
   expect(await store.getAlarm()).toBe(start+600000);expect(f.json).toHaveBeenCalledTimes(1);
   clock.mockReturnValue(start+300000);await obj().alarm();expect(f.json).toHaveBeenCalledTimes(1);
   clock.mockReturnValue(start+600000);await obj().alarm();
   expect(f.json.mock.calls.some(([id,path])=>id===other.id&&path==='/repos/'+other.name+'/actions/runs/12')).toBe(true);
   expect(f.json.mock.calls.filter(c=>c[2]==='POST')).toHaveLength(1);
   expect(f.db.database.prepare('SELECT repository_id,central_run_id FROM pages_completion_dispatches').get()).toEqual({repository_id:other.id,central_run_id:99});
   expect(await store.get('pagesIntake')).toBeUndefined();
 }finally{clock.mockRestore();}
});
it('requires the registered id, name and workflow before acquiring storage or reading GitHub',async()=>{
 const f=fixture(),binding=vi.fn(()=>{throw Error('unexpected storage access');});f.config.BOUNDED_RECHECK.get=binding;
 for(const sites of [[],[{...f.site,repository:'splrad/other'}],[{...f.site,repositoryId:7}],[{...f.site,workflowId:7}]])
   await forwardPagesCompletion(f.config,'workflow_run',f.payload,sites);
 expect(binding).not.toHaveBeenCalled();expect(f.json).not.toHaveBeenCalled();
});

it('scopes a Pages source token to the enrolled repository and read-only actions and metadata',async()=>{
 const {generateKeyPairSync}=await import('node:crypto');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{format:'pem',type:'pkcs8'},publicKeyEncoding:{format:'pem',type:'spki'}});
 const site={id:7654321,name:'splrad/another-product'},permissions={metadata:'read',actions:'read'};
 const transport=vi.fn(async(url:any,init:any)=>{
   const path=new URL(String(url)).pathname;
   if(path.endsWith('/access_tokens')){
     expect(JSON.parse(init.body)).toEqual({repository_ids:[site.id],permissions});return Response.json({token:'offline',permissions});
   }
   if(path==='/installation/repositories')return Response.json({total_count:1,repositories:[{id:site.id,full_name:site.name}]});
   expect(path).toBe('/repos/'+site.name+'/actions/workflows/pages.yml');return Response.json({state:'active'});
 });
 const reader=new BoundedGitHub({...env,APP_ID:'1',STEWARD_APP_PRIVATE_KEY:privateKey},transport as any,undefined,site);
 await expect(reader.json(site.id,'/repos/'+site.name+'/actions/workflows/pages.yml')).resolves.toEqual({state:'active'});
 await expect(reader.json(TARGET.id,'/repos/'+TARGET.name+'/actions/workflows/pages.yml')).rejects.toThrow('FIXED_REPOSITORY');
 expect(transport).toHaveBeenCalledTimes(3);
});
