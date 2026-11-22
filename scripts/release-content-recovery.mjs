import { createHash } from 'node:crypto';
import { effectiveValidator, requiredWorkflowBinding, validatorRuleset } from './required-workflow-binding.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const check = value => { if (!value) throw Error('CONTENT_RECOVERY_ARCHIVE'); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** Keep the original digest address usable when a retained validator makes both generations identical. */
export async function selectContentArchive(candidate, generatedDigest, {loadDocument, controllerSha, grant}) {
  const extra=(source,controller)=>hash(['content-archive-transfer/v1',source,controller]);
  if(grant?.archiveContentDigest===generatedDigest)return extra(generatedDigest,controllerSha);
  const prior=candidate.contentGenerationDigest;
  if(prior===generatedDigest)return prior;
  const saved=await loadDocument(`content/${candidate.id}/${prior}/manifest.json`);
  if(saved?.input?.candidateId===candidate.id&&sha(saved.input.controllerSha)&&prior===extra(generatedDigest,saved.input.controllerSha)
    &&saved.input.batches.some(batch=>batch.attempts.some(attempt=>attempt.recovery?.archiveContentDigest===generatedDigest)))return prior;
  return generatedDigest;
}

// Reattach a specifically authorized archived receipt only after reproducing its full input identity.
export async function restoreContentRecovery(work, cache, grant, { loadDocument, facts, protections, authorsDigest }) {
  check(grant && [grant.archiveContentDigest,grant.archiveProtectionDigest].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)));
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
  check(batch.status==='PENDING' && batch.attempts.length===0 && batch.resultPath===null && batch.errorCode===null && batch.nextCheckAt===null);
  check(old.id===grant.batchId && old.status==='FAILED' && old.errorCode==='CONTENT_OUTPUT_SCHEMA' && old.resultPath===null && old.nextCheckAt===null && old.attempts.length===1
    && old.attempts[0].status==='REJECTED' && old.attempts[0].errorCode==='CONTENT_OUTPUT_SCHEMA' && !old.attempts[0].recovery
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
  batch.attempts=structuredClone(old.attempts);
}
