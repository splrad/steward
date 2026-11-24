import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** Keep the original digest address usable when a retained validator makes both generations identical. */
export async function selectContentArchive(candidate, generatedDigest, {loadDocument, controllerSha, grant}) {
  const transferDigest=controller=>hash(['content-archive-transfer/v1',generatedDigest,controller]);
  const transfer=()=>({digest:transferDigest(controllerSha),transferBaseDigest:generatedDigest});
  if(grant?.archiveContentDigest===generatedDigest)return transfer();
  const prior=candidate.contentGenerationDigest;
  if(prior!==generatedDigest) {
    const saved=await loadDocument(`content/${candidate.id}/${prior}/manifest.json`);
    if(saved?.input?.candidateId===candidate.id&&sha(saved.input.controllerSha)&&prior===transferDigest(saved.input.controllerSha)
      &&saved.input.batches.some(batch=>batch.attempts.some(attempt=>attempt.recovery?.archiveContentDigest===generatedDigest)))return transfer();
  }
  return {digest:generatedDigest,transferBaseDigest:null};
}
