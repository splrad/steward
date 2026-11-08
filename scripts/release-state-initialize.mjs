import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {isolatedBuildEnvironment,nativeEvidenceTransport} from '../packages/runner/dist/index.js';
import {initializeReleaseAdoption} from './release-adoption.mjs';
const requireFact=(value,code)=>{if(!value)throw new Error('ACCEPTANCE_'+code);};

/** Fetch complete object history without checking out or executing private source. */
export async function fetchAdoptionSource({root,remote,token,baseSha,governanceSha},execute=promisify(execFile)) {
  const directory=await mkdtemp(join(root,'adoption-source-')),profile=await mkdtemp(join(root,'adoption-profile-'));
  const env=isolatedBuildEnvironment(process.env,profile);
  Object.assign(env,{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:`http.${remote}.extraheader`,GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+Buffer.from('x-access-token:'+token).toString('base64')});
  const git=async(...args)=>(await execute('git',['--no-replace-objects','-c','core.hooksPath=','-c','core.fsmonitor=false','-c','credential.helper=',...args],
    {cwd:directory,env,encoding:'utf8',maxBuffer:32*1024*1024,timeout:90_000,windowsHide:true})).stdout.trim();
  await git('init','--initial-branch=adoption-read');
  for(const [branch,expected] of [['main',baseSha],['steward/governance-state',governanceSha]]) {
    await git('fetch','--no-tags','--no-recurse-submodules',remote,`refs/heads/${branch}`);
    const actual=await git('rev-parse','FETCH_HEAD');requireFact(actual===expected,'INITIALIZE_SOURCE_CHANGED');
    await git('update-ref',`refs/heads/${branch}`,actual);
  }
  requireFact(await git('rev-parse','--is-shallow-repository')==='false','INITIALIZE_SHALLOW');
  return directory;
}

export async function initializePrivateRelease(p,{root,token,appBotId,fetcher=fetch,execute=promisify(execFile)}) {
  requireFact(p.kind==='release-initialize'&&p.maxRequests===0&&p.stateSha===null&&p.repository?.id===1448797077
    &&p.repository.full_name==='splrad/steward-e10-lifecycle-20261107'&&p.repository.private===true&&p.repository.default_branch==='main'
    &&/^[a-f0-9]{40}$/.test(p.baseSha)&&p.releaseAdoption?.sourceSha===p.baseSha
    &&Number.isSafeInteger(p.releaseAdoption.prNumber)&&p.releaseAdoption.prNumber>0&&appBotId===301115370,'RELEASE_INITIALIZE_PLAN');
  const transport=nativeEvidenceTransport(token,fetcher),prefix='/repos/'+p.repository.full_name;
  // Pin every adoption-reader observation, including its immediate pre-write check.
  const io={...transport,request:async(method,path,...args)=>{
    const response=await transport.request(method,path,...args);
    if(method==='GET'&&[prefix+'/commits/main',prefix+'/git/ref/heads/main'].includes(path)) {
      requireFact(response.status===200,'INITIALIZE_BASE_UNKNOWN');
      const value=JSON.parse(Buffer.from(response.bytes).toString('utf8'));
      requireFact((value.sha??value.object?.sha)===p.baseSha,'INITIALIZE_BASE_CHANGED');
    }
    return response;
  }};
  const read=async path=>{const r=await io.request('GET',prefix+path);requireFact(r.status===200,'INITIALIZE_READ');return JSON.parse(Buffer.from(r.bytes).toString('utf8'));};
  const repo=await read('');
  requireFact(repo.id===p.repository.id&&repo.full_name===p.repository.full_name&&repo.private===true&&repo.default_branch==='main'
    &&repo.archived===false&&repo.disabled===false,'INITIALIZE_REPOSITORY');
  await read('/git/ref/heads/main');
  const absent=await io.request('GET',prefix+'/git/ref/heads/steward/release-state');
  requireFact(absent.status===404,'INITIALIZE_STATE_EXISTS_OR_UNKNOWN');
  const matches=await read('/git/matching-refs/heads/steward/release-state');
  requireFact(Array.isArray(matches)&&matches.length===0,'INITIALIZE_STATE_EXISTS_OR_UNKNOWN');
  const governance=await read('/git/ref/heads/steward/governance-state');
  requireFact(governance.ref==='refs/heads/steward/governance-state'&&governance.object?.type==='commit'
    &&/^[a-f0-9]{40}$/.test(governance.object.sha),'INITIALIZE_GOVERNANCE');
  const remote=`https://github.com/${p.repository.full_name}.git`;
  const directory=await fetchAdoptionSource({root,remote,token,baseSha:p.baseSha,governanceSha:governance.object.sha},execute);
  const result=await initializeReleaseAdoption({directory,writeDirectory:join(root,'adoption-writes'),remote,
    repository:p.repository.full_name,repositoryId:p.repository.id,defaultBranch:'main',appBotId,
    identity:{name:'splrad-steward[bot]',email:'301115370+splrad-steward[bot]@users.noreply.github.com'},releaseAdoption:p.releaseAdoption},{token,io});
  requireFact(['APPLIED','UNCHANGED'].includes(result.status),'INITIALIZE_NOT_APPLIED');
  // Private commit/PR identifiers stay in the private repository, never public job output.
  return {kind:p.kind,status:'INITIALIZED',calls:0};
}
