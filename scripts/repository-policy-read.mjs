import {createHash} from 'node:crypto';
import {Octokit} from '@octokit/rest';
import {parseRegistration} from './repository-registration-policy.mjs';
import {adminId} from './repository-registration-request.mjs';
import apiVersion from '../config/github-api.json' with {type:'json'};

const target={owner:'splrad',repo:'steward-settings'};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const check=value=>{if(!value)throw Error('REPOSITORY_POLICY_UNAVAILABLE');};

// A missing file is accepted only after verifying both native directory inventories.
export async function readRepositoryPolicy(api, repository, {allowRegisteredRename=false}={}) {
  const name=repository.full_name;
  check(Number.isSafeInteger(repository.id)&&repository.id>0&&/^splrad\/[\w.-]+$/.test(name));
  const {data:admin}=await api.rest.repos.get(target);
  check(admin.id===adminId&&admin.full_name==='splrad/steward-settings'&&admin.private===true
    &&admin.default_branch==='main'&&admin.owner?.id===302208797&&admin.archived===false&&admin.disabled===false);
  const head=async()=>{
    const {data:branch}=await api.rest.repos.getBranch({...target,branch:'main'});
    check(branch.name==='main'&&branch.protected===true&&sha(branch.commit?.sha));
    return branch.commit.sha;
  };
  const commit=await head();
  const entry=async(treeSha,path)=>{
    const {data}=await api.rest.git.getTree({...target,tree_sha:treeSha});
    check(data.truncated===false&&Array.isArray(data.tree));
    const found=data.tree.filter(item=>item.path===path);
    check(found.length<=1);
    return found[0];
  };
  const directory=await entry(commit,'repositories');
  let policy=null;
  if(directory) {
    check(directory.type==='tree'&&directory.mode==='040000'&&sha(directory.sha));
    const path=`repositories/${repository.id}.json`;
    const blob=await entry(directory.sha,`${repository.id}.json`);
    if(blob) {
      check(blob.type==='blob'&&blob.mode==='100644'&&sha(blob.sha));
      const {data:file}=await api.rest.repos.getContent({...target,ref:commit,path});
      check(file.path===path&&file.type==='file'&&file.sha===blob.sha&&file.encoding==='base64');
      const bytes=Buffer.from(file.content,'base64');
      check(bytes.length===file.size&&createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')===blob.sha);
      policy=parseRegistration(bytes,repository.id);
      // A rename cannot reopen a paused writer. Reconcile the registered name before further operations.
      check(allowRegisteredRename||policy.repository===name);
    }
  }
  check(await head()===commit);
  return {commit,policy,adoption:policy?.adoption??'legacy'};
}

export async function mergedRepositoryPolicy(app,repository,options) {
  try {
    return await app.forRepository(adminId,token=>readRepositoryPolicy(new Octokit({auth:token,
      request:{headers:{'x-github-api-version':apiVersion.version}}}),repository,options),'registry-read');
  } catch {
    throw Error('REPOSITORY_POLICY_UNAVAILABLE');
  }
}
