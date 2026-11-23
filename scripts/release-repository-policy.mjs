import {isDeepStrictEqual} from 'node:util';
import {inspectRepository,deliveryPath,publishPath,versionsPath} from './configuration-view.mjs';
import {mergedRepositoryPolicy} from './repository-policy-read.mjs';
import {releaseRegistration} from './repository-registration-policy.mjs';

// Legacy delivery declarations still honor the previously approved unit and channel selection.
export function releasePolicyGuard(app, repository, readPolicy=mergedRepositoryPolicy) {
  return async (read,{nativeEntry=false,buildWorkflow=publishPath}={})=>{
    if(nativeEntry)return;
    const selection=await readPolicy(app,repository);
    if(selection.adoption!=='central'&&selection.adoption!=='paused')return;
    if(!selection.policy?.release)throw Error('CANDIDATE_REPOSITORY_POLICY_DISABLED');
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
