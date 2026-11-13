import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isolatedBuildEnvironment,nativeReleaseApp} from '../packages/runner/dist/index.js';
import {initializeReleaseAdoption} from './release-adoption.mjs';
import {adoptionTransport} from './release-state-initialize.mjs';
import {initializationDiagnostics} from './initialization-diagnostics.mjs';

const fail=code=>{throw Error('LAYERSCAPE_INITIALIZE_'+code);};
const failureCodes=new Set(['SOURCE','IDENTITY','READ','REPOSITORY','STATE_UNKNOWN','HEAD_CHANGED','STATE_CHANGED','NOT_APPLIED','STOPPED'].map(code=>'LAYERSCAPE_INITIALIZE_'+code));
export const initializationFailureCode=error=>failureCodes.has(error?.message)?error.message:'LAYERSCAPE_INITIALIZE_STOPPED';
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const repository={id:1187527897,full_name:'splrad/LayerScape',default_branch:'main',private:false};
const adoption={prNumber:176,sourceSha:'de10de20b5405d764bfda731ed91d11ac56b5b2c'};

export function validateInitialization(env) {
  if(env.GITHUB_REPOSITORY!=='splrad/steward'||env.GITHUB_REPOSITORY_ID!=='1296724484'
    ||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_RUN_ATTEMPT!=='1'
    ||env.GITHUB_WORKFLOW_REF!=='splrad/steward/.github/workflows/layerscape-release-initialize.yml@refs/heads/main'
    ||!sha(env.GITHUB_SHA)||env.WORKFLOW_SHA!==env.GITHUB_SHA||env.APPROVED_CONTROLLER_SHA!==env.GITHUB_SHA
    ||env.AUTHORIZE_INITIALIZATION!=='true'||!sha(env.EXPECTED_PRODUCT_HEAD))fail('SOURCE');
  return {repository,baseSha:env.EXPECTED_PRODUCT_HEAD,releaseAdoption:adoption};
}

export async function initializeProduct(plan,{root,app,execute=promisify(execFile),initialize=initializeReleaseAdoption,fetcher=fetch,stage=()=>{},onFailure=()=>{}}) {
  if(plan.repository?.id!==repository.id||plan.repository.full_name!==repository.full_name
    ||!sha(plan.baseSha)||plan.releaseAdoption?.prNumber!==adoption.prNumber
    ||plan.releaseAdoption.sourceSha!==adoption.sourceSha||app.appBotId!==301115370)fail('IDENTITY');
  stage('release-credential');
  return app.forRepository(repository.id,async token=>{
    stage('candidate-read-credential');
    try {return await app.forCandidateReadRepository(repository.id,async readToken=>{
    try {
    stage('repository-read');
    const io=adoptionTransport(plan,{token,readToken,fetcher});
    const read=async suffix=>{
      const response=await io.request('GET','/repos/'+repository.full_name+suffix);
      if(response.status!==200)fail('READ');
      return JSON.parse(Buffer.from(response.bytes).toString('utf8'));
    };
    const current=await read('');
    if(current.id!==repository.id||current.full_name!==repository.full_name||current.private!==false
      ||current.default_branch!=='main'||current.archived!==false||current.disabled!==false)fail('REPOSITORY');
    await read('/git/ref/heads/main');
    stage('state-read');
    const state=await io.request('GET','/repos/'+repository.full_name+'/git/ref/heads/steward/release-state');
    if(![200,404].includes(state.status))fail('STATE_UNKNOWN');
    if(state.status===404) {
      const matches=await read('/git/matching-refs/heads/steward/release-state');
      if(!Array.isArray(matches)||matches.length!==0)fail('STATE_UNKNOWN');
    }
    stage('source-fetch');
    const directory=await mkdtemp(join(root,'source-')),profile=await mkdtemp(join(root,'profile-'));
    const env=isolatedBuildEnvironment(process.env,profile);
    const git=async(...args)=>(await execute('git',['--no-replace-objects','-c','core.hooksPath=','-c','core.fsmonitor=false','-c','credential.helper=',...args],
      {cwd:directory,env,encoding:'utf8',windowsHide:true,timeout:90_000,maxBuffer:32*1024*1024})).stdout.trim();
    const remote='https://github.com/splrad/LayerScape.git';
    await git('init','--initial-branch=adoption-read');
    // Public Git objects only: never checkout or execute product source, and never pass the App key to Git.
    await git('fetch','--no-tags','--no-recurse-submodules',remote,'refs/heads/main:refs/heads/main');
    if(await git('rev-parse','refs/heads/main')!==plan.baseSha)fail('HEAD_CHANGED');
    if(state.status===200) {
      const expected=JSON.parse(Buffer.from(state.bytes).toString('utf8')).object?.sha;
      if(!sha(expected))fail('STATE_UNKNOWN');
      await git('fetch','--no-tags','--no-recurse-submodules',remote,'refs/heads/steward/release-state:refs/heads/steward/release-state');
      if(await git('rev-parse','refs/heads/steward/release-state')!==expected)fail('STATE_CHANGED');
    }
    stage('adoption-reconcile');
    const result=await initialize({directory,writeDirectory:join(root,'writes'),remote,
      repository:repository.full_name,repositoryId:repository.id,defaultBranch:'main',appBotId:app.appBotId,
      identity:{name:'splrad-steward[bot]',email:'301115370+splrad-steward[bot]@users.noreply.github.com'},releaseAdoption:adoption},{token,io,fetcher});
    if(!['APPLIED','UNCHANGED'].includes(result.status))fail('NOT_APPLIED');
    stage('credential-cleanup');
    return result;
    }catch(error){onFailure(error);throw error;}
    });}catch(error){onFailure(error);throw error;}
  });
}

export async function main(env=process.env) {
  const diagnostics=initializationDiagnostics(value=>process.stdout.write(JSON.stringify({status:'INITIALIZATION_DIAGNOSTIC',...value})+'\n'));
  let root,result,failure;
  try {
    const plan=validateInitialization(env);root=await mkdtemp(join(tmpdir(),'layerscape-initialize-'));
    diagnostics.stage('app-identity');
    const fetcher=diagnostics.transport(fetch);
    const app=await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY??'',fetcher,diagnostics.captureFailure);
    result=await initializeProduct(plan,{root,app,fetcher,stage:diagnostics.stage,onFailure:diagnostics.captureFailure});

  } catch(error) {
    failure=error;diagnostics.captureFailure(error);
  } finally {
    if(root)try {diagnostics.stage('local-cleanup');await rm(root,{recursive:true,force:true});}
    catch(error){failure??=error;diagnostics.captureFailure(error);}
  }
  if(failure) {
    const code=initializationFailureCode(failure);
    throw Object.assign(new Error(code),{diagnostic:diagnostics.failure(failure)});
  }
  diagnostics.stage('complete');
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
  const code=initializationFailureCode(error);
  process.stderr.write(JSON.stringify({status:'STOPPED',code,diagnostic:error?.diagnostic})+'\n');process.exitCode=75;
});
