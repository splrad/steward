import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {isolatedBuildEnvironment} from '../packages/runner/dist/index.js';
import {bootstrapNativeIO,verifyGovernanceCreation} from './repository-bootstrap.mjs';
import {qualityNativeIO,assertQualityProtection} from './quality-language-summary.mjs';
import {readReleaseRecords} from './release-record.mjs';
const branch='steward/governance-state',ref='refs/heads/'+branch;
const check=(ok,code)=>{if(!ok)throw Error('ACCEPTANCE_INIT_'+code);};

// A parentless empty root carries no invented bootstrap history or business facts.
// A plain push cannot overwrite a concurrently created, unrelated root.
export async function createEmptyGovernanceRoot({directory,remote,environment,beforePush,readHead,controllerSha},execute=promisify(execFile)) {
  const git=async(...args)=>(await execute('git',['--no-replace-objects','-c','core.hooksPath=','-c','core.fsmonitor=false','-c','credential.helper=',...args],
    {cwd:directory,env:environment,encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:16*1024*1024})).stdout.trim();
  await git('init','--initial-branch=state-initialize');
  await git('config','user.name','splrad-steward[bot]');
  await git('config','user.email','301115370+splrad-steward[bot]@users.noreply.github.com');
  await git('commit','--allow-empty','--no-gpg-sign','--signoff','-m',`Initialize empty governance state\n\nController: ${controllerSha}`);
  const head=await git('rev-parse','HEAD');
  check(/^[a-f0-9]{40}$/.test(head)&&await git('show','-s','--format=%P',head)===''&&await git('ls-tree','-r',head)==='','ROOT');
  await beforePush();
  try {await git('push','--porcelain',remote,`HEAD:${ref}`);} catch {/* Exit status cannot establish adoption; read once, never resend. */}
  check(await readHead()===head,'WRITE_UNCONFIRMED');
  await git('update-ref',ref,head);
  const state=await readReleaseRecords({directory,targetRef:branch,repositoryId:1296724484});
  check(state.head===head&&state.currentPaths.length===0&&state.domainRecords.length===0,'READBACK');
  return head;
}

export async function initializeQualityState(p,{root,token,fetcher=fetch,execute=promisify(execFile)}) {
  check(p.kind==='quality-initialize'&&p.maxRequests===0&&p.stateSha===null&&p.repository.id===1296724484
    &&p.repository.full_name==='splrad/steward'&&p.repository.default_branch==='main'&&p.repository.private===false
    &&p.governanceAppId===5639432&&/^[a-f0-9]{40}$/.test(p.baseSha)&&p.baseSha===p.controllerSha,'PLAN');
  const io=bootstrapNativeIO(token,fetcher),prefix='/repos/splrad/steward';
  const get=async path=>{const r=await io.request('GET',path);check(r.status===200,'READ');return r.value;};
  const verify=async()=>{
    const r=await get(prefix);check(r.id===1296724484&&r.full_name==='splrad/steward'&&r.owner?.id===302208797
      &&r.default_branch==='main'&&r.private===false&&!r.archived&&!r.disabled,'REPOSITORY');
    check((await get(prefix+'/git/ref/heads/main')).object?.sha===p.baseSha,'BASE');
    const state=await io.request('GET',prefix+'/git/ref/heads/'+branch);check(state.status===404,'REF_EXISTS_OR_UNKNOWN');
    // Cross-check absence: a 404 by itself is not evidence of an empty namespace.
    const refs=await get(prefix+'/git/matching-refs/heads/'+branch+'?per_page=100');check(Array.isArray(refs)&&refs.length===0,'REF_NOT_ABSENT');
    await verifyGovernanceCreation(io,{...p.repository,name:'steward'},p.governanceAppId);
  };
  await verify();
  const directory=await mkdtemp(join(root,'governance-init-')),profile=join(directory,'profile');await mkdir(profile);
  const remote='https://github.com/splrad/steward.git',environment=isolatedBuildEnvironment(process.env,profile);
  Object.assign(environment,{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:`http.${remote}.extraheader`,GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+Buffer.from('x-access-token:'+token).toString('base64')});
  const head=await createEmptyGovernanceRoot({directory,remote,environment,controllerSha:p.controllerSha,beforePush:verify,
    readHead:async()=>{const r=await get(prefix+'/git/ref/heads/'+branch);check(r.ref===ref&&r.object?.type==='commit','REF_READBACK');return r.object.sha;}},execute);
  await assertQualityProtection(qualityNativeIO('splrad/steward',token,fetcher),'splrad/steward',p.governanceAppId);
  check((await get(prefix+'/git/ref/heads/main')).object?.sha===p.baseSha,'BASE');
  return {kind:p.kind,status:'INITIALIZED',calls:0,stateSha:head};
}