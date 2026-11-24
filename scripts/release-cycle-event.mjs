import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeEvidenceReader, nativeEvidenceTransport, nativeReleaseApp, nativeGhCommand, nativeRunFact, verifyExecutionSource, githubUnits, channelTargetsDigest, downloadNativeArtifact, expandWorkflowArtifactArchive, defaultBuildWorkflow } from '../packages/runner/dist/index.js';
import { exact, sha, sha256, withParticipatingProduct } from './bounded-candidate-contract.mjs';
import { entryGuard } from './bounded-release-entry.mjs';
import {assertReleaseUnpaused} from './release-pause-policy.mjs';
import { fetchState } from './release-coordinator.mjs';
import { registerOfficialMergedCycle, releaseCommand } from './release-record.mjs';
import { finishOfficialAction, readOfficialBody } from './official-release.mjs';

const centralId = 1296724484, central = 'splrad/steward';
const eventKinds=['push','run','publication','official-merge'];
const registrations=JSON.parse(await readFile(new URL('../config/release/event-repositories.json',import.meta.url),'utf8'));
const eventProductId=event=>event.kind==='publication'?event.productRepositoryId:event.repositoryId;
function registeredRepository(event, registry=registrations) {
  const id=eventProductId(event);
  if(!positive(id))fail('CYCLE_EVENT_KIND');
  const matches=registry.filter(repository=>repository.id===id);
  if(matches.length!==1)fail('CYCLE_EVENT_KIND');
  return matches[0];
}
export function withCycleEventProduct(app,event,operation,transport=nativeEvidenceTransport) {
  const id=eventProductId(event);
  if(!eventKinds.includes(event.kind)||!positive(id))fail('CYCLE_EVENT_KIND');
  return withParticipatingProduct(app,id,operation,transport);
}
const identity = {name:'splrad-steward[bot]',email:'301115370+splrad-steward[bot]@users.noreply.github.com'};
const fail = reason => { throw Error(reason); };
const positive = n => Number.isSafeInteger(n) && n > 0;
export function validateEvent(event, requestKey, registry=registrations) {
  const {repositoryId,kind} = event;
  const product=registeredRepository(event,registry);
  if (!eventKinds.includes(kind) || repositoryId !== (kind === 'publication' ? centralId : product.id)) fail('CYCLE_EVENT_KIND');
  if (kind==='official-merge') {
    exact(event,['repositoryId','kind','prNumber','head','sourceSha','mergedAt','title','body']);
    if (!positive(event.prNumber)||!sha(event.head)||!sha(event.sourceSha)||!Number.isFinite(Date.parse(event.mergedAt))
      || typeof event.title!=='string'||typeof event.body!=='string') fail('CYCLE_EVENT_ID');
    if (requestKey!==sha256([repositoryId,kind,event.prNumber,event.sourceSha,event.head])) fail('CYCLE_EVENT_KEY');
    return;
  }
  const push = kind === 'push';
  const publication = kind==='publication';
  exact(event, ['repositoryId','kind',...(push ? ['sourceSha'] : ['runId','attempt']),...(publication?['productRepositoryId']:[])]);
  if (push ? !sha(event.sourceSha) : !positive(event.runId) || !positive(event.attempt)) fail('CYCLE_EVENT_ID');
  if (requestKey !== sha256([repositoryId,kind,...(push ? [event.sourceSha] : [event.runId,event.attempt]),...(publication?[event.productRepositoryId]:[])])) fail('CYCLE_EVENT_KEY');
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
export async function advanceEvent(event,{snapshot,get,centralGet,invoke,botId,producer,probeArtifacts,probeReport,probeWorkflow,officialStage,officialMerge,selectedDelivery,registry=registrations}) {
  const product=registeredRepository(event,registry);
  if (officialStage && event.kind!=='run') return wait('OFFICIAL_RELEASE_BUILD_EVENT_REQUIRED');
  if (event.kind==='official-merge') {
    if (!officialMerge) return wait('OFFICIAL_RELEASE_DISABLED');
    const result=await cycleStage('OFFICIAL_MERGE',()=>officialMerge(event));
    if (result.status!=='CYCLE_READY') return result;
    return {...await invoke('dispatch-build',result.cycleId,null,true),cycleId:result.cycleId};
  }
  const state=await cycleStage('LEDGER_READ',snapshot), cycles=state.cycles.map(record=>record.value);
  let cycleId=null;
  let probeReceipt=false;
  const execute=async(command,runId=null,recoverDispatchOnly=false)=>
    recoverDispatchOnly ? invoke(command,cycleId,runId,!probeReceipt,true) : invoke(command,cycleId,runId,!probeReceipt);
  if (event.kind==='push') {
    const head=(await cycleStage('SOURCE_READ',()=>get('git/ref/heads/'+encodeURIComponent(product.defaultBranch)))).object?.sha;
    if (!sha(head)) fail('CYCLE_EVENT_SOURCE');
    const prior=cycles.find(c=>c.sourceSha===event.sourceSha);
    if ((prior?.freezeOnly||prior?.freezeCompletedAt) && !prior.requiredChannels?.length && !githubUnits(prior).length) {
      cycleId=prior.id;
      return prior.freezeCompletedAt?{status:'FROZEN',reason:'NO_PUBLICATION_CHANNELS',cycleId}:{...await execute('observe-channel'),cycleId};
    }
    if (prior) {
      cycleId=prior.id;
      if (!prior.dispatches.some(d=>d.purpose==='build' && d.canonicalRunId!==null) && !prior.completedEvidencePath)
        return {...await execute('dispatch-build'),cycleId};
      return {...wait('MERGED_SOURCE_REGISTERED'),cycleId};
    }
    return wait(event.sourceSha===head?'OFFICIAL_MERGE_REQUIRED':'SUPERSEDED_PUSH');
  }
  const readRun=event.kind==='publication'?centralGet:get;
  const buildCycle=event.kind==='run'&&cycles.find(cycle=>cycle.officialRelease
    &&cycle.dispatches.some(request=>request.purpose==='build'&&request.canonicalRunId===event.runId));
  const readyCycle=buildCycle&&state.domainRecords?.some(record=>record.path===`official/draft/${buildCycle.id}.json`&&record.value.readyAt)
    ?buildCycle:null;
  const retainedDelivery=buildCycle?.units?.[0]?.githubDelivery;
  const retainedCallback=retainedDelivery?.runId===event.runId
    && (retainedDelivery?.buildAttempt??retainedDelivery?.attempt)===event.attempt;
  const selectedCallback=event.kind==='run'&&selectedDelivery?.repository===product.name
    &&selectedDelivery.runId===event.runId&&selectedDelivery.callbackAttempt===event.attempt;
  const run=await cycleStage('SOURCE_READ',async()=>{
    const path=`actions/runs/${event.runId}`;
    const latest=nativeRunFact(await readRun(path));
    return (readyCycle||retainedCallback||selectedCallback)&&latest.runAttempt!==event.attempt
      ?nativeRunFact(await readRun(`${path}/attempts/${event.attempt}`)):latest;
  });
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
  } else if (run.path==='.github/workflows/steward-release-channels.yml'&&run.displayTitle.startsWith('Channels observe ')) {
    if (officialStage) return wait('OFFICIAL_RELEASE_BUILD_EVENT_REQUIRED');
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
    const {cycle,request}=only(cycles.flatMap(cycle=>cycle.dispatches.filter(d=>d.purpose==='build'
      ? d.buildWorkflow===undefined ? run.displayTitle==='Build '+d.operationKey
        : run.path===d.buildWorkflow&&run.workflowId===d.workflowId&&run.displayTitle.includes(d.operationKey)
      : run.displayTitle==='Channels '+d.inputs.mode+' '+d.requestKey).map(request=>({cycle,request}))));
    verifyExecutionSource(run,{repositoryId:product.id,appBotId:botId,cycle,request});
    cycleId=cycle.id;
    if(cycle===readyCycle&&request.purpose==='build') return {...await execute('publish'),cycleId};
    if (officialStage) {
      if (!cycle.officialRelease || request.purpose!=='build' || run.conclusion!=='success') return wait('OFFICIAL_RELEASE_BUILD_EVENT_REQUIRED');
    }
    if (!request.canonicalRunId) {
      await execute(request.purpose==='build'?'dispatch-build':'dispatch-channel',null,
        Boolean(cycle.officialRelease && request.purpose==='build'));
      const bound=(await cycleStage('LEDGER_READ',snapshot)).cycles.find(c=>c.value.id===cycleId)?.value.dispatches.find(d=>d.requestKey===request.requestKey);
      if (bound?.canonicalRunId!==run.id) return {...wait('CANONICAL_RUN_UNCONFIRMED'),cycleId};
    }
    if (run.conclusion!=='success') return {...await execute('rerun',run.id),cycleId};
    if (request.purpose==='build') {
      if (producer?.attempt>1 && !cycle.officialRelease) {
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
  const officialStage=env.OFFICIAL_RELEASE_PHASE;
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
      const officialEnabled=env.OFFICIAL_RELEASE_ENABLED==='true';
      if (officialStage && !officialEnabled) fail('OFFICIAL_RELEASE_DISABLED');
      return app.forRepository(product.id,async token=>{
        const io=nativeEvidenceTransport(token),productReader=new NativeEvidenceReader(io,product.name);
        const refresh=()=>cycleStage('LEDGER_READ',()=>fetchState(root,repository,token));
        const admit=()=>assertReleaseUnpaused(app,product.id);
        const request=async(cycleId,runId,state)=>({directory:(state??await refresh()).directory,writeDirectory:await mkdtemp(join(root,'write-')),
          remote:'https://github.com/'+product.name+'.git',repository:product.name,repositoryId:product.id,defaultBranch:product.defaultBranch,appBotId:app.appBotId,cycleId,runId,identity});
        const selectedDelivery=event.kind==='run'&&officialStage!=='select'
          ?await readFile('official-release-delivery.json','utf8').then(JSON.parse,error=>{
            if(error.code==='ENOENT')return null;
            throw error;
          }):null;
        const official={enabled:officialEnabled,stage:officialStage,attempt:event.attempt,admit,selectedDelivery,ready:Boolean(env.OFFICIAL_RELEASE_TOKEN),
          readBody:approval=>app.forCandidateReadRepository(product.id,readToken=>readOfficialBody(approval,readToken)),
          download:async input=>{
            const selected=selectedDelivery;
            const archiveDir=env.OFFICIAL_RELEASE_ARCHIVE_DIR;
            if(!archiveDir||!selected||selected.repository!==input.fullName||selected.artifactId!==input.artifactId||selected.digest!==input.digest)
              fail('OFFICIAL_RELEASE_ARCHIVE_IDENTITY');
            const files=await readdir(archiveDir,{withFileTypes:true});
            if(files.length!==1||!files[0].isFile()) fail('OFFICIAL_RELEASE_ARCHIVE_IDENTITY');
            await expandWorkflowArtifactArchive(input,join(archiveDir,files[0].name));
          },
          preparation:async cycleId=>{
            let previous;
            try {previous=JSON.parse(await readFile('official-release-preparation.json','utf8'));}
            catch(error) {if(error.code==='ENOENT')return wait('OFFICIAL_RELEASE_PREFLIGHT_REQUIRED');throw error;}
            return previous.cycleId===cycleId?previous:wait('OFFICIAL_RELEASE_PREFLIGHT_REQUIRED');
          },
          confirm:async approval=>{
            if (!env.OFFICIAL_RELEASE_TOKEN) fail('OFFICIAL_RELEASE_PREFLIGHT_REQUIRED');
            const prior=JSON.parse(await readFile('official-release-preflight.json','utf8'));
            if (JSON.stringify(prior.approval)!==JSON.stringify(approval)) fail('OFFICIAL_RELEASE_APPROVAL_DRIFT');
            return finishOfficialAction(approval,env.OFFICIAL_RELEASE_TOKEN,prior.facts,{
              id:env.OFFICIAL_RELEASE_ACTION_ID,tag:env.OFFICIAL_RELEASE_ACTION_TAG,sha:env.OFFICIAL_RELEASE_ACTION_SHA});
          }};
        const officialMerge=officialEnabled?async event=>app.forCandidateReadRepository(product.id,async readToken=>{
          const state=await refresh();
          const existing=state.snapshot.cycles.find(record=>record.value.id===`pr-${event.prNumber}-${event.sourceSha}`)?.value;
          if(existing) {
            if(existing.officialRelease?.headSha!==event.head||existing.officialRelease?.pullBodyDigest!==sha256(event.body))
              fail('OFFICIAL_RELEASE_MERGE_RECEIPT_CONFLICT');
            return {status:'CYCLE_READY',cycleId:existing.id};
          }
          const {verifyOfficialMerge,readSourceFile,configPath,deliveryPath}=await import('./official-release-candidate.mjs');
          const read=new NativeEvidenceReader(nativeEvidenceTransport(readToken),product.name);
          const get=async path=>/^compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}\?per_page=1$/.test(path)
            ? JSON.parse(await nativeGhCommand(['api',`repos/${product.name}/${path}`],readToken)) : read.json(path);
          const receipt=await verifyOfficialMerge(event,product,get,app.appBotId);
          const [config,delivery]=await Promise.all([readSourceFile(get,configPath,receipt.sourceSha),readSourceFile(get,deliveryPath,receipt.sourceSha)]);
          const buildWorkflow=JSON.parse(delivery.toString('utf8')).buildWorkflow??defaultBuildWorkflow;
          const workflow=await readSourceFile(get,buildWorkflow,receipt.sourceSha);
          return registerOfficialMergedCycle(await request(null,null,state),state.snapshot,receipt,
            {config,delivery,workflow,controllerSha:run.head_sha,token,io,readBytes:state.readBytes,admit});
        }):undefined;
        return cycleStage('EVENT_ROUTE',()=>advanceEvent(event,{registry:[product],
          officialStage,officialMerge,selectedDelivery,
          snapshot:async()=>(await refresh()).snapshot,get:path=>productReader.json(path),probeArtifacts:run=>productReader.pages('actions/runs/'+run.id+'/artifacts','artifacts'),
          probeWorkflow:()=>productReader.json('actions/workflows/steward-release-channels.yml'),
          probeReport:async artifact=>{
            const directory=join(root,'probe-'+artifact.id);
            await downloadNativeArtifact({fullName:product.name,artifactId:artifact.id,digest:artifact.digest,names:['report.json'],
              directory,policyDirectory:process.cwd(),home:join(root,'download-'+artifact.id)},token);
            return JSON.parse(await readFile(join(directory,'report.json'),'utf8'));
          },centralGet,botId:app.appBotId,producer,
          invoke:async(command,cycleId,runId,allowProbeDispatch,recoverDispatchOnly)=>releaseCommand(command,await request(cycleId,runId),{token,io,centralIo,allowProbeDispatch,controllerDirectory:process.cwd(),official,recoverDispatchOnly,
            centralInvocation:{runId:run.id,runAttempt:run.run_attempt,controllerSha:run.head_sha,defaultBranch:'main'}})}));
      });
    });
    const result=await cycleStage('PARTICIPATION',()=>withCycleEventProduct(app,event,processProduct));
    if(officialStage==='select') {
      const {officialDelivery}=result;
      if(officialDelivery) {
        const [owner,repo]=officialDelivery.repository.split('/');
        await writeFile('official-release-delivery.json',JSON.stringify({...officialDelivery,callbackAttempt:event.attempt})+'\n',{flag:'wx'});
        await appendFile(env.GITHUB_OUTPUT,`selected=true\nowner=${owner}\nrepo=${repo}\nrepository=${officialDelivery.repository}\nrun_id=${officialDelivery.runId}\nartifact_id=${officialDelivery.artifactId}\n`);
      }
      return;
    }
    if (officialStage==='prepare') {
      const {officialPlan,...summary}=result;
      await writeFile('official-release-preparation.json',JSON.stringify(summary)+'\n',{flag:'wx'});
      if (officialPlan) {
        const [owner,repo]=officialPlan.approval.repository.split('/');
        await writeFile('official-release-plan.json',JSON.stringify(officialPlan)+'\n',{flag:'wx'});
        await appendFile(env.GITHUB_OUTPUT,`ready=true\nowner=${owner}\nrepo=${repo}\ntarget_branch=${officialPlan.approval.defaultBranch}\n`);
      }
      return;
    }
    await cycleStage('RESULT_WRITE',async()=>{
      await writeFile('result.json',JSON.stringify({schemaVersion:1,requestKey,producer,event,status:result.status,reason:result.reason??null,
        cycleId:result.cycleId??null,publishInvoked:result.publishInvoked===true,...(result.draft?{draft:result.draft}:{})})+'\n',{flag:'wx'});
      if(result.status==='DRAFT_READY'&&env.GITHUB_STEP_SUMMARY) {
        const {url,tag,sourceSha,runId,attempt,releaseId,assets}=result.draft;
        await appendFile(env.GITHUB_STEP_SUMMARY,[
          '## 发行草稿和附件就绪','',`[${tag} 草稿](${url}) · Release ID ${releaseId}`,
          '',`合并提交 \`${sourceSha}\` · [产品构建](${url.split('/releases/')[0]}/actions/runs/${runId}/attempts/${attempt})`,
          '',...assets.map(({name,assetId})=>`- \`${name}\` · Asset ID ${assetId}`),'',
        ].join('\n'));
      }
    });
  },()=>rm(root,{recursive:true,force:true}));
}
const publicCodes=new Set([
  'CYCLE_ACTOR','CYCLE_EVENT_AMBIGUOUS','CYCLE_EVENT_ID','CYCLE_EVENT_KEY','CYCLE_EVENT_KIND',
  'CYCLE_EVENT_RUN','CYCLE_EVENT_SOURCE','CYCLE_POLICY','CYCLE_POLICY_UNPROMOTED',
  'CYCLE_PROBE_ORIGIN','CYCLE_PUBLICATION_ORIGIN','CYCLE_RECORD_RECONSTRUCTION_REQUIRED',
  'RELEASE_REPOSITORY_PAUSED','RELEASE_PAUSE_POLICY_UNAVAILABLE',
  'BOUNDED_RUN_SOURCE',
]);
const categories=new Set([
  'BOUNDED_REPOSITORY','CANDIDATE_NOT_ENABLED','NATIVE_HTTP_401','NATIVE_HTTP_403',
  'NATIVE_HTTP_404','NATIVE_HTTP_429','NATIVE_HTTP_500','NATIVE_HTTP_502','NATIVE_HTTP_503','NATIVE_HTTP_504',
]);
const isPublicCode=code=>publicCodes.has(code)||/^OFFICIAL_(?:RELEASE|CANDIDATE)_[A-Z_]+$/.test(code);
const draftErrorCodes=new Map([
  ['ARTIFACT_DOWNLOAD_IDENTITY','OFFICIAL_RELEASE_ARCHIVE_IDENTITY'],
  ['GH_RELEASE: retained draft asset ID changed','OFFICIAL_RELEASE_ASSET_ID_CHANGED'],
  ['GH_RELEASE: unexpected draft asset','OFFICIAL_RELEASE_ASSET_SET_CHANGED'],
  ['GH_RELEASE: unproven starter asset','OFFICIAL_RELEASE_ASSET_STARTER_UNPROVEN'],
  ['GH_RELEASE: same-name different bytes','OFFICIAL_RELEASE_ASSET_BYTES_CHANGED'],
  ['GH_RELEASE: downloaded bytes mismatch','OFFICIAL_RELEASE_ASSET_BYTES_CHANGED'],
  ['GH_RELEASE: draft asset set','OFFICIAL_RELEASE_ASSET_SET_INCOMPLETE'],
  ['GH_RELEASE: official draft differs from approval','OFFICIAL_RELEASE_DRAFT_IDENTITY'],
  ['GH_RELEASE: upload response identity','OFFICIAL_RELEASE_ASSET_UPLOAD_UNCONFIRMED'],
  ['GH_RELEASE: upload not observed','OFFICIAL_RELEASE_ASSET_UPLOAD_UNCONFIRMED'],
]);

class CycleStageFailure extends Error {
  constructor(stage,error) {
    const reason=draftErrorCodes.get(error?.message);
    super(reason??(isPublicCode(error?.message)?error.message:'CYCLE_EVENT_STOPPED'));
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
  return isPublicCode(error?.message)?error.message:'CYCLE_EVENT_STOPPED';
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
  cycleStage('ENTRY',()=>main()).catch(error=>{console.error(publicCycleError(error));process.exitCode=1;});
