import { createHash } from 'node:crypto';
import { candidateObservationIdentity, decodeCandidateArchive, decodeCandidateDocument, decodeReleaseRecord } from '../packages/runner/dist/index.js';
export const product = { id: 1187527897, name: 'splrad/LayerScape' };
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const key = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw Error('BOUNDED_INPUT');
}
export function sameIdentity(a,b) { exact(a,Object.keys(b)); return Object.keys(b).every(k=>a[k]===b[k]); }
/** Only immutable Git data supplies the generation/epoch; transport hints never do. */
export async function candidateEvidence(get,{requireReady=true}={}) {
  const repository=await get(`/repos/${product.name}`);
  if(repository.id!==product.id||repository.full_name!==product.name||repository.archived||repository.disabled||repository.default_branch!=='main')throw Error('BOUNDED_REPOSITORY');
  const ref=await get(`/repos/${product.name}/git/ref/heads/steward/release-state`);
  if(ref.ref!=='refs/heads/steward/release-state'||ref.object?.type!=='commit'||!sha(ref.object.sha))throw Error('BOUNDED_STATE_REF');
  const stateCommit=ref.object.sha;
  const file=async path=>{
    const f=await get(`/repos/${product.name}/contents/${path}?ref=${stateCommit}`);
    if(f.type!=='file'||f.path!==path||f.encoding!=='base64'||!sha(f.sha))throw Error('BOUNDED_STATE_FILE');
    const bytes=Buffer.from(f.content,'base64');
    if(bytes.length!==f.size||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==f.sha)throw Error('BOUNDED_BLOB');
    return JSON.parse(bytes.toString('utf8'));
  };
  const state=decodeReleaseRecord('repository',Buffer.from(JSON.stringify(await file('state.json'))));
  if(state.repositoryId!==product.id||state.activeCycleId||!key(state.candidate?.id))throw Error('BOUNDED_CANDIDATE_REQUIRED');
  const chunk=async path=>decodeCandidateArchive(Buffer.from(JSON.stringify(await file(path))),product.id);
  const path=`generated/${state.candidate.id}/session.json`,first=await chunk(path),chunks=[first];
  if(!Number.isSafeInteger(first.count)||first.count<1||first.count>128)throw Error('BOUNDED_CHUNKS');
  for(let i=1;i<first.count;i++)chunks.push(await chunk(path.replace('.json',`-${i}.json`)));
  if(chunks.some(c=>c.repositoryId!==product.id||c.candidateId!==state.candidate.id||c.documentKind!=='session'))throw Error('BOUNDED_SESSION');
  const session={repository:state,...await decodeCandidateDocument(chunks)};
  let identity=null;
  if(requireReady)identity=candidateObservationIdentity(session);
  else if(session.manualValidation)identity=candidateObservationIdentity(session);
  else {try {identity=candidateObservationIdentity(session);}catch { /* A normal event may recover the existing pending candidate. */ }}
  const pull=await get(`/repos/${product.name}/pulls/${state.candidate.prNumber}`);
  if(pull.number!==state.candidate.prNumber||pull.head?.repo?.id!==product.id||pull.base?.repo?.id!==product.id
    ||pull.head.ref!==state.candidate.branch||pull.base.ref!=='main'||!sha(pull.head.sha))throw Error('BOUNDED_PULL');
  if(session.manualValidation&&(session.manualValidation.prNumber!==pull.number||session.manualValidation.branch!==pull.head.ref))throw Error('MANUAL_OWNER');
  const after=await get(`/repos/${product.name}/git/ref/heads/steward/release-state`);
  if(after.object?.sha!==stateCommit)throw Error('BOUNDED_STATE_MOVED');
  return {identity,state,session,pull,evidence:{stateCommit,path,documentDigest:first.documentDigest,prNumber:pull.number,head:pull.head.sha}};
}
export async function validateCandidateEvent(hint,get) {
  return validateIssueEvent(hint,get,true);
}
export async function validateNormalCandidateEvent(hint,sourceSha,get) {
  if(!sha(sourceSha))throw Error('CANDIDATE_EVENT_SOURCE');
  return validateIssueEvent(hint,get,false,sourceSha);
}
async function validateIssueEvent(hint,get,requireReady,sourceSha) {
  exact(hint,['repositoryId','prNumber','eventId']);
  if(hint.repositoryId!==product.id||!Number.isSafeInteger(hint.prNumber)||hint.prNumber<1||!Number.isSafeInteger(hint.eventId)||hint.eventId<1)throw Error('BOUNDED_EVENT_HINT');
  const current=await candidateEvidence(get,{requireReady});
  if(current.pull.number!==hint.prNumber||current.pull.state!=='open'||current.pull.merged)throw Error('BOUNDED_EVENT_OBJECT');
  const main=await get(`/repos/${product.name}/git/ref/heads/main`);
  if(main.object?.sha!==(requireReady?current.identity.sourceSha:sourceSha))throw Error('BOUNDED_SOURCE_CHANGED');
  const event=await get(`/repos/${product.name}/issues/events/${hint.eventId}`);
  if(event.id!==hint.eventId||event.issue?.number!==hint.prNumber||event.issue?.repository_url!==`https://api.github.com/repos/${product.name}`
    ||!['labeled','unlabeled','reopened'].includes(event.event)||!Number.isFinite(Date.parse(event.created_at))
    ||(['labeled','unlabeled'].includes(event.event)&&event.label?.name!=='release:editing'))throw Error('BOUNDED_EVENT_NATIVE');
  if(!requireReady) {
    if(!Array.isArray(current.pull.labels))throw Error('CANDIDATE_LABELS_UNKNOWN');
    const editing=current.pull.labels.some(label=>label.name==='release:editing');
    if(event.event==='labeled'&&!editing||event.event==='unlabeled'&&editing)throw Error('CANDIDATE_EVENT_SUPERSEDED');
  }
  return {...current,event,t0:Date.parse(event.created_at)};
}
