import {isDeepStrictEqual} from 'node:util';
import {inspectRepository,deliveryPath,publishPath,versionsPath} from './configuration-view.mjs';
import {mergedRepositoryPolicy} from './repository-policy-read.mjs';
import {releaseRegistration} from './repository-registration-policy.mjs';

// Releases already in progress use their frozen source. This guard admits new candidates.
export function releasePolicyGuard(app, repository, readPolicy=mergedRepositoryPolicy) {
  return async (read,{nativeEntry=false,priorRegistration=false,buildWorkflow=publishPath}={})=>{
    if(nativeEntry&&!priorRegistration)return;
    const selection=await readPolicy(app,repository);
    if(selection.adoption==='paused')throw Error('CANDIDATE_REPOSITORY_POLICY_DISABLED');
    if(selection.adoption!=='central')return;
    // A compact entry uses its reviewed source and can still honor the registered pause.
    if(nativeEntry)return;
    if(!selection.policy.release)throw Error('CANDIDATE_REPOSITORY_POLICY_DISABLED');
    const [delivery,workflow,versions]=await Promise.all([read(deliveryPath),read(buildWorkflow),read(versionsPath)]);
    // Registration retains the legacy publisher field. Compare its choices using the reviewed workflow.
    const files=new Map([[deliveryPath,delivery],[publishPath,workflow],[versionsPath,versions]]);
    const pending=[];
    const {release,nativeReleaseUnits}=releaseRegistration(inspectRepository(files),pending);
    if(nativeReleaseUnits||pending.length||!isDeepStrictEqual(selection.policy.release,release))
      throw Error('CANDIDATE_REPOSITORY_POLICY_CONFLICT');
    const latest=await readPolicy(app,repository);
    if(latest.adoption!==selection.adoption||latest.policy?.repositoryId!==selection.policy.repositoryId||
      latest.policy?.repository!==selection.policy.repository||
      !isDeepStrictEqual(latest.policy?.release,selection.policy.release))
      throw Error('CANDIDATE_REPOSITORY_POLICY_MOVED');
  };
}
