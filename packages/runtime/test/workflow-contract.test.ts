import {createHash,generateKeyPairSync} from 'node:crypto';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {refreshWorkflowContractChecks,type Env} from '../src/index.js';
import authorities from '../../../config/workflow-contract-authority.json' with {type:'json'};
import {canonicalContract,contractApprovalText,type WorkflowContract} from '../../core/src/workflow-contract.js';
const repositoryId=1296724484,head='a'.repeat(40),base='b'.repeat(40),policy='c'.repeat(40);
const baseline:WorkflowContract={version:1,repositoryId,fragments:'required',sharedQueues:{}};
const candidate:WorkflowContract={...baseline,fragments:'retired'};
afterEach(()=>{authorities.repositories={};vi.unstubAllGlobals();});
describe('runtime contract revalidation',()=>{
 it.each(['APPROVED','DISMISSED','CHANGES_REQUESTED','PINNED','SOURCE_DENIED'])('recomputes the same completed run when approval is %s',async state=>{
  const pinned = ['PINNED','SOURCE_DENIED'].includes(state); const reviewState=state==='PINNED'?'APPROVED':state;
  (authorities.repositories as any)[repositoryId]={baseline,approverIds:[2]};
    if(pinned)authorities.repositories={};
  const repo={id:repositoryId,full_name:'splrad/steward',default_branch:'main',owner:{id:302208797},private:false};
  const pull={number:7,state:'open',user:{id:1},head:{sha:head,ref:'feature',repo:{id:repositoryId}},base:{sha:base,ref:'main',repo:{id:repositoryId}}};
  const run={id:10,run_attempt:1,workflow_id:20,name:'SPLRAD Steward / PR Validation',path:'.github/workflows/pr-validation.yml',
   repository:repo,head_repository:repo,head_branch:'feature',head_sha:head,pull_requests:[{number:7}],event:'pull_request',status:'completed',conclusion:'success',
   workflow_url:'https://api.github.com/repos/splrad/steward/actions/required_workflows/20',html_url:'https://github.com/splrad/steward/actions/runs/10'};
  const check={id:30,name:'PR Validation Gate',head_sha:head,app:{id:4243096},external_id:`${repositoryId}:7:${head}:10:1`,status:'completed',conclusion:reviewState==='APPROVED'?'failure':'success'};
  const updates:any[]=[];
  vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
   const u=new URL(String(url));let value:any;
   if(u.pathname.endsWith('/access_tokens'))value={token:'test'};
   else if(u.pathname===`/repositories/${repositoryId}`)value=repo;
   else if(u.pathname.endsWith('/pulls/7'))value=pull;
   else if(u.pathname.endsWith('/check-runs/30')){updates.push(JSON.parse(String(init.body)));value={};}
   else if(u.pathname.endsWith('/check-runs'))value={check_runs:[check]};
   else if(u.pathname.endsWith('/actions/runs/10'))value=run;
   else if(u.pathname.includes('/attempts/1/jobs'))value={jobs:[{status:'completed',conclusion:'success',steps:[{name:`workflow-contract-policy:${policy}`,status:'completed',conclusion:'success'}]}]};
   else if(u.pathname.endsWith(`/commits/${head}/pulls`))value=[pull];
   else if(u.pathname.endsWith('/contents/config/workflow-contract-authority.json')){
    expect(u.searchParams.get('ref')).toBe(policy);
    if(state==='SOURCE_DENIED')return new Response('{}',{status:403});
    const text=JSON.stringify({version:1,repositories:{[repositoryId]:{baseline,approverIds:[2]}}});
    value={type:'file',encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')};
   }
   else if(u.pathname.includes('/contents/'))value={type:'file',encoding:'base64',size:100,content:Buffer.from(JSON.stringify(u.searchParams.get('ref')===base?baseline:candidate)).toString('base64')};
   else if(u.pathname.endsWith('/reviews'))value=[{id:1,state:reviewState,commit_id:head,user:{id:2,type:'User',login:'reviewer'},submitted_at:'2026-10-20T00:00:00Z',body:contractApprovalText({
    repositoryId,pullNumber:7,headSha:head,baseSha:base,policySha:policy,contractDigest:createHash('sha256').update(canonicalContract(candidate)).digest('hex')
   })}];
   else if(u.pathname.endsWith('/permission'))value={permission:'write',user:{id:2}};
   else throw new Error('unexpected '+u.pathname);
   return new Response(JSON.stringify(value));
  });
  const env:Env={ORGANIZATION_ID:'302208797',ORGANIZATION_LOGIN:'splrad',APP_ID:'4243096',INSTALLATION_ID:'145952003',STEWARDSHIP_REPOSITORY:'splrad/steward',POLICY_SHA:pinned?'d'.repeat(40):policy,...(pinned?{WORKFLOW_EVALUATOR_SHA:policy}:{}),
   STEWARD_APP_PRIVATE_KEY:generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{format:'pem',type:'pkcs8'},publicKeyEncoding:{format:'pem',type:'spki'}}).privateKey};
  await refreshWorkflowContractChecks(env,repositoryId,7);
  expect(updates).toHaveLength(1);
  expect(updates[0].conclusion).toBe(reviewState==='APPROVED'?'success':'failure');
 });
});
