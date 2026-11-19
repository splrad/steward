import {matchesFrozenUnits} from './manual-candidate.mjs';
import {isDeepStrictEqual} from 'node:util';
import { createHash } from 'node:crypto';
import { candidateObservationIdentity, decodeCandidateArchive, decodeCandidateDocument, decodeReleaseRecord } from '../packages/runner/dist/index.js';
import registrations from '../config/release/event-repositories.json' with {type:'json'};
import {releaseParticipation} from './release-coordinator.mjs';
import {nativeEvidenceTransport} from '../packages/runner/dist/index.js';

export async function withParticipatingProduct(app,id,operation,transport=nativeEvidenceTransport) {
  if(!Number.isSafeInteger(id)||id<1)throw Error('BOUNDED_EVENT_HINT');
  const matches=(await app.discover()).filter(repo=>repo.id===id);
  if(matches.length!==1)throw Error('BOUNDED_REPOSITORY');
  const repository=matches[0];
  if(repository.archived||repository.disabled||!/^splrad\/[A-Za-z0-9_.-]+$/.test(repository.full_name)||!repository.default_branch)throw Error('BOUNDED_REPOSITORY');
  return app.forCandidateReadRepository(id,async readToken=>{
    const io=transport(readToken),path='/repos/'+repository.full_name;
    const response=await io.request('GET',path);
    if(response.status!==200)throw Error('BOUNDED_REPOSITORY');
    const actual=JSON.parse(Buffer.from(response.bytes).toString('utf8'));
    if(actual.id!==id||actual.full_name!==repository.full_name||actual.owner?.id!==302208797||actual.private!==false||actual.visibility!=='public'||
       actual.archived!==false||actual.disabled!==false||actual.fork!==false||actual.default_branch!==repository.default_branch)throw Error('BOUNDED_REPOSITORY');
    const participation=await releaseParticipation(repository,io,{includeUnits:true});
    if(participation.status!=='APPLICABLE')throw Error('CANDIDATE_NOT_ENABLED');
    const product={id,name:actual.full_name,defaultBranch:actual.default_branch,units:participation.units};
    return operation(product,participation);
  });
}
export async function withCandidateProduct(app,id,operation,transport=nativeEvidenceTransport) {
  return withParticipatingProduct(app,id,(product,participation)=>app.forCandidateRepository(id,
    (token,readToken)=>operation(product,token,readToken,participation)),transport);
}
// Legacy publication consumers identify their single approved callback by its reviewed registration.
const legacy=registrations.filter(record=>record.legacyPublicationCallback===true);
export const product = legacy.length===1 ? legacy[0] : undefined;
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const key = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw Error('BOUNDED_INPUT');
}
export function sameIdentity(a,b) { exact(a,Object.keys(b)); return Object.keys(b).every(k=>a[k]===b[k]); }
/** Only immutable Git data supplies the generation/epoch; transport hints never do. */
export async function candidateEvidence(get,{requireReady=true,product}) {
  const repository=await get(`/repos/${product.name}`);
  if(repository.id!==product.id||repository.full_name!==product.name||repository.archived||repository.disabled||repository.default_branch!==product.defaultBranch||repository.private!==false||repository.visibility!=='public'||repository.owner?.id!==302208797)throw Error('BOUNDED_REPOSITORY');
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
  if(state.defaultBranch!==product.defaultBranch||state.repositoryId!==product.id||state.activeCycleId||!key(state.candidate?.id))throw Error('BOUNDED_CANDIDATE_REQUIRED');
  const chunk=async path=>decodeCandidateArchive(Buffer.from(JSON.stringify(await file(path))),product.id);
  const path=`generated/${state.candidate.id}/session.json`,first=await chunk(path),chunks=[first];
  if(!Number.isSafeInteger(first.count)||first.count<1||first.count>128)throw Error('BOUNDED_CHUNKS');
  for(let i=1;i<first.count;i++)chunks.push(await chunk(path.replace('.json',`-${i}.json`)));
  if(chunks.some(c=>c.repositoryId!==product.id||c.candidateId!==state.candidate.id||c.documentKind!=='session'))throw Error('BOUNDED_SESSION');
  const session={repository:state,...await decodeCandidateDocument(chunks)};
  let staleConflict=false;
  if(session.generated) {
    if(session.identity && !session.pending && !state.candidate.pendingWrite) {
      if(!matchesFrozenUnits(session,session.conflict?.generated??session.generated))throw Error('CANDIDATE_FROZEN_UNIT_COVERAGE');
      staleConflict=Boolean(session.conflict)&&!matchesFrozenUnits(session);
    }
    if(product.units && (!session.generated.units.length||session.generated.units.some(unit=>
      !product.units.some(selected=>selected.id===unit.id&&selected.path===unit.path))))throw Error('CANDIDATE_UNIT_NOT_SELECTED');
    const generatedPath=state.candidate.generatedSnapshotPath;
    if(typeof generatedPath!=='string'||!generatedPath.startsWith(`generated/${state.candidate.id}/`)
      ||!/\/[a-f0-9]{64}\.json$/.test(generatedPath)||generatedPath.split('/').length!==3)throw Error('BOUNDED_GENERATED_PATH');
    const firstGenerated=await chunk(generatedPath),generatedChunks=[firstGenerated];
    if(!Number.isSafeInteger(firstGenerated.count)||firstGenerated.count<1||firstGenerated.count>128)throw Error('BOUNDED_GENERATED_CHUNKS');
    for(let i=1;i<firstGenerated.count;i++)generatedChunks.push(await chunk(generatedPath.replace('.json',`-${i}.json`)));
    if(generatedChunks.some(c=>c.repositoryId!==product.id||c.candidateId!==state.candidate.id||c.documentKind!=='generated')
      ||!isDeepStrictEqual(await decodeCandidateDocument(generatedChunks),session.generated))throw Error('BOUNDED_GENERATED_MISMATCH');
  }
  let identity=null;
  if(staleConflict) {
    if(requireReady)throw Error('CANDIDATE_OBSERVATION_NOT_READY');
  } else if(requireReady)identity=candidateObservationIdentity(session);
  else if(session.manualValidation)identity=candidateObservationIdentity(session);
  else {try {identity=candidateObservationIdentity(session);}catch { /* A normal event may recover the existing pending candidate. */ }}
  const pull=await get(`/repos/${product.name}/pulls/${state.candidate.prNumber}`);
  if(pull.number!==state.candidate.prNumber||pull.head?.repo?.id!==product.id||pull.base?.repo?.id!==product.id
    ||pull.head.ref!==state.candidate.branch||pull.base.ref!==product.defaultBranch||!sha(pull.head.sha))throw Error('BOUNDED_PULL');
  if(session.manualValidation&&(session.manualValidation.prNumber!==pull.number||session.manualValidation.branch!==pull.head.ref))throw Error('MANUAL_OWNER');
  const after=await get(`/repos/${product.name}/git/ref/heads/steward/release-state`);
  if(after.object?.sha!==stateCommit)throw Error('BOUNDED_STATE_MOVED');
  return {identity,state,session,pull,evidence:{stateCommit,path,documentDigest:first.documentDigest,prNumber:pull.number,head:pull.head.sha}};
}
export async function validateCandidateEvent(hint,get,target=product) {
  return validateIssueEvent(hint,get,true,undefined,target);
}
export async function validateNormalCandidateEvent(hint,sourceSha,get,target=product) {
  if(!sha(sourceSha))throw Error('CANDIDATE_EVENT_SOURCE');
  return validateIssueEvent(hint,get,false,sourceSha,target);
}
async function validateIssueEvent(hint,get,requireReady,sourceSha,product) {
  exact(hint,['repositoryId','prNumber','eventId']);
  if(hint.repositoryId!==product.id||!Number.isSafeInteger(hint.prNumber)||hint.prNumber<1||!Number.isSafeInteger(hint.eventId)||hint.eventId<1)throw Error('BOUNDED_EVENT_HINT');
  const current=await candidateEvidence(get,{requireReady,product});
  if(current.pull.number!==hint.prNumber||current.pull.state!=='open'||current.pull.merged)throw Error('BOUNDED_EVENT_OBJECT');
  const main=await get(`/repos/${product.name}/git/ref/heads/${encodeURIComponent(product.defaultBranch)}`);
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
