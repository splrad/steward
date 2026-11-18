import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeEvidenceReader, nativeEvidenceTransport, nativeReleaseApp, nativeRunFact, verifyExecutionSource, channelTargetsDigest } from '../packages/runner/dist/index.js';
import { exact, product, sha, sha256 } from './bounded-candidate-contract.mjs';
import { entryGuard } from './bounded-release-entry.mjs';
import { fetchState } from './release-coordinator.mjs';
import { releaseCommand } from './release-record.mjs';

const centralId = 1296724484, central = 'splrad/steward';
const repository = {id:product.id, full_name:product.name, default_branch:'main'};
const identity = {name:'splrad-steward[bot]',email:'301115370+splrad-steward[bot]@users.noreply.github.com'};
const fail = reason => { throw Error(reason); };
const positive = n => Number.isSafeInteger(n) && n > 0;
export function validateEvent(event, requestKey) {
  const {repositoryId,kind} = event;
  if (!['push','run','publication'].includes(kind) || repositoryId !== (kind === 'publication' ? centralId : product.id)) fail('CYCLE_EVENT_KIND');
  const push = kind === 'push';
  exact(event, ['repositoryId','kind',...(push ? ['sourceSha'] : ['runId','attempt'])]);
  if (push ? !sha(event.sourceSha) : !positive(event.runId) || !positive(event.attempt)) fail('CYCLE_EVENT_ID');
  if (requestKey !== sha256([repositoryId,kind,...(push ? [event.sourceSha] : [event.runId,event.attempt])])) fail('CYCLE_EVENT_KEY');
}
const wait = reason => ({status:'WAIT',reason});
const only = items => items.length === 1 ? items[0] : fail('CYCLE_EVENT_AMBIGUOUS');
function probeMatches(cycle,run,botId) {
  if (run.repositoryId !== product.id || run.headRepositoryId !== product.id || run.actorId !== botId
    || run.event !== 'workflow_dispatch' || run.headBranch !== 'main' || run.workflowId !== 410998651
    || run.path !== '.github/workflows/steward-release-channels.yml' || !sha(run.headSha)) return false;
  const targets=cycle.requiredChannels.map(channel=>{
    const unit=cycle.units.find(u=>u.id===channel.unitId);
    return {...channel,version:unit.version,releaseId:unit.releaseId,manifestDigest:unit.manifestDigest};
  });
  if (!targets.length || targets.length>2 || targets.some(t=>!t.releaseId || !t.manifestDigest)) return false;
  // Direct reads can cover either channel; the remaining subset is observed in the native product job.
  return [targets,...targets.map(t=>[t])].some(subset=>{
    const digest=channelTargetsDigest({repositoryId:product.id,cycle},subset);
    return run.displayTitle==='Channels observe '+sha256(['observe',digest,run.headSha]);
  });
}

function publicationStarts(state,runId,attempt,sha) {
  return state.domainRecords.filter(r=>r.path.startsWith('evidence/publication/') && r.value.startEvidencePath===null
    && r.value.centralRun.id===runId && r.value.centralRun.runAttempt<=attempt && r.value.centralRun.headSha===sha);
}
export async function advanceEvent(event,{snapshot,get,centralGet,candidate,invoke,botId,producer}) {
  const state=await snapshot(), cycles=state.cycles.map(record=>record.value);
  let cycleId=null;
  let probeReceipt=false;
  const execute=async(command,runId=null)=>invoke(command,cycleId,runId,!probeReceipt);
  if (event.kind==='push') {
    const head=(await get('git/ref/heads/main')).object?.sha;
    if (!sha(head)) fail('CYCLE_EVENT_SOURCE');
    const prior=cycles.find(c=>c.sourceSha===event.sourceSha);
    if (prior) {
      cycleId=prior.id;
      if (!prior.dispatches.some(d=>d.purpose==='build' && d.canonicalRunId!==null) && !prior.completedEvidencePath)
        return {...await execute('dispatch-build'),cycleId};
      return {...wait('MERGED_SOURCE_REGISTERED'),cycleId};
    }
    if (event.sourceSha!==head) {
      const number=state.repository?.candidate?.prNumber;
      if (!number) return wait('SUPERSEDED_PUSH');
      const pull=await get('pulls/'+number);
      if (!pull.merged || pull.merge_commit_sha!==event.sourceSha) return wait('SUPERSEDED_PUSH');
    }
    const result=await candidate(head,state.head);
    if (result.status!=='CYCLE_READY') return result;
    cycleId=result.cycleId;
    const build=await execute('dispatch-build');
    if (head===event.sourceSha && result.sourceSha!==head) await candidate(head,(await snapshot()).head);
    return {...build,cycleId};
  }
  const run=nativeRunFact(await (event.kind==='publication'?centralGet:get)(`actions/runs/${event.runId}`));
  if (run.id!==event.runId || run.runAttempt!==event.attempt || run.status!=='completed') fail('CYCLE_EVENT_RUN');
  if (event.kind==='publication') {
    if (run.repositoryId!==centralId || run.headRepositoryId!==centralId || run.actorId!==botId || run.headBranch!=='main'
      || run.event!=='workflow_dispatch' || run.path!=='.github/workflows/release-cycle-event.yml') fail('CYCLE_PUBLICATION_ORIGIN');
    const starts=publicationStarts(state,run.id,run.runAttempt,run.headSha);
    cycleId=only([...new Set(starts.map(r=>r.value.cycleId))]);
    // Reconciliation reads every original attempt/job and formal asset, then archives its proof.
    const prior=await execute('reconcile-publication');
    if(prior.status!=='OBSERVED')return {...prior,cycleId};
  } else if (run.displayTitle.startsWith('Channels observe ')) {
    cycleId=only(cycles.filter(c=>probeMatches(c,run,botId))).id;
    probeReceipt=true;
    if(run.conclusion!=='success')return {...wait('PROBE_UNSUCCESSFUL'),cycleId};
  } else {
    const {cycle,request}=only(cycles.flatMap(cycle=>cycle.dispatches.filter(d=>run.displayTitle===(d.purpose==='build'?'Build '+d.operationKey:'Channels '+d.inputs.mode+' '+d.requestKey)).map(request=>({cycle,request}))));
    verifyExecutionSource(run,{repositoryId:product.id,appBotId:botId,cycle,request});
    cycleId=cycle.id;
    if (!request.canonicalRunId) {
      await execute(request.purpose==='build'?'dispatch-build':'dispatch-channel');
      const bound=(await snapshot()).cycles.find(c=>c.value.id===cycleId)?.value.dispatches.find(d=>d.requestKey===request.requestKey);
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
  if(observation.reason==='DISTRIBUTION_VERIFIED')return {...observation,cycleId};
  const dispatch=await execute('dispatch-channel');
  return {...dispatch,cycleId};
}

export async function main(env=process.env) {
  if (env.BOUNDED_MODE!=='cycle' || env.BOUNDED_POLICY_SHA!==env.STEWARD_CONTROLLER_SHA) fail('CYCLE_POLICY');
  const config=JSON.parse(await readFile(new URL('../config/bounded-recheck.json',import.meta.url),'utf8'));
  const event=JSON.parse(env.BOUNDED_EVENT_JSON),requestKey=env.BOUNDED_REQUEST_KEY;
  validateEvent(event,requestKey);
  const centralIo=nativeEvidenceTransport(env.STEWARD_CENTRAL_TOKEN),reader=new NativeEvidenceReader(centralIo,central);
  const centralGet=path=>reader.json(path);
  const run=await entryGuard(env,path=>centralGet(path.replace('/repos/'+central,'').replace(/^\//,'')),config);
  if ((await centralGet('git/ref/heads/steward/validated-controller')).object?.sha!==run.head_sha) fail('CYCLE_POLICY_UNPROMOTED');
  const app=await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY);
  if(run.actor?.id!==app.appBotId || run.display_title!=='Release cycle '+requestKey) fail('CYCLE_ACTOR');
  const root=await mkdtemp(join(tmpdir(),'steward-cycle-'));
  const producer={repositoryId:centralId,runId:run.id,attempt:run.run_attempt,controllerSha:run.head_sha};
  try {
    const result=await app.forRepository(product.id,async token=>{
      const io=nativeEvidenceTransport(token),productReader=new NativeEvidenceReader(io,product.name);
      const refresh=()=>fetchState(root,repository,token);
      const request=async(cycleId,runId)=>({directory:(await refresh()).directory,writeDirectory:await mkdtemp(join(root,'write-')),
        remote:'https://github.com/'+product.name+'.git',repository:product.name,repositoryId:product.id,defaultBranch:'main',appBotId:app.appBotId,cycleId,runId,identity});
      return advanceEvent(event,{snapshot:async()=>(await refresh()).snapshot,get:path=>productReader.json(path),centralGet,botId:app.appBotId,producer,
        candidate:(expectedSourceSha,expectedStateSha)=>app.forCandidateRepository(product.id,async(writer,candidateReadToken)=>
          releaseCommand('candidate',await request(null,null),{token:writer,io,centralIo,candidateReadToken,copilotToken:env.STEWARD_COPILOT_TOKEN,
            controllerSha:run.head_sha,controllerDirectory:process.cwd(),candidateRuntime:{expectedSourceSha,expectedStateSha}})),
        invoke:async(command,cycleId,runId,allowProbeDispatch)=>releaseCommand(command,await request(cycleId,runId),{token,io,centralIo,allowProbeDispatch,controllerDirectory:process.cwd(),
          centralInvocation:{runId:run.id,runAttempt:run.run_attempt,controllerSha:run.head_sha,defaultBranch:'main'}})});
    });
    await writeFile('result.json',JSON.stringify({schemaVersion:1,requestKey,producer,event,status:result.status,reason:result.reason??null,
      cycleId:result.cycleId??null,publishInvoked:result.publishInvoked===true})+'\n',{flag:'wx'});
  } finally {await rm(root,{recursive:true,force:true});}
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error(/^CYCLE_[A-Z_]+$/.test(error.message)?error.message:'CYCLE_EVENT_STOPPED');process.exitCode=1;});
