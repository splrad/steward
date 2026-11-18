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
