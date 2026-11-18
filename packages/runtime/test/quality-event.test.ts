import {expect,it,vi} from 'vitest';
import {dispatchQualityEvent,qualityLocator} from '../src/quality-event.js';
const sha='a'.repeat(40),id=1296724484,install=123;
const repo={id,private:false,owner:{id:302208797}};
const base={action:'completed',installation:{id:install},repository:repo};
const run={status:'completed',conclusion:'success',repository:repo,event:'dynamic',path:'dynamic/github-code-quality/codeql',head_branch:'refs/pull/337/head',head_sha:sha};
const target={repository_id:String(id),pull_number:'337',head_sha:sha};
it('targets the native dynamic run even when GitHub lists no associated pulls', async()=>{
 const payload={...base,workflow_run:{...run,pull_requests:[]}};
 expect(qualityLocator('workflow_run',payload,install)).toEqual(target);
 for(const change of [{conclusion:'failure'},{path:'.github/workflows/codeql.yml'},{head_branch:'main'},{event:'push'}])
   expect(qualityLocator('workflow_run',{...payload,workflow_run:{...run,...change}},install)).toBeUndefined();
 const json=vi.fn(async(_id:number,path:string)=>path.endsWith('/main')?{object:{sha}}:
   {path:'.github/workflows/quality-language-summary.yml',state:'active'});
 await dispatchQualityEvent({INSTALLATION_ID:String(install)} as any,'workflow_run',payload,{json} as any);
 expect(json).toHaveBeenLastCalledWith(id,'/repos/splrad/steward/actions/workflows/quality-language-summary.yml/dispatches',
   'POST',{ref:'main',inputs:{...target,policy_sha:sha}});
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
