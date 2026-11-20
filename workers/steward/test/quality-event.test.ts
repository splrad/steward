import {expect,it,vi} from 'vitest';
import {GitHubRetryError} from '../src/bounded-retry-after.js';
import {QualityEvent,qualityLocator} from '../src/quality-event.js';
const sha='a'.repeat(40),id=1296724484,install=123;
function qualityFile(repositories:Record<string,unknown>) {
 const content=Buffer.from(JSON.stringify({schemaVersion:1,repositories}));
 return {type:'file',path:'config/review/quality-language.json',size:content.length,encoding:'base64',content:content.toString('base64')};
}
const repo={id,private:false,owner:{id:302208797}};
const base={action:'completed',installation:{id:install},repository:repo};
const run={status:'completed',conclusion:'success',repository:repo,event:'dynamic',path:'dynamic/github-code-quality/codeql',head_branch:'refs/pull/337/head',head_sha:sha};
const target={repository_id:String(id),pull_number:'337',head_sha:sha};
it('targets the native dynamic run even when GitHub lists no associated pulls', async()=>{
 const payload={...base,workflow_run:{...run,pull_requests:[]}};
 expect(qualityLocator('workflow_run',payload,install)).toEqual(target);
 for(const change of [{conclusion:'failure'},{path:'.github/workflows/codeql.yml'},{head_branch:'main'},{event:'push'}])
   expect(qualityLocator('workflow_run',{...payload,workflow_run:{...run,...change}},install)).toBeUndefined();
 let config=Buffer.from(JSON.stringify({schemaVersion:1,enabled:true,deploymentSha:sha}));
 const repositories:Record<string,unknown>={[id]:'splrad/steward'};
 const json=vi.fn(async(_id:number,path:string)=>path.includes('/git/ref/')?{ref:'refs/'+path.split('/git/ref/')[1],object:{type:'commit',sha}}:
   path.includes('quality-language.json')?qualityFile(repositories):
   path.includes('/contents/')?{type:'file',path:'config/bounded-recheck.json',size:config.length,encoding:'base64',content:config.toString('base64')}:
   {path:'.github/workflows/quality-language-summary.yml',state:'active'});
 const {SqliteDurableStorage}=await import('./bounded-storage.js');
 const storage=new SqliteDurableStorage();
 const pending:string[]=[];
 const ns={idFromName:(key:string)=>key,get:()=>({fetch:async(request:Request)=>{
   const path=new URL(request.url).pathname;
   if(path==='/wait')pending.push(await request.text());
   return Response.json({generation:0});
 }})};
 const env={INSTALLATION_ID:String(install),BOUNDED_RECHECK_ENABLED:'true',BOUNDED_DEPLOYMENT_SHA:'c'.repeat(40),BOUNDED_RECHECK:ns};
 const object=new QualityEvent(storage as any,env as any,()=>({json} as any));
 const record={delivery:'delivery-123',event:'workflow_run',target,phase:'pending' as const};
 await object.register(record);
 expect(pending.map(x=>JSON.parse(x).kind)).toEqual(['quality']);
 expect(json.mock.calls.some(([,path])=>path.endsWith('/dispatches'))).toBe(false);
 config=Buffer.from(JSON.stringify({schemaVersion:1,enabled:true,deploymentSha:env.BOUNDED_DEPLOYMENT_SHA}));
 await object.forward();await object.register(record);await object.forward();
 expect(json.mock.calls.filter(([,path])=>path.endsWith('/dispatches'))).toHaveLength(1);
 expect(json).toHaveBeenLastCalledWith(id,'/repos/splrad/steward/actions/workflows/quality-language-summary.yml/dispatches',
   'POST',{ref:'main',inputs:{...target,policy_sha:sha}});
 const newTarget={...target,repository_id:'23456789'};
 for(const entry of [undefined,true,{},'', 'splrad/new-public']){
   repositories[newTarget.repository_id]=entry;
   const next=new QualityEvent(new SqliteDurableStorage() as any,env as any,()=>({json} as any));
   await next.register({...record,target:newTarget});
   expect(json.mock.calls.filter(([,path])=>path.endsWith('/dispatches'))).toHaveLength(entry==='splrad/new-public'?2:1);
 }

});
it('forwards edits and deletions from the native author on a registered public PR only',()=>{
 const payload={...base,action:'deleted',comment:{user:{id:223894421,type:'Bot'}},
   pull_request:{number:337,state:'open',base:{repo},head:{sha}}};
 expect(qualityLocator('pull_request_review_comment',payload,install)).toEqual(target);
 expect(qualityLocator('pull_request_review',{...payload,action:'edited',review:payload.comment},install)).toEqual(target);
 for(const change of [{repository:{...repo,private:true}},{repository:{...repo,id:123}},{installation:{id:999}},
   {comment:{user:{id:1,type:'Bot',login:'github-code-quality[bot]'}}},{action:'unrelated'}])
   expect(qualityLocator('pull_request_review_comment',{...payload,...change},install)).toBeUndefined();
});

it.each(['created','edited','deleted'])('discards a signed private review comment at the HTTP boundary (%s)',async action=>{
 const {createHmac}=await import('node:crypto');
 const {handleWebhook}=await import('../src/index.js');
 const body=JSON.stringify({action,organization:{id:302208797},installation:{id:123},
   repository:{id:1296724484,private:true,owner:{id:302208797}},
   comment:{id:42,body:'private fixture text',user:{id:223894421,type:'Bot'}}});
 const secret='test-only',signature=createHmac('sha256',secret).update(body).digest('hex');
 const env=new Proxy({STEWARD_WEBHOOK_SECRET:secret,ORGANIZATION_ID:'302208797',INSTALLATION_ID:'123'},{
   get(obj,key){if(!Object.hasOwn(obj,key))throw Error('Unexpected downstream binding '+String(key));return Reflect.get(obj,key);}
 });
 const external=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('unexpected network')});
 const logs=[vi.spyOn(console,'error'),vi.spyOn(console,'log'),vi.spyOn(console,'warn'),vi.spyOn(console,'info')];
 try{
   const request=(sig:string)=>new Request('https://example.test/github/webhook',{method:'POST',body,headers:{
     'x-github-event':'pull_request_review_comment','x-hub-signature-256':'sha256='+sig}});
   expect((await handleWebhook(request('00'),env as any)).status).toBe(401);
   const result=await handleWebhook(request(signature),env as any);
   expect(result.status).toBe(204);expect(await result.text()).toBe('');
   expect(external).not.toHaveBeenCalled();for(const log of logs)expect(log).not.toHaveBeenCalled();
 }finally{external.mockRestore();for(const log of logs)log.mockRestore();}
});

it.each([['GITHUB_HTTP_422',2],['RETRY_AFTER:3',2],['RETRY_AFTER:unknown',2],['proxy503',1],['unconfirmed transport failure',1]] as const)('redelivers only an explicitly rejected quality POST (%s)',async(message,expected)=>{
 const {SqliteDurableStorage}=await import('./bounded-storage.js');
 const storage=new SqliteDurableStorage(),config=Buffer.from(JSON.stringify({schemaVersion:1,enabled:true,deploymentSha:sha}));
 let posts=0;
 const json=async(_id:number,path:string,method?:string)=>{
   if(method==='POST'){if(++posts===1)throw message==='proxy503'?new GitHubRetryError(503,'unknown',true):Error(message);return {};}
   if(path.includes('/git/ref/'))return {ref:'refs/'+path.split('/git/ref/')[1],object:{type:'commit',sha}};
   if(path.includes('quality-language.json'))return qualityFile({[id]:'splrad/steward'});
   if(path.includes('/contents/'))return {type:'file',path:'config/bounded-recheck.json',encoding:'base64',size:config.length,content:config.toString('base64')};
   return {path:'.github/workflows/quality-language-summary.yml',state:'active'};
 };
 const object=new QualityEvent(storage as any,{BOUNDED_RECHECK_ENABLED:'true',RELEASE_RELAY_DEPLOYMENT_SHA:sha} as any,()=>({json} as any));
 const record={delivery:'one-delivery',event:'workflow_run',target,phase:'pending' as const};
 await expect(object.register(record)).rejects.toThrow(message==='proxy503'?'RETRY_AFTER:unknown':message);
 if(message.startsWith('RETRY_AFTER:')){
   const next=await storage.get<number>('__alarm');
   expect(next).toBeGreaterThan(Date.now());
   await object.alarm();
   expect(posts).toBe(1);
   const clock=vi.spyOn(Date,'now').mockReturnValue(next!);
   try{await object.alarm();await object.alarm();}finally{clock.mockRestore();}
 }else if(expected===2)await object.register(record);
 else await expect(object.register(record)).rejects.toThrow('QUALITY_POST_UNCONFIRMED');
 expect(posts).toBe(expected);
});

it.each(['/git/ref/heads/main','/contents/config/review/quality-language.json','/actions/workflows/quality-language-summary.yml'])('recovers quality preflight rate limits at %s',async limitedPath=>{
 const {SqliteDurableStorage}=await import('./bounded-storage.js');
 const storage=new SqliteDurableStorage(),config=Buffer.from(JSON.stringify({schemaVersion:1,enabled:true,deploymentSha:sha}));
 let limited=true,posts=0;
 const json=async(_id:number,path:string,method?:string)=>{
  if(method==='POST'){posts++;return {};}
  if(limited && path.includes(limitedPath)){limited=false;throw new GitHubRetryError(429,'30',false);}
  if(path.includes('/git/ref/'))return {ref:'refs/'+path.split('/git/ref/')[1],object:{type:'commit',sha}};
  if(path.includes('quality-language.json'))return qualityFile({[id]:'splrad/steward'});
  if(path.includes('/contents/'))return {type:'file',path:'config/bounded-recheck.json',encoding:'base64',size:config.length,content:config.toString('base64')};
  return {path:'.github/workflows/quality-language-summary.yml',state:'active'};
 };
 const object=()=>new QualityEvent(storage as any,{BOUNDED_RECHECK_ENABLED:'true',RELEASE_RELAY_DEPLOYMENT_SHA:sha} as any,()=>({json} as any));
 await expect(object().register({delivery:'quality-read',event:'workflow_run',target,phase:'pending'})).rejects.toThrow('RETRY_AFTER:30');
 const next=await storage.get<number>('__alarm');expect(next).toBeGreaterThan(Date.now());
 await object().alarm();expect(posts).toBe(0);
 const clock=vi.spyOn(Date,'now').mockReturnValue(next!);
 try{await object().alarm();await object().alarm();}finally{clock.mockRestore();}
 expect(posts).toBe(1);expect(await storage.get('qualityEvent')).toMatchObject({phase:'sent'});
});
