import {describe,it,expect} from 'vitest';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import YAML from 'yaml';
import {assertWorkflowDocument,assertRequiredValidation} from '../src/workflow-policy.js';
import {authorizeWorkflowContract,readWorkflowContract,contractDigest} from '../src/workflow-contract.js';
import {contractApprovalText,type WorkflowContract} from '../../core/src/workflow-contract.js';
const contract:WorkflowContract={version:1,repositoryId:99,fragments:'retired',sharedQueues:{'.github/workflows/build.yml':'product-build'}};
const facts={repositoryId:99,pullNumber:1,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),policySha:'c'.repeat(40),authorId:1,open:true,defaultBranchTarget:true};
const policy={repositoryId:99,baseline:{...contract,fragments:'required' as const,sharedQueues:{}},approverIds:[2]};
const ordinary=()=>({on:'workflow_dispatch',permissions:{contents:'read'},concurrency:{group:'workflow-resource:99:product-build','cancel-in-progress':false},jobs:{build:{'runs-on':'ubuntu-24.04',steps:[{run:'npm test'}]}}});
describe('contract integration',()=>{
 it('authorizes changed capabilities against current remote facts',async()=>{
  const binding={repositoryId:99,pullNumber:1,headSha:facts.headSha,baseSha:facts.baseSha,policySha:facts.policySha,contractDigest:contractDigest(contract)};
  const result=await authorizeWorkflowContract(contract,policy,{
   facts:async()=>facts,eligibleUserIds:async()=>[2],reviews:async()=>[{id:1,userId:2,userType:'User',commitId:facts.headSha,state:'APPROVED',body:contractApprovalText(binding),submittedAt:'2026-10-20T00:00:00Z'}]
  });
  expect(result.reviewId).toBe(1);
  expect(()=>assertWorkflowDocument('.github/workflows/build.yml',ordinary(),result.contract)).not.toThrow();
 });
 it('rejects unapproved capability change',async()=>{
  await expect(authorizeWorkflowContract(contract,policy,{facts:async()=>facts,reviews:async()=>[],eligibleUserIds:async()=>[2]})).rejects.toThrow('APPROVAL_REQUIRED');
 });
 it('rejects source change while reading evidence',async()=>{
  let calls=0;
  await expect(authorizeWorkflowContract(policy.baseline,policy,{facts:async()=>({...facts,headSha:++calls===1?facts.headSha:'e'.repeat(40)}),reviews:async()=>[],eligibleUserIds:async()=>[]})).rejects.toThrow('SOURCE_STALE');
 });
 it('does not let a candidate declaration grant authority by existing on disk',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'contract-'));
  try{await mkdir(join(dir,'.github'));await writeFile(join(dir,'.github/workflow-contract.json'),JSON.stringify(contract));
   expect(await readWorkflowContract(dir)).toEqual(contract);
   expect(()=>assertWorkflowDocument('.github/workflows/build.yml',ordinary())).toThrow('namespace');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it('retires business fragments without replacing the trusted validator',async()=>{
  const d=YAML.parse(await readFile('.github/workflows/pr-validation.yml','utf8'));
  delete d.jobs.fragments;
  expect(()=>assertRequiredValidation(d)).toThrow('fragments');
  expect(()=>assertRequiredValidation(d,'retired')).not.toThrow();
  d.jobs.validate.steps.at(-1).run='echo passed';
  expect(()=>assertRequiredValidation(d,'retired')).toThrow('trusted validation entry');
 });
 it.each(['self-hosted','${{ needs.plan.outputs.runner }}'])('approval cannot grant runner %s',runner=>{
  const d=ordinary();d.jobs.build['runs-on']=runner;
  expect(()=>assertWorkflowDocument('.github/workflows/build.yml',d,contract)).toThrow('runner');
 });
 it('approval cannot authorize queue cancellation or cross-repository queues',()=>{
  const d=ordinary();d.concurrency['cancel-in-progress']=true;
  expect(()=>assertWorkflowDocument('.github/workflows/build.yml',d,contract)).toThrow('queue');
  d.concurrency={'cancel-in-progress':false,group:'workflow-resource:100:product-build'};
  expect(()=>assertWorkflowDocument('.github/workflows/build.yml',d,contract)).toThrow('queue');
 });
 it('artifact data cannot enter a privileged download job even with approval',()=>{
  const d:any=ordinary();d.on={workflow_run:{workflows:['Build'],types:['completed']}};
  d.jobs.build.environment={name:'steward-release',deployment:false};
  d.jobs.build.steps=[{uses:'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'}];
  expect(()=>assertWorkflowDocument('.github/workflows/build.yml',d,contract)).toThrow('artifact');
  delete d.jobs.build.environment;
  expect(()=>assertWorkflowDocument('.github/workflows/build.yml',d,contract)).not.toThrow();
 });
});
