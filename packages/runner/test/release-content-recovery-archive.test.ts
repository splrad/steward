// @ts-nocheck
import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {restoreContentRecovery} from '../../../scripts/release-content-recovery.mjs';
import {acceptanceErrorCode,validatePlan,digest} from '../../../scripts/business-flow-acceptance.mjs';
import {planContentBatches,resumeContentBatches} from '../src/release-content.js';
import {CONTENT_OUTPUT_SCHEMA,validateContentInput,verifyContentAttemptReceipts} from '../../core/src/release-content.js';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function fixture(){
  const identity={repositoryId:1,defaultBranch:'main',targetSha:'a'.repeat(40),controllerSha:'b'.repeat(40)};
  const unit={id:'app',path:'.',version:'1.0.0',tag:'v1.0.0'},boundary={kind:'full-tree'};
  const evidence={manifests:[{unit,identity,boundary,commits:[{sha:identity.targetSha}]}],gaps:[]};
  const input={schemaVersion:2,repositoryId:1,candidateId:hash('candidate'),baseSha:identity.targetSha,controllerSha:identity.controllerSha,
    units:[unit],boundaries:[{unitId:'app',kind:'full-tree',sha:null,reference:null}],sourceManifestDigest:hash(evidence.manifests),configDigest:hash('config'),batches:[]};
  const source={id:hash('source'),unitId:'app',path:'README.md',previousPath:null,status:'CURATED',oid:identity.targetSha,mode:'100644',byteLength:6,encoding:'utf8',sha256:hash('示例'),start:0,end:6,text:'示例',stage:'CONTEXT'};
  const old=await planContentBatches(input,[source],evidence),batch=old.input.batches[0];
  const attempt={ordinal:1,startedAt:'2026-11-08T00:00:00Z',status:'REJECTED',model:'fixture',usage:null,errorCode:'CONTENT_OUTPUT_SCHEMA'};
  Object.assign(batch,{status:'FAILED',errorCode:'CONTENT_OUTPUT_SCHEMA',attempts:[attempt]});
  const protections={branch:[{type:'deletion'},{type:'workflows',parameters:{workflows:[{repository_id:1296724484,path:'.github/workflows/pr-validation-native.yml',sha:identity.controllerSha}]}}],tags:[{type:'deletion'}]};
  const archiveProtectionDigest=hash([protections.branch,protections.tags]),protectionPath=`generated/protections-${archiveProtectionDigest}.json`;
  const facts={baseSha:identity.targetSha,config:'fixed',protectionsEvidencePath:protectionPath},authorsDigest=hash('authors');
  const archiveContentDigest=hash([hash(facts),input.configDigest,authorsDigest]),root=`content/${input.candidateId}/${archiveContentDigest}/`;
  const manifest={input:old.input,payloadPaths:{[batch.id]:root+`batches/${batch.id}.json`},evidencePath:root+'source-manifest.json'};
  const docs={[root+'manifest.json']:manifest,[manifest.payloadPaths[batch.id]]:old.payloads[batch.id],[manifest.evidencePath]:evidence,[protectionPath]:{facts,protections}};
  const nextEvidence=structuredClone(evidence);nextEvidence.manifests[0].identity.controllerSha='c'.repeat(40);
  const work=await planContentBatches({...input,controllerSha:'c'.repeat(40),sourceManifestDigest:hash(nextEvidence.manifests)},[source],nextEvidence);
  const currentProtections=structuredClone(protections);currentProtections.branch[1].parameters.workflows[0].sha=work.input.controllerSha;
  const currentFacts={...facts,protectionsEvidencePath:`generated/protections-${hash([currentProtections.branch,currentProtections.tags])}.json`};
  const key=hash([batch.inputDigest,input.configDigest]),cache={[key]:{inputDigest:batch.inputDigest,configDigest:input.configDigest,attempts:[structuredClone(attempt)],result:null}};
  const grant={candidateId:input.candidateId,batchId:batch.id,previousAttemptSha256:hash(attempt),authorizationId:hash('approval'),outputContractSha256:hash(CONTENT_OUTPUT_SCHEMA),archiveContentDigest,archiveProtectionDigest};
  const io={loadDocument:async path=>docs[path]??null,facts:currentFacts,protections:currentProtections,authorsDigest};
  return {work,cache,grant,io,docs,manifest,old,attempt,key,root,protectionPath};
}
it('rebinds only a verified archived failure after a controller pin change and persists its provenance before one request',async()=>{
  const f=await fixture(),original=JSON.stringify(f.manifest);await restoreContentRecovery(f.work,f.cache,f.grant,f.io);
  let sent=0,persisted;
  const result=await resumeContentBatches(f.work,f.cache,{recovery:f.grant,now:()=>new Date().toISOString(),editing:async()=>false,preflight:async()=>'READY',
    save:async work=>{validateContentInput(work.input);persisted=structuredClone(work);},call:async()=>{sent++;expect(persisted.input.batches[0].attempts.map(a=>a.ordinal)).toEqual([1,2]);
      expect(persisted.input.batches[0].attempts[1].recovery).toMatchObject({archiveContentDigest:f.grant.archiveContentDigest,archiveProtectionDigest:f.grant.archiveProtectionDigest});
      return {text:JSON.stringify({paragraphs:[{sourceIds:f.work.input.batches[0].sourceIds,section:'summary',textZh:'离线验证说明。',qualification:'UNVERIFIED'}]}),model:'offline',usage:null};}});
  expect(result).toEqual({status:'READY',calls:1});expect(sent).toBe(1);expect(JSON.stringify(f.manifest)).toBe(original);expect(f.work.input.batches[0].attempts[0]).toEqual(f.attempt);
});
it.each(['missing-archive','missing-pair','path','facts','protection','pin','source','identity','config','payload','history','unknown','other-rejection','second-failure','cache','grant'])('rejects archive transfer without mutation: %s',async kind=>{
  const f=await fixture();
  if(kind==='missing-archive')delete f.docs[f.root+'manifest.json'];
  if(kind==='missing-pair')delete f.grant.archiveProtectionDigest;
  if(kind==='path')f.manifest.evidencePath='other.json';
  if(kind==='facts')f.io.facts.baseSha='d'.repeat(40);
  if(kind==='protection')f.io.protections.tags.push({type:'update'});
  if(kind==='pin')f.io.protections.branch[1].parameters.workflows[0].sha='d'.repeat(40);
  if(kind==='source')f.work.evidence.manifests[0].commits.push({sha:'d'.repeat(40)});
  if(kind==='identity')f.work.input.repositoryId=2;
  if(kind==='config')f.work.input.configDigest=hash('changed');
  if(kind==='payload')f.work.payloads[f.grant.batchId].sources[0].text='变化';
  if(kind==='history')f.work.input.batches[0].attempts=[structuredClone(f.attempt)];
  if(kind==='unknown')f.manifest.input.batches[0].attempts[0].status='UNKNOWN';
  if(kind==='other-rejection')f.manifest.input.batches[0].attempts[0].errorCode='WAIT_AUTH';
  if(kind==='second-failure')f.manifest.input.batches[0].attempts.push({...f.attempt,ordinal:2});
  if(kind==='cache')f.cache[f.key].attempts[0].model='different';
  if(kind==='grant')f.grant.previousAttemptSha256=hash('wrong');
  const before=JSON.stringify(f.work);await expect(restoreContentRecovery(f.work,f.cache,f.grant,f.io)).rejects.toThrow('CONTENT_RECOVERY_ARCHIVE');expect(JSON.stringify(f.work)).toBe(before);
});
it('bounds public failure diagnostics to machine codes',()=>{
  expect(acceptanceErrorCode(Error('CONTENT_RECOVERY_BINDING'))).toBe('CONTENT_RECOVERY_BINDING');
  expect(acceptanceErrorCode(Error('secret text'))).toBe('BUSINESS_ACCEPTANCE_STOPPED');
  expect(acceptanceErrorCode(Error('CONTENT_RECOVERY_BINDING\nprivate'))).toBe('BUSINESS_ACCEPTANCE_STOPPED');
});
it('requires both explicit archive locators in the acceptance plan',async()=>{
  const {grant}=await fixture(),controllerSha='c'.repeat(40),plan={schemaVersion:1,kind:'release',controllerSha,maxRequests:1,repository:{id:1448797077,full_name:'splrad/steward-e10-lifecycle-20261107',private:true,default_branch:'main'},baseSha:'a'.repeat(40),stateSha:'d'.repeat(40),releaseRecovery:grant};
  const env={GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:'splrad/steward/.github/workflows/business-flow-acceptance.yml@refs/heads/main',GITHUB_SHA:controllerSha,WORKFLOW_SHA:controllerSha};
  const check=()=>{const raw=JSON.stringify(plan);return validatePlan(raw,digest(raw),env);};expect(check()).toEqual(plan);delete grant.archiveProtectionDigest;expect(check).toThrow('ACCEPTANCE_RELEASE_RECOVERY_PLAN');
});
it('rejects an archived recovery receipt with only one locator',async()=>{
  const {attempt,grant}=await fixture();
  const recovery={previousAttemptSha256:grant.previousAttemptSha256,authorizationId:grant.authorizationId,outputContractSha256:grant.outputContractSha256,archiveContentDigest:grant.archiveContentDigest};
  await expect(verifyContentAttemptReceipts([attempt,{...attempt,ordinal:2,recovery}])).rejects.toThrow('CONTENT_ATTEMPT_SCHEMA');
});
