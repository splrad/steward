import {describe,it,expect} from 'vitest';
import {parseWorkflowContract,canonicalContract,contractApprovalText,requireContractApproval,type ContractBinding,type ContractReview} from '../src/workflow-contract.js';
import {selectContractAuthority} from '../src/workflow-contract-authority.js';
const contract = () => ({version:1 as const,repositoryId:99,fragments:'required' as const,sharedQueues:{}});
const binding: ContractBinding = {repositoryId:99,pullNumber:7,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),policySha:'c'.repeat(40),contractDigest:'d'.repeat(64)};
const review = (): ContractReview => ({id:1,userId:2,userType:'User',commitId:binding.headSha,state:'APPROVED',body:contractApprovalText(binding),submittedAt:'2026-10-20T00:00:00Z'});
const decide = (reviews: ContractReview[], extra = {}) => requireContractApproval({binding,authorId:1,approverIds:[2],eligibleUserIds:[2],reviews,...extra});
describe('workflow contract authority',()=>{
 it('accepts explicitly bound independent human approval',()=>expect(decide([review()])).toBe(1));
 it.each(['repositoryId','pullNumber','headSha','baseSha','policySha','contractDigest'] as const)('rejects replay with changed %s',key=>{
  const changed={...binding,[key]:typeof binding[key]==='number'?100:'e'.repeat(key==='contractDigest'?64:40)};
  expect(()=>decide([review()],{binding:changed})).toThrow('APPROVAL_REQUIRED');
 });
 it.each([
  {state:'COMMENTED'},{state:'CHANGES_REQUESTED'},{state:'DISMISSED'},{commitId:'e'.repeat(40)},
  {userType:'Bot'},{userId:1},{userId:3},{body:'approved'},{submittedAt:''}
 ])('rejects invalid review %j',change=>expect(()=>decide([{...review(),...change}])).toThrow('APPROVAL_REQUIRED'));
 it('checks current permissions and trusted approver list',()=>{
  expect(()=>decide([review()],{eligibleUserIds:[]})).toThrow();
  expect(()=>decide([review()],{approverIds:[]})).toThrow();
 });
 it('later dismissal or request changes cancels earlier approval independent of API order',()=>{
  for(const state of ['DISMISSED','CHANGES_REQUESTED']){
   const later={...review(),id:2,state,submittedAt:'2026-10-20T01:00:00Z'};
   expect(()=>decide([later,review()])).toThrow();
  }
 });
 it('a comment is not a new approval and does not erase an existing decision',()=>{
  expect(decide([review(),{...review(),id:2,state:'COMMENTED',body:'note',submittedAt:'2026-10-20T01:00:00Z'}])).toBe(1);
 });
 it('canonicalizes queue ordering',()=>{
  expect(canonicalContract({...contract(),sharedQueues:{'.github/workflows/b.yml':'b','.github/workflows/a.yml':'a'}}))
   .toBe(canonicalContract({...contract(),sharedQueues:{'.github/workflows/a.yml':'a','.github/workflows/b.yml':'b'}}));
 });
 it.each([
  {...contract(),version:2},{...contract(),allowSecrets:true},{...contract(),repositoryId:0},
  {...contract(),fragments:'skip'},{...contract(),sharedQueues:{'../escape.yml':'queue'}},
  {...contract(),sharedQueues:{'.github/workflows/a.yml':'${{ github.ref }}'}}
 ])('rejects unsupported contract %j',value=>expect(()=>parseWorkflowContract(value)).toThrow());
 it('trusted configuration cannot silently authorize nobody or inject unknown fields',()=>{
  expect(selectContractAuthority({version:1,repositories:{}},99)).toBeNull();
  expect(()=>selectContractAuthority({version:1,repositories:5},99)).toThrow();
  expect(()=>selectContractAuthority({version:1,repositories:{99:{baseline:contract(),approverIds:[]}}},99)).toThrow();
  expect(()=>selectContractAuthority({version:1,repositories:{99:{baseline:contract(),approverIds:[2],bypass:true}}},99)).toThrow();
  expect(selectContractAuthority({version:1,repositories:{99:{baseline:contract(),approverIds:[2]}}},99)?.approverIds).toEqual([2]);
 });
});
