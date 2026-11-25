import { createHash } from 'node:crypto';
import { archivedOutputContract, decodeCandidateDocument, verifyContentAttemptReceipts } from '../packages/runner/dist/index.js';
import { effectiveValidator, requiredWorkflowBinding, validatorRuleset } from './required-workflow-binding.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const check = value => { if (!value) throw Error('CONTENT_RECOVERY_ARCHIVE'); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

const transferDigest = (generatedDigest, controllerSha) => hash(['content-archive-transfer/v1', generatedDigest, controllerSha]);

/** Keep the original digest address usable when a retained validator makes both generations identical. */
export async function selectContentArchive(candidate, generatedDigest, {loadDocument, controllerSha, grant}) {
  const transfer=()=>({digest:transferDigest(generatedDigest,controllerSha),transferBaseDigest:generatedDigest});
  if(grant?.archiveContentDigest===generatedDigest)return transfer();
  const prior=candidate.contentGenerationDigest;
  if(prior!==generatedDigest) {
    const saved=await loadDocument(`content/${candidate.id}/${prior}/manifest.json`);
    if(saved?.input?.candidateId===candidate.id&&sha(saved.input.controllerSha)&&prior===transferDigest(generatedDigest,saved.input.controllerSha)
      &&saved.input.batches.some(batch=>batch.attempts.some(attempt=>attempt.recovery?.archiveContentDigest===generatedDigest)))return transfer();
  }
  return {digest:generatedDigest,transferBaseDigest:null};
}

// The native writer stored the first send, the provider outcome and any later blocked wake separately.
async function verifyRecordedBatch(batch, input, currentDigest, grant, contract, loadResultChunks) {
  const attempt = batch.attempts[1];
  if (attempt.status === 'RETURNED') {
    const directory = currentDigest === grant.archiveContentDigest ? transferDigest(currentDigest, input.controllerSha) : currentDigest;
    const path = `content/${input.candidateId}/${directory}/results/${batch.id}.json`;
    check(attempt.errorCode === null && !attempt.diagnostic && batch.status === 'READY' && batch.errorCode === null
      && batch.nextCheckAt === null && batch.resultPath === path && typeof loadResultChunks === 'function');
    const chunks = await loadResultChunks(path);
    const first = chunks?.[0];
    check(Array.isArray(chunks) && first?.documentKind === 'content-result' && first.candidateId === input.candidateId
      && first.repositoryId === input.repositoryId);
    const result = await decodeCandidateDocument(chunks, contract === 'conditional' ? true : 'reviewed');
    check(result.stage === batch.stage && same(result.sourceIds, batch.sourceIds) && (result.conditional === true) === (contract !== 'standard'));
    return;
  }

  check(batch.resultPath === null);
  if (attempt.status === 'SENT') {
    check(attempt.errorCode === null && !attempt.diagnostic && batch.nextCheckAt === null
      && ((batch.status === 'RUNNING' && batch.errorCode === null) || (batch.status === 'FAILED' && batch.errorCode === 'RESPONSE_UNKNOWN')));
    return;
  }
  check(batch.errorCode === attempt.errorCode);
  if (attempt.status === 'UNKNOWN') {
    check(batch.status === 'FAILED' && batch.errorCode === 'RESPONSE_UNKNOWN' && batch.nextCheckAt === null);
    return;
  }
  check(attempt.status === 'REJECTED');
  if (attempt.errorCode === 'WAIT_AUTH' || attempt.errorCode === 'WAIT_QUOTA') {
    // A later wake could mark the consumed grant FAILED while retaining the original retry time.
    const next = Date.parse(batch.nextCheckAt);
    check((batch.status === attempt.errorCode || batch.status === 'FAILED') && Number.isFinite(next)
      && new Date(next).toISOString() === batch.nextCheckAt && next >= Date.parse(attempt.startedAt) + 60_000);
    return;
  }
  check(typeof attempt.errorCode === 'string' && /^CONTENT_[A-Z_]+$/.test(attempt.errorCode)
    && batch.status === 'FAILED' && batch.nextCheckAt === null);
}

// Compare protected snapshots and the original cache without scheduling or restoring a request.
export async function verifyContentRecoveryArchive(work, cache, grant, { loadDocument, loadResultChunks, facts, protections, authorsDigest }) {
  check(grant && [grant.candidateId,grant.batchId,grant.previousAttemptSha256,grant.authorizationId,grant.outputContractSha256,grant.archiveContentDigest,grant.archiveProtectionDigest].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)));
  const root=`content/${grant.candidateId}/${grant.archiveContentDigest}/`;
  const archived=await loadDocument(root+'manifest.json');
  const protectionPath=`generated/protections-${grant.archiveProtectionDigest}.json`;
  const previous=await loadDocument(protectionPath);
  check(archived?.input && previous?.facts && previous?.protections && previous.facts.protectionsEvidencePath===protectionPath);
  check(archived.input.candidateId===grant.candidateId && work.input.candidateId===grant.candidateId);
  check(hash([previous.protections.branch,previous.protections.tags])===grant.archiveProtectionDigest);
  check(facts.protectionsEvidencePath===`generated/protections-${hash([protections.branch,protections.tags])}.json`);
  const oldFacts={...previous.facts},newFacts={...facts};delete oldFacts.protectionsEvidencePath;delete newFacts.protectionsEvidencePath;
  check(same(oldFacts,newFacts));
  const normalize=value=>{
    const copy=structuredClone(value);
    const pin=effectiveValidator(copy.branch,{code:'CONTENT_RECOVERY_ARCHIVE'});
    const workflow=requiredWorkflowBinding({rules:copy.branch.filter(rule=>rule.ruleset_id===validatorRuleset)},'CONTENT_RECOVERY_ARCHIVE');
    check(workflow.sha===pin);workflow.sha='effective-validator';return copy;
  };
  check(same(normalize(previous.protections),normalize(protections)));
  check(hash([hash(previous.facts),archived.input.configDigest,authorsDigest])===grant.archiveContentDigest);
  check(archived.input.batches.length===1 && work.input.batches.length===1 && work.input.units.length===1);
  const old=archived.input.batches[0],batch=work.input.batches[0];
  check(old.id===grant.batchId && old.status==='FAILED' && old.errorCode==='CONTENT_OUTPUT_SCHEMA' && old.resultPath===null && old.nextCheckAt===null && old.attempts.length===1
    && old.attempts[0].ordinal===1 && old.attempts[0].status==='REJECTED' && old.attempts[0].errorCode==='CONTENT_OUTPUT_SCHEMA' && !old.attempts[0].recovery
    && hash(old.attempts[0])===grant.previousAttemptSha256);
  const inputIdentity=value=>{const copy=structuredClone(value);delete copy.batches;delete copy.controllerSha;delete copy.sourceManifestDigest;return copy;};
  check(sha(archived.input.controllerSha) && sha(work.input.controllerSha) && archived.input.controllerSha!==work.input.controllerSha
    && same(inputIdentity(archived.input),inputIdentity(work.input)));
  check(['id','stage','unitIds','sourceIds','inputDigest'].every(k=>same(old[k],batch[k])));
  check(archived.payloadPaths[old.id]===root+`batches/${old.id}.json` && archived.evidencePath===root+'source-manifest.json');
  const payload=await loadDocument(archived.payloadPaths[old.id]),evidence=await loadDocument(archived.evidencePath);
  check(payload && evidence && Array.isArray(evidence.manifests) && hash(payload)===old.inputDigest && same(payload,work.payloads[batch.id]));
  check(hash(evidence.manifests)===archived.input.sourceManifestDigest && hash(work.evidence.manifests)===work.input.sourceManifestDigest);
  const normalized=structuredClone(evidence);
  for(const manifest of normalized.manifests) {
    check(manifest.identity.controllerSha===archived.input.controllerSha);
    manifest.identity.controllerSha=work.input.controllerSha;
  }
  check(same(normalized,work.evidence));
  const entry=cache[hash([batch.inputDigest,work.input.configDigest])];
  check(entry && entry.result===null && entry.inputDigest===batch.inputDigest && entry.configDigest===work.input.configDigest && same(entry.attempts,old.attempts));
  const conditional=payload.conditional===true;
  check((archived.conditional===true)===conditional && (entry.conditional===true)===conditional);
  const contract = await archivedOutputContract(grant.outputContractSha256, conditional);
  check(contract !== undefined);
  await verifyContentAttemptReceipts(old.attempts,conditional);
  if(batch.attempts.length===0){
    check(batch.status==='PENDING' && batch.resultPath===null && batch.errorCode===null && batch.nextCheckAt===null);
  }else{
    const {candidateId,batchId,...receipt}=grant;
    check(batch.attempts.length===2 && same(batch.attempts[0],old.attempts[0]));
    const recorded=batch.attempts[1].recovery;
    check(recorded && Object.keys(receipt).length===Object.keys(recorded).length
      && Object.entries(receipt).every(([field,value])=>recorded[field]===value));
    await verifyContentAttemptReceipts(batch.attempts,conditional);
    const currentDigest = hash([hash(facts), work.input.configDigest, authorsDigest]);
    await verifyRecordedBatch(batch, work.input, currentDigest, grant, contract, loadResultChunks);
  }
  return {candidateId:grant.candidateId,batchId:old.id,previousAttemptSha256:grant.previousAttemptSha256};
}
