import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {repositoryPolicyPath,repositoryPolicyBranch} from '../packages/runner/dist/index.js';
import {mergedRepositoryPolicy} from './repository-policy-read.mjs';
import {projectionBytes} from './repository-policy-projection.mjs';
import {writeReleaseRecords} from './release-record.mjs';
import {nativeTemporaryParent} from './native-scratch.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const check=(condition,code)=>{if(!condition)throw Error('REPOSITORY_POLICY_PROJECTION_'+code);};
const identity={name:'splrad-steward[bot]',email:'301115370+splrad-steward[bot]@users.noreply.github.com'};

export async function projectMergedRepositoryPolicy(app, repository, source, observe, readSource, ports) {
  const getPolicy=ports.getPolicy??mergedRepositoryPolicy;
  const readMerged=()=>getPolicy(app,repository,{allowRegisteredRename:true});
  const adopted=await readMerged();
  if(!adopted.policy||adopted.policy.repository!==repository.full_name)return;
  const selected=adopted.policy;
  if(selected.adoption==='central') {
    const observed=(await observe()).policy;
    check(selected.productCi.every(path=>observed.productCi.includes(path)),'PRODUCT_CI');
    if(selected.site) {
      check(await readSource(selected.site.workflow),'PAGES');
      if(selected.site.source==='release')check(observed.release?.units.some(unit=>unit.id===selected.site.unit),'PAGES');
    }
  }
  const content=projectionBytes(selected);
  const root=await mkdtemp(join(await nativeTemporaryParent('REPOSITORY_POLICY_PROJECTION_TEMP_LINK'),'repository-policy-projection-'));
  try {
    return await app.forRepository(repository.id,async token=>{
      const getState=ports.getState??(await import('./release-coordinator.mjs')).fetchState;
      const refresh=()=>getState(root,repository,token,repositoryPolicyBranch,{governanceAppId:5639432,includeHistory:false});
      const state=await refresh();
      const current=state.snapshot.currentPaths.includes(repositoryPolicyPath)?await state.readBytes(repositoryPolicyPath):null;
      const latest=await readMerged();
      check(latest.policy&&latest.commit===adopted.commit&&latest.policy.repository===repository.full_name&&
        projectionBytes(latest.policy)===content&&await ports.currentSource()===source,'MOVED');
      if(current?.toString('utf8')===content)return 'UNCHANGED';
      const directory=await mkdtemp(join(root,'write-'));
      const result=await (ports.write??writeReleaseRecords)({directory:join(directory,'checkout'),remote:state.remote,
        repositoryId:repository.id,defaultBranch:repository.default_branch,targetRef:repositoryPolicyBranch,writer:'configuration',
        expectedHead:state.snapshot.head,allowedPaths:[repositoryPolicyPath],identity,
        changes:[{path:repositoryPolicyPath,content,sha256:hash(content),previousSha256:current===null?null:hash(current)}]},{token});
      check(['APPLIED','UNCHANGED'].includes(result.status),'WRITE');
      const after=await refresh();
      check(after.snapshot.currentPaths.includes(repositoryPolicyPath)&&
        (await after.readBytes(repositoryPolicyPath)).toString('utf8')===content,'READBACK');
      return result.status;
    },'registry-projection');
  } finally {
    await rm(root,{recursive:true,force:true});
  }
}
