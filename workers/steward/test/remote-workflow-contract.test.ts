import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {GitHubRequestError,trustedActionsDownload,type GitHubClient} from '../support/github/client.js';
import {canonicalContract,contractApprovalText,type WorkflowContract} from '../support/core/workflow-contract.js';
import {evaluateRemoteWorkflowContract} from '../support/github/workflow-contract.js';

const base='a'.repeat(40),head='b'.repeat(40),policy='c'.repeat(40);
function fixture(){
 const baseline:WorkflowContract={version:1,repositoryId:10,fragments:'required',sharedQueues:{}};
 const candidate:WorkflowContract={...baseline,fragments:'retired'};
 const authority={repositoryId:10,approverIds:[7],baseline};
 const repo={id:10,full_name:'test/project',default_branch:'main'};
 const pull={number:12,state:'open',base:{repo,ref:'main',sha:base},head:{repo:{id:20},sha:head},user:{id:6}};
 const binding={repositoryId:10,pullNumber:12,headSha:head,baseSha:base,policySha:policy,
   contractDigest:createHash('sha256').update(canonicalContract(candidate)).digest('hex')};
 const review={id:11,user:{id:7,login:'reviewer',type:'User'},commit_id:head,state:'APPROVED',
   body:contractApprovalText(binding),submitted_at:'2026-01-01T00:00:00Z'};
 const file=(value:WorkflowContract)=>{
   const bytes=Buffer.from(JSON.stringify(value));
   return {type:'file',encoding:'base64',size:bytes.length,content:bytes.toString('base64')};
 };
 const client={getRepositoryById:vi.fn(async()=>repo),getPullRequest:vi.fn(async()=>pull),
   getRef:vi.fn(async()=>({ref:'refs/pull/12/head',object:{type:'commit',sha:head}})),
   getContent:vi.fn(async(_owner:string,_name:string,_path:string,ref:string)=>file(ref===base?baseline:candidate)),
   listPullRequestReviews:vi.fn(async()=>[review]),getCollaboratorPermission:vi.fn(async()=>({user:{id:7},permission:'write'})),
   getCommit:vi.fn(async(_o:string,_n:string,sha:string)=>({sha,commit:{tree:{sha:base}}})),
   request:vi.fn(async():Promise<any>=>[])};
 return {client,pull,review,baseline,candidate,file,run:()=>evaluateRemoteWorkflowContract(client as unknown as GitHubClient,authority,12,policy)};
}
it('binds a fork review to its native PR ref and rechecks the PR after the final approval',async()=>{
 const f=fixture();
 expect((await f.run()).reviewId).toBe(11);
 expect(f.client.getRef).toHaveBeenCalledWith('test','project','pull/12/head');
 expect(f.client.getPullRequest).toHaveBeenCalledTimes(3);
});
it.each(['ref','approval','permission','head','history'])('rejects stale contract evidence: %s',async kind=>{
 const f=fixture();
 if(kind==='ref')f.client.getRef.mockResolvedValue({ref:'refs/pull/12/head',object:{type:'commit',sha:base}});
 if(kind==='approval')f.client.listPullRequestReviews.mockResolvedValueOnce([f.review]).mockResolvedValue([]);
 if(kind==='permission')f.client.getCollaboratorPermission.mockResolvedValueOnce({user:{id:7},permission:'write'}).mockResolvedValue({user:{id:7},permission:'read'});
 if(kind==='head')f.client.getPullRequest.mockResolvedValueOnce(f.pull).mockResolvedValueOnce(f.pull).mockResolvedValue({...f.pull,head:{...f.pull.head,sha:policy}});
 if(kind==='history')f.client.getContent.mockResolvedValue(f.file(f.candidate));
 await expect(f.run()).rejects.toThrow(kind==='history'?/CONTRACT_BASE/:kind==='ref'||kind==='head'?/CONTRACT_SOURCE_STALE/:/CONTRACT_APPROVAL_REQUIRED/);
});
it.each([true,false])('requires a complete tree to inherit a missing declaration (%s)',async complete=>{
 const f=fixture();
 f.client.getContent.mockRejectedValue(new GitHubRequestError(404,'GET','contents','missing'));
 f.client.request.mockResolvedValue({sha:base,truncated:!complete,tree:[]});
 if(complete)expect((await f.run()).contract).toEqual(f.baseline);
 else await expect(f.run()).rejects.toThrow('incomplete source tree');
});
it('accepts only the supported GitHub Actions download origins',()=>{
 for(const url of ['https://test.blob.core.windows.net/file?sig=abc','https://test.actions.githubusercontent.com/file'])expect(trustedActionsDownload(new URL(url))).toBe(true);
 for(const url of ['https://example.org/file','https://test.blob.core.windows.net:8443/file','https://test.actions.githubusercontent.com/file#fragment'])expect(trustedActionsDownload(new URL(url))).toBe(false);
});
