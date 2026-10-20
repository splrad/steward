import {createHash,createHmac,generateKeyPairSync} from 'node:crypto';
import {afterEach,describe,it,expect,vi} from 'vitest';
import worker,{handleWebhook,refreshWorkflowContractChecks,type Env} from '../src/index.js';
import {canonicalContract,contractApprovalText,type WorkflowContract} from '../../core/src/workflow-contract.js';
const repositoryId=1296724484,head='a'.repeat(40),base='b'.repeat(40),policy='c'.repeat(40);
const baseline:WorkflowContract={version:1,repositoryId,fragments:'required',sharedQueues:{}};
const candidate:WorkflowContract={...baseline,fragments:'retired'};
afterEach(()=>{vi.unstubAllGlobals();});
describe('runtime contract revalidation',()=>{
 it('skips the full contract sweep between fifteen-minute slots',async()=>{
  const request=vi.fn();vi.stubGlobal('fetch',request);
  await worker.scheduled({scheduledTime:60_000} as ScheduledController,{WORKFLOW_EVALUATOR_SHA:policy} as Env);
  expect(request).not.toHaveBeenCalled();
 });
 it.each(['APPROVED','DISMISSED','CHANGES_REQUESTED','PINNED','SOURCE_DENIED','WEBHOOK_APPROVED','WEBHOOK_DISMISSED','WEBHOOK_CHANGES_REQUESTED','SCHEDULED','SCHEDULED_SOURCE_DENIED','HISTORICAL_RUNS','PENDING','PENDING_NONE','PENDING_LIMIT','PENDING_PARTIAL'])('recomputes the same completed run when approval is %s',async state=>{
  const pinned = true; const reviewState=['PINNED','SCHEDULED','HISTORICAL_RUNS','PENDING','PENDING_NONE','PENDING_LIMIT'].includes(state)?'APPROVED':state.replace('WEBHOOK_','');
  const repo={id:repositoryId,full_name:'splrad/steward',default_branch:'main',owner:{id:302208797},private:false};
  const pull={number:7,state:'open',user:{id:1},head:{sha:head,ref:'feature',repo:{id:repositoryId}},base:{sha:base,ref:'main',repo:{id:repositoryId}}};
  const run={id:10,run_attempt:1,workflow_id:20,name:'SPLRAD Steward / PR Validation',path:'.github/workflows/pr-validation.yml',
   repository:repo,head_repository:repo,head_branch:'feature',head_sha:head,pull_requests:[{number:7}],event:'pull_request',status:'completed',conclusion:'success',
   workflow_url:'https://api.github.com/repos/splrad/steward/actions/required_workflows/20',html_url:'https://github.com/splrad/steward/actions/runs/10'};
  const check={id:30,name:'PR Validation Gate',head_sha:head,app:{id:4243096},external_id:`${repositoryId}:7:${head}:10:1`,status:'completed',conclusion:reviewState==='APPROVED'?'failure':'success'};
  if(state.startsWith('PENDING')){check.external_id=`${repositoryId}:7:${head}:pending`;check.status='in_progress';}
  const updates:any[]=[]; let authorityReads=0; let runReads=0; let discoveryReads=0;
  const checks=state==='HISTORICAL_RUNS' ? [
    ...[2,3,9].map((id,index)=>({...check,id:31+index,external_id:`${repositoryId}:7:${head}:${id}:1`})),check,
  ] : [check];
  vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
   const u=new URL(String(url));let value:any;
   if(u.pathname.endsWith('/access_tokens'))value={token:'test'};
   else if(u.pathname==='/installation/repositories')value={total_count:1,repositories:[repo]};
   else if(u.pathname.startsWith('/repositories/'))value={...repo,id:Number(u.pathname.split('/').at(-1)),full_name:u.pathname.endsWith(String(repositoryId))?repo.full_name:u.pathname.endsWith('1187527897')?'splrad/LayerScape':'splrad/.github'};
   else if(u.pathname.endsWith('/pulls/7'))value=pull;
   else if(u.pathname.endsWith('/pulls'))value=u.pathname.includes('/steward/')?[pull]:[];
   else if(/\/check-runs\/\d+$/.test(u.pathname)){updates.push(JSON.parse(String(init.body)));value={};}
   else if(u.pathname.endsWith('/check-runs'))value={check_runs:checks};
   else if(u.pathname.endsWith('/actions/runs')){
    discoveryReads++;expect(u.searchParams.get('head_sha')).toBe(head);expect(u.searchParams.get('event')).toBe('pull_request');
    if(state==='PENDING_LIMIT') value={total_count:1000,workflow_runs:[]};
    else if(!u.searchParams.has('page')){
     const decoys=[{...run,id:12,workflow_url:'https://api.github.com/repos/splrad/steward/actions/workflows/20'},
      {...run,id:13,head_sha:base},{...run,id:14,head_repository:{id:999}},{...run,id:15,head_branch:'other'},
      {...run,id:16,pull_requests:[{number:8}]},{...run,id:9}];
     return new Response(JSON.stringify({total_count:state==='PENDING_NONE'?5:7,workflow_runs:state==='PENDING_NONE'?decoys.slice(0,5):decoys}),{headers:['PENDING_NONE','PENDING_PARTIAL'].includes(state)?{}:{link:'<https://api.github.com/repos/splrad/steward/actions/runs?event=pull_request&head_sha='+head+'&per_page=100&page=2>; rel="next"'}});
    }else value={total_count:7,workflow_runs:[run]};
   }
   else if(u.pathname.endsWith('/actions/runs/10')){runReads++;value=run;}
   else if(u.pathname.includes('/attempts/1/jobs'))value={jobs:[{status:'completed',conclusion:'success',steps:[{name:`workflow-contract-policy:${policy}`,status:'completed',conclusion:'success'}]}]};
   else if(u.pathname.endsWith(`/commits/${head}/pulls`))value=[pull];
   else if(u.pathname.endsWith('/contents/config/workflow-contract-authority.json')){
    authorityReads++; expect(u.searchParams.get('ref')).toBe(policy);
    if(state.endsWith('SOURCE_DENIED'))return new Response('{}',{status:403});
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
  if(state.startsWith('WEBHOOK_')) {
   env.STEWARD_WEBHOOK_SECRET='test-secret';
   const body=JSON.stringify({organization:{id:302208797},installation:{id:145952003},repository:repo,pull_request:pull,action:reviewState==='DISMISSED'?'dismissed':'submitted'});
   const signature=createHmac('sha256',env.STEWARD_WEBHOOK_SECRET).update(body).digest('hex');
   const response=await handleWebhook(new Request('https://example.test/github/webhook',{method:'POST',body,headers:{'x-github-event':'pull_request_review','x-github-delivery':'test','x-hub-signature-256':'sha256='+signature}}),env);
   expect(response.status).toBe(202);
  } else if(state.startsWith('SCHEDULED'))await worker.scheduled({scheduledTime:0} as ScheduledController,env);
  else if(['PENDING_LIMIT','PENDING_PARTIAL'].includes(state)){await expect(refreshWorkflowContractChecks(env,repositoryId,7)).rejects.toThrow('CONTRACT_RUN_DISCOVERY');expect(updates).toHaveLength(0);return;}
  else await refreshWorkflowContractChecks(env,repositoryId,7);
  if(state==='PENDING_NONE'){expect(updates).toHaveLength(0);expect(runReads).toBe(0);return;}
  if(state==='PENDING')expect(discoveryReads).toBe(2);
  expect(updates).toHaveLength(state==='HISTORICAL_RUNS'?4:1);
  expect(runReads).toBe(1);
  expect(authorityReads).toBe(1);
  if(state.startsWith('SCHEDULED'))expect(authorityReads).toBe(1);
  expect(updates[0].conclusion).toBe(reviewState==='APPROVED'?'success':'failure');
 });
});
