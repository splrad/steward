import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {nativeReleaseApp,NativeEvidenceReader,nativeEvidenceTransport} from '../packages/runner/dist/index.js';
import {entryGuard} from './bounded-release-entry.mjs';
import {candidateEvidence,validateNormalCandidateEvent,key,withCandidateProduct,product as legacyProduct} from './bounded-candidate-contract.mjs';
import {fetchState} from './release-coordinator.mjs';
import {nativeReleaseCandidate} from './release-candidate.mjs';
import {releasePolicyGuard} from './release-repository-policy.mjs';
import {assertReleaseUnpaused} from './release-pause-policy.mjs';
const central='splrad/steward',centralId=1296724484;
const botIdentity={name:'splrad-steward[bot]',email:'301115370+splrad-steward[bot]@users.noreply.github.com'};
const fail=code=>{throw Error(code);};
/** Only this event-bound port may execute ordinary candidate work; no cycle service is exposed. */
export async function processNormalCandidateEvent({hint,sourceSha,requestKey,producer},{get,invoke,product=legacyProduct}) {
  if(!key(requestKey))fail('CANDIDATE_EVENT_KEY');
  const before=await validateNormalCandidateEvent(hint,sourceSha,get,product);
  const result=await invoke({before,sourceSha});
  const after=await candidateEvidence(get,{requireReady:false,product});
  if(after.state.candidate.id!==before.state.candidate.id||after.pull.number!==before.pull.number)fail('CANDIDATE_EVENT_OWNER_CHANGED');
  if((await get(`/repos/${product.name}/git/ref/heads/${encodeURIComponent(product.defaultBranch)}`)).object?.sha!==sourceSha)fail('CANDIDATE_EVENT_SOURCE_CHANGED');
  if(!Array.isArray(after.pull.labels))fail('CANDIDATE_LABELS_UNKNOWN');
  const resultHead=result.head??(result.status==='CONFLICT'?after.session.conflict?.head:null);
  if(resultHead&&resultHead!==after.pull.head.sha||result.status==='READY'&&!resultHead)fail('CANDIDATE_EVENT_HEAD_MOVED');
  const outcome=after.pull.state!=='open'||after.pull.merged?'needs_attention':
    after.pull.labels.some(label=>label.name==='release:editing')||result.reason==='EDITING'?'paused':result.reason==='HUMAN_EDIT_CONFLICT'?'protected':
    result.reason==='MANUAL_VALIDATED'&&after.session.manualValidation&&after.identity?.sourceSha===sourceSha?'manual_validated':
    result.status==='READY'&&after.identity?.sourceSha===sourceSha?'candidate_updated':'needs_attention';
  return {schemaVersion:1,requestKey,producer,event:hint,sourceSha,status:result.status,reason:result.reason??null,outcome,
    stateBefore:before.evidence,stateAfter:after.evidence,candidateIdentity:after.identity};
}
export async function main(env=process.env) {
  if(env.BOUNDED_MODE!=='normal'||env.BOUNDED_POLICY_SHA!==env.STEWARD_CONTROLLER_SHA)fail('CANDIDATE_EVENT_POLICY');
  const config=JSON.parse(await readFile(new URL('../config/bounded-recheck.json',import.meta.url),'utf8'));
  const centralReader=new NativeEvidenceReader(nativeEvidenceTransport(env.STEWARD_CENTRAL_TOKEN),central);
  const run=await entryGuard(env,path=>centralReader.json(path===`/repos/${central}`?'':path.replace(`/repos/${central}/`,'')),config);
  const app=await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY??'');
  if(run.actor?.id!==app.appBotId)fail('CANDIDATE_EVENT_ACTOR');
  const hint=JSON.parse(env.BOUNDED_EVENT_JSON??'null');
  const root=await mkdtemp(join(tmpdir(),'steward-candidate-event-'));
  try {return await withCandidateProduct(app,hint?.repositoryId,async(product,token,readToken)=>{
    const reader=new NativeEvidenceReader(nativeEvidenceTransport(token),product.name);
    const get=path=>reader.json(path===`/repos/${product.name}`?'':path.replace(`/repos/${product.name}/`,''));
    const result=await processNormalCandidateEvent({hint:JSON.parse(env.BOUNDED_EVENT_JSON??'null'),sourceSha:env.BOUNDED_SOURCE_SHA,
      requestKey:env.BOUNDED_REQUEST_KEY,producer:{repositoryId:centralId,runId:run.id,attempt:run.run_attempt,controllerSha:env.STEWARD_CONTROLLER_SHA}},
    {get,product,invoke:async({before,sourceSha})=>{
      const repository={id:product.id,full_name:product.name,default_branch:product.defaultBranch},state=await fetchState(root,repository,token);
      if(state.snapshot.head!==before.evidence.stateCommit)fail('CANDIDATE_EVENT_STATE_MOVED');
      await assertReleaseUnpaused(app,product.id);
      return nativeReleaseCandidate({directory:state.directory,writeDirectory:join(root,'writes'),remote:state.remote,repository:product.name,
        repositoryId:product.id,defaultBranch:product.defaultBranch,appBotId:app.appBotId,identity:botIdentity},{token,readToken,
        copilotToken:env.STEWARD_COPILOT_TOKEN,controllerSha:env.STEWARD_CONTROLLER_SHA,expectedStateSha:before.evidence.stateCommit,expectedSourceSha:sourceSha,
        checkRepositoryPolicy:releasePolicyGuard(app,repository),
        reselectUnits:before.selectionChanged,manualCandidateProducer:{repositoryId:centralId,runId:run.id,attempt:run.run_attempt,controllerSha:env.STEWARD_CONTROLLER_SHA,requestKey:env.BOUNDED_REQUEST_KEY}});
    }});
    await writeFile('result.json',JSON.stringify(result)+'\n',{flag:'wx'});return result;
  });}finally {await rm(root,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{
  const code=error?.message;
  const reason=['RELEASE_REPOSITORY_PAUSED','RELEASE_PAUSE_POLICY_UNAVAILABLE'].includes(code)?code:'CANDIDATE_EVENT_STOPPED';
  process.stderr.write(reason+'\n');
  process.exitCode=1;
});
