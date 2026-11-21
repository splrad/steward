import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {completionFile,evaluateCompletion,isolatedBuildEnvironment,NativeEvidenceReader,nativeReleaseApp,nativeEvidenceTransport} from '../packages/runner/dist/index.js';
import {initializeReleaseAdoption} from './release-adoption.mjs';
import {inspectRepositoryHistory,readNativeCompletion,readReleaseRecords} from './release-record.mjs';
import {adoptionTransport} from './release-state-initialize.mjs';
import {initializationDiagnostics} from './initialization-diagnostics.mjs';

const fail=code=>{throw Error('LAYERSCAPE_INITIALIZE_'+code);};
const failureCodes=new Set(['SOURCE','IDENTITY','READ','REPOSITORY','STATE_UNKNOWN','HEAD_CHANGED','STATE_CHANGED','NOT_APPLIED','STOPPED'].map(code=>'LAYERSCAPE_INITIALIZE_'+code));
export const initializationFailureCode=error=>failureCodes.has(error?.message)?error.message:'LAYERSCAPE_INITIALIZE_STOPPED';
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const repository={id:1187527897,full_name:'splrad/LayerScape',default_branch:'main',private:false};
const adoption={prNumber:176,sourceSha:'de10de20b5405d764bfda731ed91d11ac56b5b2c'};
const closeoutCycle='pr-192-3755e1426c3d9776927658480fe610b298c27813';

export function validateInitialization(env) {
  if(env.GITHUB_REPOSITORY!=='splrad/steward'||env.GITHUB_REPOSITORY_ID!=='1296724484'
    ||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_RUN_ATTEMPT!=='1'
    ||env.GITHUB_WORKFLOW_REF!=='splrad/steward/.github/workflows/layerscape-release-initialize.yml@refs/heads/main'
    ||!sha(env.GITHUB_SHA)||env.WORKFLOW_SHA!==env.GITHUB_SHA||env.APPROVED_CONTROLLER_SHA!==env.GITHUB_SHA
    ||env.AUTHORIZE_INITIALIZATION!=='true'||!sha(env.EXPECTED_PRODUCT_HEAD))fail('SOURCE');
  const plan={repository,baseSha:env.EXPECTED_PRODUCT_HEAD,releaseAdoption:adoption};
  const operation=env.RELEASE_OPERATION||'initialize';
  if(operation==='initialize'&&!env.EXPECTED_STATE_HEAD)return plan;
  if(operation!=='closeout-192'||!sha(env.EXPECTED_STATE_HEAD)||!env.GITHUB_TOKEN)fail('SOURCE');
  return {...plan,closeoutHead:env.EXPECTED_STATE_HEAD,controllerSha:env.GITHUB_SHA};
}

export async function closeout192(plan,request,{token,io,centralIo,readRecords=readReleaseRecords,readCompletion=readNativeCompletion,inspectHistory=inspectRepositoryHistory}) {
  const central=new NativeEvidenceReader(centralIo,'splrad/steward');
  const currentController=()=>central.json('git/ref/heads/steward/validated-controller');
  if((await currentController()).object?.sha!==plan.controllerSha)fail('SOURCE');
  const product=new NativeEvidenceReader(io,request.repository);
  const candidate=async()=>{
    const pr=await product.json('pulls/201');
    if(pr.number!==201||pr.state!=='open'||pr.head?.repo?.id!==repository.id
      ||pr.head.ref!=='steward/release-candidate'||pr.base?.ref!=='main'||!sha(pr.head.sha))fail('STATE_CHANGED');
    return pr.head.sha;
  };
  const currentState=async()=>{
    const value=await product.json('git/ref/heads/steward/release-state');
    if(value.ref!=='refs/heads/steward/release-state'||value.object?.type!=='commit'||!sha(value.object.sha))fail('STATE_CHANGED');
    return value.object.sha;
  };
  const candidateHead=await candidate();
  const before=await readRecords({...request,targetRef:'steward/release-state',includeHistory:true});
  const [entry]=before.cycles;
  if(before.head!==plan.closeoutHead||before.history.some(row=>row.status!=='DECODED')
    ||before.cycles.length!==1||entry.value.id!==closeoutCycle
    ||entry.value.units.length!==1||entry.value.units[0].releaseId!==450956063
    ||before.repository?.candidate?.prNumber!==201)fail('STATE_CHANGED');
  const validateTarget=async expected=>{
    if((await currentController()).object?.sha!==plan.controllerSha||await candidate()!==candidateHead
      ||await currentState()!==expected)fail('STATE_CHANGED');
  };
  // The history reader takes its evaluation time before it asks for evidence.
  const completion=await readCompletion(request,entry.value,{io,centralIo});
  if(evaluateCompletion(completion.source,completion.observation,new Date().toISOString()).result!=='PASS')fail('NOT_APPLIED');
  if(before.repository.activeCycleId===null&&before.repository.lastCompletedCycleId===closeoutCycle) {
    const archive=before.domainRecords.find(row=>row.path===entry.value.completedEvidencePath)?.value;
    if(!archive||!isDeepStrictEqual(archive.source,completion.source)
      ||evaluateCompletion(archive.source,archive.observation,archive.observation.observedAt).result!=='PASS'
      ||archive.provenance.some(proof=>!before.domainRecords.some(record=>record.path===proof.path
        &&typeof record.content==='string'&&createHash('sha256').update(record.content).digest('hex')===proof.digest)))
      fail('NOT_APPLIED');
    await validateTarget(before.head);
    return {status:'UNCHANGED',archiveHead:before.head,cycleId:closeoutCycle,candidateHead};
  }
  if(before.repository.activeCycleId!==closeoutCycle)fail('STATE_CHANGED');
  const result=await inspectHistory(request,{token,io,centralIo,beforeArchivePush:()=>validateTarget(before.head),
    completionReader:cycle=>{
      if(cycle.id!==closeoutCycle)fail('STATE_CHANGED');
      return completion;
    }});
  if(result.result!=='PASS'||result.lastCompletedCycleId!==closeoutCycle||!sha(result.archiveHead))fail('NOT_APPLIED');
  await validateTarget(result.archiveHead);
  // The native history writer preserves the next candidate and archives fresh completion proof.
  const state=async path=>{
    const blob=await product.json('contents/'+path+'?ref='+result.archiveHead);
    if(blob.path!==path||blob.encoding!=='base64')fail('READ');
    return JSON.parse(Buffer.from(blob.content,'base64').toString('utf8'));
  };
  const evidencePath=completionFile(completion).path;
  const after=await state('state.json'), cycle=await state('cycles/'+closeoutCycle+'.json');
  if(after.activeCycleId!==null||after.lastCompletedCycleId!==closeoutCycle
    ||!isDeepStrictEqual(after.candidate,before.repository.candidate)
    ||cycle.completedEvidencePath!==evidencePath||!isDeepStrictEqual(await state(evidencePath),completion)
    ||!isDeepStrictEqual(cycle.channelFacts,entry.value.channelFacts)
    ||!isDeepStrictEqual(cycle.requiredChannels,entry.value.requiredChannels))
    fail('STATE_CHANGED');
  await validateTarget(result.archiveHead);
  return {status:'APPLIED',archiveHead:result.archiveHead,cycleId:closeoutCycle,candidateHead};
}

export async function initializeProduct(plan,{root,app,execute=promisify(execFile),initialize=initializeReleaseAdoption,centralIo,fetcher=fetch,stage=()=>{},onFailure=()=>{}}) {
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
    if(plan.closeoutHead&&(state.status!==200||!centralIo))fail('STATE_UNKNOWN');
    const expected=state.status===200?JSON.parse(Buffer.from(state.bytes).toString('utf8')).object?.sha:null;
    if(state.status===200&&!sha(expected))fail('STATE_UNKNOWN');
    if(plan.closeoutHead&&expected!==plan.closeoutHead)fail('STATE_CHANGED');
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
    if(expected) {
      await git('fetch','--no-tags','--no-recurse-submodules',remote,'refs/heads/steward/release-state:refs/heads/steward/release-state');
      if(await git('rev-parse','refs/heads/steward/release-state')!==expected)fail('STATE_CHANGED');
    }
    stage('adoption-reconcile');
    const request={directory,writeDirectory:join(root,'writes'),remote,
      repository:repository.full_name,repositoryId:repository.id,defaultBranch:'main',appBotId:app.appBotId,
      identity:{name:'splrad-steward[bot]',email:'301115370+splrad-steward[bot]@users.noreply.github.com'},releaseAdoption:adoption};
    const result=plan.closeoutHead?await closeout192(plan,request,{token,io,centralIo}):await initialize(request,{token,io,fetcher});
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
  const captureFailure=error=>{failure??=error;diagnostics.captureFailure(error);};
  try {
    const plan=validateInitialization(env);root=await mkdtemp(join(tmpdir(),'layerscape-initialize-'));
    diagnostics.stage('app-identity');
    const fetcher=diagnostics.transport(fetch);
    const app=await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY??'',fetcher,captureFailure);
    const centralIo=plan.closeoutHead?nativeEvidenceTransport(env.GITHUB_TOKEN,fetcher):undefined;
    result=await initializeProduct(plan,{root,app,centralIo,fetcher,stage:diagnostics.stage,onFailure:captureFailure});

  } catch(error) {
    captureFailure(error);
  } finally {
    if(root)try {diagnostics.stage('local-cleanup');await rm(root,{recursive:true,force:true});}
    catch(error){captureFailure(error);}
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
