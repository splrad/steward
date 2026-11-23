import { createHash } from 'node:crypto';
import registrations from '../config/release/event-repositories.json' with {type:'json'};
import {releaseParticipation} from './release-coordinator.mjs';
import {nativeEvidenceTransport} from '../packages/runner/dist/index.js';

export async function withParticipatingProduct(app,id,operation,transport=nativeEvidenceTransport) {
  if(!Number.isSafeInteger(id)||id<1)throw Error('BOUNDED_EVENT_HINT');
  const matches=(await app.discover({publicCandidatesOnly:true})).filter(repo=>repo.id===id);
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
const legacy=registrations.filter(record=>record.legacyPublicationCallback===true);
export const product = legacy.length===1 ? legacy[0] : undefined;
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw Error('BOUNDED_INPUT');
}
