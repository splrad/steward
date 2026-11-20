import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeEvidenceReader, nativeEvidenceTransport, nativeReleaseApp, nativeRunFact, verifyExecutionSource, githubUnits, channelTargetsDigest, downloadNativeArtifact } from '../packages/runner/dist/index.js';
import { exact, sha, sha256, withParticipatingProduct } from './bounded-candidate-contract.mjs';
import { entryGuard } from './bounded-release-entry.mjs';
import { fetchState } from './release-coordinator.mjs';
import { releaseCommand } from './release-record.mjs';

const centralId = 1296724484, central = 'splrad/steward';
// The promoted controller binds legacy callbacks and external adapter credentials.
const registrations=JSON.parse(await readFile(new URL('../config/release/event-repositories.json',import.meta.url),'utf8'));
function registeredRepository(event, registry=registrations) {
  const id=event.kind==='publication'?event.productRepositoryId:event.repositoryId;
  // Older central callbacks carry only the controller identity. They are unambiguous for the original pilot.
  const matches=registry.filter(repository=>id===undefined?repository.legacyPublicationCallback===true:repository.id===id);
  if(matches.length!==1)fail('CYCLE_EVENT_KIND');
  return matches[0];
}
export function withCycleEventProduct(app,event,operation,transport=nativeEvidenceTransport) {
  const oldCallback=event.kind==='publication'&&!Object.hasOwn(event,'productRepositoryId');
  const legacy=oldCallback?registeredRepository(event):undefined;
  const id=legacy?legacy.id:event.kind==='publication'?event.productRepositoryId:event.repositoryId;
  if(!['push','run','publication'].includes(event.kind)||!Number.isSafeInteger(id)||id<1)fail('CYCLE_EVENT_KIND');
  return withParticipatingProduct(app,id,product=>{
    if(!legacy)return operation(product);
    if(product.name!==legacy.name||product.defaultBranch!==legacy.defaultBranch)fail('CYCLE_EVENT_KIND');
    return operation({...product,legacyPublicationCallback:true});
  },transport);
}
const identity = {name:'splrad-steward[bot]',email:'301115370+splrad-steward[bot]@users.noreply.github.com'};
const fail = reason => { throw Error(reason); };
const positive = n => Number.isSafeInteger(n) && n > 0;
export function validateEvent(event, requestKey, registry=registrations) {
  const {repositoryId,kind} = event;
  const product=registeredRepository(event,registry);
  if (!['push','run','publication'].includes(kind) || repositoryId !== (kind === 'publication' ? centralId : product.id)) fail('CYCLE_EVENT_KIND');
  const push = kind === 'push';
  exact(event, ['repositoryId','kind',...(push ? ['sourceSha'] : ['runId','attempt']),...(kind==='publication' && event.productRepositoryId!==undefined?['productRepositoryId']:[])]);
  if (push ? !sha(event.sourceSha) : !positive(event.runId) || !positive(event.attempt)) fail('CYCLE_EVENT_ID');
  if (requestKey !== sha256([repositoryId,kind,...(push ? [event.sourceSha] : [event.runId,event.attempt]),...(event.productRepositoryId===undefined?[]:[event.productRepositoryId])])) fail('CYCLE_EVENT_KEY');
}
const wait = reason => ({status:'WAIT',reason});
const only = items => items.length === 1 ? items[0] : fail('CYCLE_EVENT_AMBIGUOUS');
function registeredProbe(run,botId,product) {
  return !(run.repositoryId !== product.id || run.headRepositoryId !== product.id || run.actorId !== botId
    || run.event !== 'workflow_dispatch' || run.headBranch !== product.defaultBranch || run.workflowId !== product.channelWorkflowId
    || run.path !== '.github/workflows/steward-release-channels.yml' || !sha(run.headSha));
}
function probeMatches(cycle,run,botId,product,artifacts) {
  if (!registeredProbe(run,botId,product)) return false;
  const targets=cycle.requiredChannels.map(channel=>{
    const unit=cycle.units.find(u=>u.id===channel.unitId);
    return {...channel,version:unit.version,releaseId:unit.releaseId,manifestDigest:unit.manifestDigest};
  });
  if (!targets.length || targets.some(t=>!t.releaseId || !t.manifestDigest)) return false;
  const keyFor=subset=>channelTargetsDigest({repositoryId:product.id,cycle},subset);
  const direct=[targets,...targets.map(target=>[target])].map(keyFor);
  if (!artifacts) return direct.some(digest=>run.displayTitle==='Channels observe '+sha256(['observe',digest,run.headSha]));
  const prefix='probe-'+cycle.id+'-';
  return artifacts.some(artifact=>{
    if (artifact.expired!==false || typeof artifact.name!=='string' || !artifact.name.startsWith(prefix)
        || artifact.workflow_run?.id!==run.id || artifact.workflow_run?.head_sha!==run.headSha) return false;
    const match=/^([a-f0-9]{64})-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(artifact.name.slice(prefix.length));
    if (!match || match[2]!==String(run.id) || Number(match[3])>run.runAttempt
        || run.displayTitle!=='Channels observe '+sha256(['observe',match[1],run.headSha]))return false;
    if (direct.includes(match[1]))return true;
    const report=artifact.report;
    if(!report || report.schemaVersion!==1 || report.sourceSha!==cycle.sourceSha || report.executionSha!==run.headSha
        || report.controllerSha!==cycle.controllerSha || report.nativeRunId!==run.id || report.runAttempt!==Number(match[3]) || report.cycleId!==cycle.id || report.targetsDigest!==match[1] || !Array.isArray(report.items)
        || !report.items.length || report.items.length>targets.length)return false;
    const subset=report.items.map(item=>targets.find(t=>t.unitId===item.unitId && t.channelId===item.channelId && t.version===item.version));
    return subset.every(Boolean) && new Set(subset).size===subset.length && keyFor(subset)===match[1];
  });
}

function publicationStarts(state,runId,attempt,sha) {
  return state.domainRecords.filter(r=>r.path.startsWith('evidence/publication/') && r.value.startEvidencePath===null
    && r.value.centralRun.id===runId && r.value.centralRun.runAttempt<=attempt && r.value.centralRun.headSha===sha);
}
export async function advanceEvent(event,{snapshot,get,centralGet,candidate,invoke,botId,producer,probeArtifacts,probeReport,probeWorkflow,registry=registrations}) {
  const product=registeredRepository(event,registry);
  const state=await cycleStage('LEDGER_READ',snapshot), cycles=state.cycles.map(record=>record.value);
  let cycleId=null;
  let probeReceipt=false;
  const execute=async(command,runId=null)=>invoke(command,cycleId,runId,!probeReceipt);
  if (event.kind==='push') {
    const head=(await cycleStage('SOURCE_READ',()=>get('git/ref/heads/'+encodeURIComponent(product.defaultBranch)))).object?.sha;
    if (!sha(head)) fail('CYCLE_EVENT_SOURCE');
    const prior=cycles.find(c=>c.sourceSha===event.sourceSha);
    if (prior?.freezeOnly && !githubUnits(prior).length) {
      cycleId=prior.id;
      return prior.freezeCompletedAt?{status:'FROZEN',reason:'NO_PUBLICATION_CHANNELS',cycleId}:{...await execute('observe-channel'),cycleId};
    }
    if (prior) {
      cycleId=prior.id;
      if (!prior.dispatches.some(d=>d.purpose==='build' && d.canonicalRunId!==null) && !prior.completedEvidencePath)
        return {...await execute('dispatch-build'),cycleId};
      return {...wait('MERGED_SOURCE_REGISTERED'),cycleId};
    }
    if (event.sourceSha!==head) {
      const number=state.repository?.candidate?.prNumber;
      if (!number) return wait('SUPERSEDED_PUSH');
      const pull=await cycleStage('SOURCE_READ',()=>get('pulls/'+number));
      if (!pull.merged || pull.merge_commit_sha!==event.sourceSha) return wait('SUPERSEDED_PUSH');
    }
    const reconcile=expectedState=>cycleStage('CANDIDATE',()=>candidate(head,expectedState));
    const result=await reconcile(state.head);
    if (result.status!=='CYCLE_READY') return result;
    cycleId=result.cycleId;
    const build=await execute('dispatch-build');
    if (head===event.sourceSha && result.sourceSha!==head) await reconcile((await cycleStage('LEDGER_READ',snapshot)).head);
    return {...build,cycleId};
  }
  const readRun=event.kind==='publication'?centralGet:get;
  const run=await cycleStage('SOURCE_READ',async()=>nativeRunFact(await readRun(`actions/runs/${event.runId}`)));
  if (run.id!==event.runId || run.runAttempt!==event.attempt || run.status!=='completed') fail('CYCLE_EVENT_RUN');
  if (event.kind==='publication') {
    if (run.repositoryId!==centralId || run.headRepositoryId!==centralId || run.actorId!==botId || run.headBranch!=='main'
      || run.event!=='workflow_dispatch' || run.path!=='.github/workflows/release-cycle-event.yml') fail('CYCLE_PUBLICATION_ORIGIN');
    if (run.conclusion!=='success') return wait('PUBLICATION_RECEIPT_UNSUCCESSFUL');
    const starts=publicationStarts(state,run.id,run.runAttempt,run.headSha);
    cycleId=only([...new Set(starts.map(r=>r.value.cycleId))]);
    // Reconciliation reads every original attempt/job and formal asset, then archives its proof.
    const prior=await execute('reconcile-publication');
    if(prior.status!=='OBSERVED')return {...prior,cycleId};
  } else if (run.displayTitle.startsWith('Channels observe ')) {
    const workflow=probeWorkflow?await cycleStage('SOURCE_READ',probeWorkflow):null;
    if(probeWorkflow&&(!Number.isSafeInteger(workflow?.id)||workflow.id<=0||workflow.state!=='active'||
       workflow.path!=='.github/workflows/steward-release-channels.yml'))fail('CYCLE_PROBE_ORIGIN');
    const probeProduct=workflow?{...product,channelWorkflowId:workflow.id}:product;
    if (!registeredProbe(run,botId,probeProduct)) fail('CYCLE_PROBE_ORIGIN');
    if (run.conclusion!=='success')return wait('PROBE_UNSUCCESSFUL');
    const artifacts=probeArtifacts?await cycleStage('SOURCE_READ',()=>probeArtifacts(run)):null;
    let candidates=cycles.filter(c=>probeMatches(c,run,botId,probeProduct,artifacts));
    if (!candidates.length && artifacts && probeReport) {
      for(const artifact of artifacts.filter(a=>a.expired===false && a.workflow_run?.id===run.id && a.workflow_run?.head_sha===run.headSha
        && typeof a.name==='string' && cycles.some(c=>a.name.startsWith('probe-'+c.id+'-')))) artifact.report=await cycleStage('SOURCE_READ',()=>probeReport(artifact));
      candidates=cycles.filter(c=>probeMatches(c,run,botId,probeProduct,artifacts));
    }
    if(!candidates.length && artifacts && !artifacts.some(artifact=>artifact.expired===false))return wait('PROBE_RECEIPT_UNCONFIRMED');
    cycleId=only(candidates).id;
    probeReceipt=true;

  } else {
    const {cycle,request}=only(cycles.flatMap(cycle=>cycle.dispatches.filter(d=>run.displayTitle===(d.purpose==='build'?'Build '+d.operationKey:'Channels '+d.inputs.mode+' '+d.requestKey)).map(request=>({cycle,request}))));
    verifyExecutionSource(run,{repositoryId:product.id,appBotId:botId,cycle,request});
    cycleId=cycle.id;
    if (!request.canonicalRunId) {
      await execute(request.purpose==='build'?'dispatch-build':'dispatch-channel');
      const bound=(await cycleStage('LEDGER_READ',snapshot)).cycles.find(c=>c.value.id===cycleId)?.value.dispatches.find(d=>d.requestKey===request.requestKey);
      if (bound?.canonicalRunId!==run.id) return {...wait('CANONICAL_RUN_UNCONFIRMED'),cycleId};
    }
    if (run.conclusion!=='success') return {...await execute('rerun',run.id),cycleId};
    if (request.purpose==='build') {
      if (producer?.attempt>1) {
        const starts=publicationStarts(state,producer.runId,producer.attempt-1,producer.controllerSha);
        if (starts.length) {
          if(starts.some(r=>r.value.cycleId!==cycleId))fail('CYCLE_PUBLICATION_ORIGIN');
          const prior=await execute('reconcile-publication');
          return {...prior,cycleId,publishInvoked:prior.status==='OBSERVED'};
        }
      }
      return {...await execute('publish'),cycleId};
    }
  }
  const observation=await execute('observe-channel');
  if(cycles.find(c=>c.id===cycleId)?.requiredChannels.length===0 || observation.reason==='DISTRIBUTION_VERIFIED')return {...observation,cycleId};
  const dispatch=await execute('dispatch-channel');
  return {...dispatch,cycleId};
}

export async function main(env=process.env) {
  if (env.BOUNDED_MODE!=='cycle' || env.BOUNDED_POLICY_SHA!==env.STEWARD_CONTROLLER_SHA) fail('CYCLE_POLICY');
  const config=JSON.parse(await readFile(new URL('../config/bounded-recheck.json',import.meta.url),'utf8'));
  const event=JSON.parse(env.BOUNDED_EVENT_JSON),requestKey=env.BOUNDED_REQUEST_KEY;
  const centralIo=nativeEvidenceTransport(env.STEWARD_CENTRAL_TOKEN),reader=new NativeEvidenceReader(centralIo,central);
  const centralGet=path=>reader.json(path);
  const run=await entryGuard(env,path=>centralGet(path.replace('/repos/'+central,'').replace(/^\//,'')),config);
  if ((await centralGet('git/ref/heads/steward/validated-controller')).object?.sha!==run.head_sha) fail('CYCLE_POLICY_UNPROMOTED');
  const app=await cycleStage('APP_AUTH',()=>nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY));
  if(run.actor?.id!==app.appBotId || run.display_title!=='Release cycle '+requestKey) fail('CYCLE_ACTOR');
  const root=await mkdtemp(join(tmpdir(),'steward-cycle-'));
  const producer={repositoryId:centralId,runId:run.id,attempt:run.run_attempt,controllerSha:run.head_sha};
  return withCycleCleanup(async()=>{
    const processProduct=product=>cycleStage('PRODUCT_ACCESS',async()=>{
      validateEvent(event,requestKey,[product]);
      const repository={id:product.id,full_name:product.name,default_branch:product.defaultBranch};
      return app.forRepository(product.id,async token=>{
        const io=nativeEvidenceTransport(token),productReader=new NativeEvidenceReader(io,product.name);
        const refresh=()=>cycleStage('LEDGER_READ',()=>fetchState(root,repository,token));
        const request=async(cycleId,runId)=>({directory:(await refresh()).directory,writeDirectory:await mkdtemp(join(root,'write-')),
          remote:'https://github.com/'+product.name+'.git',repository:product.name,repositoryId:product.id,defaultBranch:product.defaultBranch,appBotId:app.appBotId,cycleId,runId,identity});
        return cycleStage('EVENT_ROUTE',()=>advanceEvent(event,{registry:[product],snapshot:async()=>(await refresh()).snapshot,get:path=>productReader.json(path),probeArtifacts:run=>productReader.pages('actions/runs/'+run.id+'/artifacts','artifacts'),
          probeWorkflow:()=>productReader.json('actions/workflows/steward-release-channels.yml'),
          probeReport:async artifact=>{
            const directory=join(root,'probe-'+artifact.id);
            await downloadNativeArtifact({fullName:product.name,artifactId:artifact.id,digest:artifact.digest,names:['report.json'],
              directory,policyDirectory:process.cwd(),home:join(root,'download-'+artifact.id)},token);
            return JSON.parse(await readFile(join(directory,'report.json'),'utf8'));
          },centralGet,botId:app.appBotId,producer,
          candidate:(expectedSourceSha,expectedStateSha)=>app.forCandidateRepository(product.id,async(writer,candidateReadToken)=>
            releaseCommand('candidate',await request(null,null),{token:writer,io,centralIo,candidateReadToken,copilotToken:env.STEWARD_COPILOT_TOKEN,
              controllerSha:run.head_sha,controllerDirectory:process.cwd(),candidateRuntime:{expectedSourceSha,expectedStateSha}})),
          invoke:async(command,cycleId,runId,allowProbeDispatch)=>releaseCommand(command,await request(cycleId,runId),{token,io,centralIo,allowProbeDispatch,controllerDirectory:process.cwd(),
            centralInvocation:{runId:run.id,runAttempt:run.run_attempt,controllerSha:run.head_sha,defaultBranch:'main'}})}));
      });
    });
    const result=await cycleStage('PARTICIPATION',()=>withCycleEventProduct(app,event,processProduct));
    await cycleStage('RESULT_WRITE',()=>writeFile('result.json',JSON.stringify({schemaVersion:1,requestKey,producer,event,status:result.status,reason:result.reason??null,
      cycleId:result.cycleId??null,publishInvoked:result.publishInvoked===true})+'\n',{flag:'wx'}));
  },()=>rm(root,{recursive:true,force:true}));
}
const publicCodes=new Set([
  'CYCLE_ACTOR','CYCLE_EVENT_AMBIGUOUS','CYCLE_EVENT_ID','CYCLE_EVENT_KEY','CYCLE_EVENT_KIND',
  'CYCLE_EVENT_RUN','CYCLE_EVENT_SOURCE','CYCLE_POLICY','CYCLE_POLICY_UNPROMOTED',
  'CYCLE_PROBE_ORIGIN','CYCLE_PUBLICATION_ORIGIN','CYCLE_RECORD_RECONSTRUCTION_REQUIRED',
  'BOUNDED_RUN_SOURCE','CANDIDATE_REF_DRIFT','CANDIDATE_PR_HEAD_DRIFT','CANDIDATE_STATE_CONFLICT',
]);
const categories=new Set([
  'BOUNDED_REPOSITORY','CANDIDATE_NOT_ENABLED','NATIVE_HTTP_401','NATIVE_HTTP_403',
  'NATIVE_HTTP_404','NATIVE_HTTP_429','NATIVE_HTTP_500','NATIVE_HTTP_502','NATIVE_HTTP_503','NATIVE_HTTP_504',
]);

class CycleStageFailure extends Error {
  constructor(stage,error) {
    super(publicCodes.has(error?.message)?error.message:'CYCLE_EVENT_STOPPED');
    this.stage=stage;
    this.category=categories.has(error?.message)?error.message:'UNCLASSIFIED';
  }
}

async function cycleStage(stage,operation) {
  try { return await operation(); }
  catch(error) {
    if(error instanceof CycleStageFailure)throw error;
    throw new CycleStageFailure(stage,error);
  }
}

export async function withCycleCleanup(operation,cleanup) {
  let operationFailed=false;
  try { return await operation(); }
  catch(error) { operationFailed=true; throw error; }
  finally {
    try { await cycleStage('CLEANUP',cleanup); }
    catch(error) { if(!operationFailed)throw error; }
  }
}

export function publicCycleError(error) {
  if(error instanceof CycleStageFailure) {
    const category=error.message==='CYCLE_EVENT_STOPPED'?` category=${error.category}`:'';
    return `${error.message}\nstage=${error.stage}${category}`;
  }
  return publicCodes.has(error?.message)?error.message:'CYCLE_EVENT_STOPPED';
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
  cycleStage('ENTRY',()=>main()).catch(error=>{console.error(publicCycleError(error));process.exitCode=1;});
