import {isDeepStrictEqual} from 'node:util';
import {inspectRepository,deliveryPath,publishPath,versionsPath} from './configuration-view.mjs';
import {mergedRepositoryPolicy} from './repository-policy-read.mjs';
import {releaseAssetConsumerConflicts,releaseAssetSelections,releaseRegistration} from './repository-registration-policy.mjs';

// Releases already in progress use their frozen source. This guard admits new candidates.
export function releasePolicyGuard(app, repository, readPolicy=mergedRepositoryPolicy) {
  return async read=>{
    const selection=await readPolicy(app,repository);
    if(selection.adoption!=='central')return;
    if(!selection.policy.release)throw Error('CANDIDATE_REPOSITORY_POLICY_DISABLED');
    const files=new Map(await Promise.all([deliveryPath,publishPath,versionsPath].map(async path=>[path,await read(path)])));
    const pending=[];
    const model=inspectRepository(files),current=releaseRegistration(model,pending);
    const assets=releaseAssetSelections(selection.policy.release,current);
    if(pending.length||assets===null)
      throw Error('CANDIDATE_REPOSITORY_POLICY_CONFLICT');
    const siteExcludesRelease=site=>assets.some(unit=>site?.source==='release'&&site.unit===unit.unitId);
    const [consumerConflict]=await releaseAssetConsumerConflicts(assets,current,selection.policy.site,
      {read,assetCount:id=>model.delivery?.units.find(unit=>unit.id===id)?.assets.length??0});
    if(consumerConflict)throw Error('CANDIDATE_REPOSITORY_POLICY_'+consumerConflict);
    const latest=await readPolicy(app,repository);
    if(latest.adoption!==selection.adoption||latest.policy?.repositoryId!==selection.policy.repositoryId||
      latest.policy?.repository!==selection.policy.repository||
      !isDeepStrictEqual(latest.policy?.release,selection.policy.release)||siteExcludesRelease(latest.policy?.site))
      throw Error('CANDIDATE_REPOSITORY_POLICY_MOVED');
    return assets;
  };
}
