import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {GitHubClient} from '../src/client.js';
import {evaluateRemoteWorkflowContract} from '../src/workflow-contract.js';
import {canonicalContract,contractApprovalText,type WorkflowContract} from '../../core/src/workflow-contract.js';
const baseline:WorkflowContract={version:1,repositoryId:99,fragments:'required',sharedQueues:{}};
const candidate:WorkflowContract={...baseline,fragments:'retired'};
const head='a'.repeat(40),base='b'.repeat(40),policy='c'.repeat(40);
const binding={repositoryId:99,pullNumber:7,headSha:head,baseSha:base,policySha:policy,contractDigest:createHash('sha256').update(canonicalContract(candidate)).digest('hex')};
function setup(options:{state?:string;permission?:string;mutate?:boolean;missing?:boolean;denied?:boolean;body?:string;adopted?:boolean;unreviewedBase?:boolean;priorState?:string;ancestry?:string;priorAuthor?:number;priorPolicy?:string;fork?:boolean;priorFork?:boolean;missingPriorRepo?:boolean;priorLateState?:string;lateState?:string;latePermission?:string}={}){
 let reads=0, reviewReads=0, priorReviewReads=0, permissionReads=0;
 const transport:typeof fetch=async(input)=>{
  const u=new URL(String(input));
  let value:any;
  if(u.pathname==='/repos/test/project/commits')value=[{sha:'f'.repeat(40),parents:[{sha:'e'.repeat(40)}]}];
  else if(u.pathname.endsWith('/commits/'+ 'f'.repeat(40)+'/pulls'))value=options.unreviewedBase?[]:[{number:6}];
  else if(u.pathname.endsWith('/pulls/6'))value={number:6,merged:true,user:{id:options.priorAuthor??1},merge_commit_sha:'f'.repeat(40),head:{sha:'d'.repeat(40),repo:options.missingPriorRepo?null:{id:options.priorFork?100:99}},base:{sha:'e'.repeat(40),repo:{id:99}}};
  else if(u.pathname.includes('/compare/'))value={status:options.ancestry??'ahead'};
  else if(u.pathname.endsWith('/pulls/6/reviews'))value=[{id:2,user:{id:2,login:'reviewer',type:'User'},state:++priorReviewReads>1?(options.priorLateState??options.priorState??'APPROVED'):(options.priorState??'APPROVED'),commit_id:'d'.repeat(40),body:contractApprovalText({...binding,pullNumber:6,headSha:'d'.repeat(40),baseSha:'e'.repeat(40),policySha:options.priorPolicy??policy}),submitted_at:'2026-10-19T00:00:00Z'}];
  else if(u.pathname==='/repositories/100')value={id:100,full_name:'contributor/fork'};
  else if(u.pathname==='/repositories/99')value={id:99,full_name:'test/project',default_branch:'main'};
  else if(u.pathname.endsWith('/pulls/7'))value={number:7,state:'open',user:{id:1},head:{sha:options.mutate&&++reads>1?'e'.repeat(40):head,repo:{id:options.fork?100:99}},base:{sha:base,ref:'main',repo:{id:99}}};
  else if(u.pathname.includes('/contents/')){
   if(options.fork&&u.searchParams.get('ref')===head)expect(u.pathname).toBe('/repos/contributor/fork/contents/.github/workflow-contract.json');
   if(options.priorFork&&u.searchParams.get('ref')==='d'.repeat(40))expect(u.pathname).toBe('/repos/contributor/fork/contents/.github/workflow-contract.json');
   expect([head,base,'d'.repeat(40),'e'.repeat(40),'f'.repeat(40)]).toContain(u.searchParams.get('ref'));
   if(options.missing||options.denied)return new Response('{}',{status:options.denied?403:404});
   value={type:'file',encoding:'base64',size:100,content:Buffer.from(JSON.stringify((u.searchParams.get('ref')===base&&!options.adopted)||u.searchParams.get('ref')==='e'.repeat(40)?baseline:candidate)).toString('base64')};
  }else if(u.pathname.endsWith('/reviews'))value=[{id:1,user:{id:2,login:'reviewer',type:'User'},state:++reviewReads>1?(options.lateState??options.state??'APPROVED'):(options.state??'APPROVED'),commit_id:head,body:options.body??contractApprovalText(binding),submitted_at:'2026-10-20T00:00:00Z'}];
  else if(u.pathname.endsWith('/permission'))value={permission:++permissionReads>1?(options.latePermission??options.permission??'write'):(options.permission??'write'),user:{id:2}};
  else throw new Error('unexpected '+u.pathname);
  return new Response(JSON.stringify(value),{status:200});
 };
 return new GitHubClient('read-only-test-token','https://api.github.com',transport,policy);
}
const authority={repositoryId:99,baseline,approverIds:[2]};
describe('remote workflow contract evidence',()=>{
 it.each([{priorLateState:'DISMISSED'},{latePermission:'read'}])('rejects historical adoption revoked during evaluation %j',async options=>{
  await expect(evaluateRemoteWorkflowContract(setup({adopted:true,...options}),authority,7,policy)).rejects.toThrow('CONTRACT_BASE_UNADOPTED');
 });
 it.each([{lateState:'DISMISSED'},{lateState:'CHANGES_REQUESTED'},{latePermission:'read'}])('rejects approval revoked during evaluation %j',async options=>{
  await expect(evaluateRemoteWorkflowContract(setup(options),authority,7,policy)).rejects.toThrow('APPROVAL_REQUIRED');
 });
 it('reads historical fork adoption from the verified fork repository',async()=>{
  expect((await evaluateRemoteWorkflowContract(setup({adopted:true,priorFork:true}),authority,7,policy)).reviewId).toBeNull();
 });
 it('fails closed when historical head repository identity is unavailable',async()=>{
  await expect(evaluateRemoteWorkflowContract(setup({adopted:true,missingPriorRepo:true}),authority,7,policy)).rejects.toThrow('missing historical head repository');
 });
 it('reads a fork declaration from its API-verified repository at exact head',async()=>{
  expect((await evaluateRemoteWorkflowContract(setup({fork:true}),authority,7,policy)).reviewId).toBe(1);
 });
 it('carries only explicitly trusted historical adoption policies across evaluator upgrades',async()=>{
  const priorPolicy='1'.repeat(40);
  const migrated={...authority,adoptionPolicies:{[binding.contractDigest]:priorPolicy}};
  await expect(evaluateRemoteWorkflowContract(setup({adopted:true,priorPolicy}),authority,7,policy)).rejects.toThrow('CONTRACT_BASE_UNADOPTED');
  expect((await evaluateRemoteWorkflowContract(setup({adopted:true,priorPolicy,state:'COMMENTED'}),migrated,7,policy)).reviewId).toBeNull();
  await expect(evaluateRemoteWorkflowContract(setup({adopted:true,priorPolicy,priorState:'DISMISSED'}),migrated,7,policy)).rejects.toThrow('CONTRACT_BASE_UNADOPTED');
  await expect(evaluateRemoteWorkflowContract(setup({body:contractApprovalText({...binding,policySha:priorPolicy})}),migrated,7,policy)).rejects.toThrow('APPROVAL_REQUIRED');
 });
 it('reads exact-head contract and independent native approval',async()=>{
  expect((await evaluateRemoteWorkflowContract(setup(),authority,7,policy)).reviewId).toBe(1);
 });
 it('does not require another approval for a contract already adopted on the protected base',async()=>{
  expect((await evaluateRemoteWorkflowContract(setup({adopted:true,state:'COMMENTED'}),authority,7,policy)).reviewId).toBeNull();
 });
 it('rejects an unreviewed contract preseeded on base',async()=>{
  await expect(evaluateRemoteWorkflowContract(setup({adopted:true,unreviewedBase:true}),authority,7,policy)).rejects.toThrow('CONTRACT_BASE_UNADOPTED');
 });
 it.each([{priorState:'DISMISSED'},{priorState:'CHANGES_REQUESTED'},{permission:'read'},{ancestry:'diverged'},{priorAuthor:2}])('rejects invalid adoption evidence %j',async options=>{
  await expect(evaluateRemoteWorkflowContract(setup({adopted:true,...options}),authority,7,policy)).rejects.toThrow('CONTRACT_BASE_UNADOPTED');
 });
 it.each(['DISMISSED','CHANGES_REQUESTED','COMMENTED'])('denies review state %s',async state=>{
  await expect(evaluateRemoteWorkflowContract(setup({state}),authority,7,policy)).rejects.toThrow('APPROVAL_REQUIRED');
 });
 it('denies lost permissions and edited approval text',async()=>{
  await expect(evaluateRemoteWorkflowContract(setup({permission:'read'}),authority,7,policy)).rejects.toThrow('APPROVAL_REQUIRED');
  await expect(evaluateRemoteWorkflowContract(setup({body:'approved'}),authority,7,policy)).rejects.toThrow('APPROVAL_REQUIRED');
 });
 it('does not turn an API failure into baseline approval',async()=>{
  await expect(evaluateRemoteWorkflowContract(setup({denied:true}),authority,7,policy)).rejects.toThrow('403');
 });
 it('missing declaration preserves trusted requirements',async()=>{
  expect((await evaluateRemoteWorkflowContract(setup({missing:true}),authority,7,policy)).contract).toEqual(baseline);
 });
 it('rereads the pull to reject a concurrent push',async()=>{
  await expect(evaluateRemoteWorkflowContract(setup({mutate:true}),authority,7,policy)).rejects.toThrow('STALE');
 });
});
