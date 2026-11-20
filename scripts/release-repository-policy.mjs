import {isDeepStrictEqual} from 'node:util';
import {inspectRepository,deliveryPath,publishPath,versionsPath} from './configuration-view.mjs';
import {mergedRepositoryPolicy} from './repository-policy-read.mjs';
import {releaseRegistration} from './repository-registration.mjs';

// Releases already in progress use their frozen source. This guard admits new candidates.
export function releasePolicyGuard(app, repository, readPolicy=mergedRepositoryPolicy) {
  return async read=>{
    const selection=await readPolicy(app,repository);
    if(selection.adoption!=='central')return;
    if(!selection.policy.release)throw Error('CANDIDATE_REPOSITORY_POLICY_DISABLED');
    const files=new Map(await Promise.all([deliveryPath,publishPath,versionsPath].map(async path=>[path,await read(path)])));
    const pending=[];
    const current=releaseRegistration(inspectRepository(files),pending);
    if(pending.length||!isDeepStrictEqual(selection.policy.release,current))
      throw Error('CANDIDATE_REPOSITORY_POLICY_CONFLICT');
  };
}
