import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeReleaseApp, NativeEvidenceReader, nativeEvidenceTransport } from '../packages/runner/dist/index.js';
import { fetchState } from './release-coordinator.mjs';
import { nativeReleaseCandidate } from './release-candidate.mjs';
import {releasePolicyGuard} from './release-repository-policy.mjs';
import {assertReleaseUnpaused} from './release-pause-policy.mjs';
import { candidateEvidence, validateCandidateEvent, sameIdentity, sha, key, withCandidateProduct } from './bounded-candidate-contract.mjs';
const central='splrad/steward',centralId=1296724484;
const botIdentity={name:'splrad-steward[bot]',email:'301115370+splrad-steward[bot]@users.noreply.github.com'};
const fail=reason=>{throw Error(reason);};
export async function entryGuard(env,get,config) {
  if(config.enabled!==true||!sha(config.deploymentSha))fail('BOUNDED_NOT_CONNECTED');
  if(env.GITHUB_REPOSITORY!==central||env.GITHUB_REPOSITORY_ID!==String(centralId)||env.GITHUB_REF!=='refs/heads/main'
    ||!sha(env.STEWARD_CONTROLLER_SHA))fail('BOUNDED_ENTRY_SOURCE');
  const workflow={cycle:'.github/workflows/release-cycle-event.yml',pages:'.github/workflows/pages-maintenance-event.yml',observe:'.github/workflows/release-observe.yml',event:'.github/workflows/bounded-release-event.yml',normal:'.github/workflows/release-candidate-event.yml'}[env.BOUNDED_MODE];
  if(!workflow)fail('BOUNDED_MODE');
  const repo=await get(`/repos/${central}`),head=await get(`/repos/${central}/git/ref/heads/main`);
  const run=await get(`/repos/${central}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`);
  if(repo.id!==centralId||repo.default_branch!=='main'||head.object?.sha!==env.STEWARD_CONTROLLER_SHA||repo.archived||repo.disabled
    ||run.id!==Number(env.GITHUB_RUN_ID)||run.run_attempt!==Number(env.GITHUB_RUN_ATTEMPT)||run.repository?.id!==centralId||run.head_repository?.id!==centralId
    ||run.path!==workflow||run.head_sha!==env.STEWARD_CONTROLLER_SHA||run.head_branch!=='main'
    ||run.event!==('workflow_dispatch'))fail('BOUNDED_RUN_SOURCE');
  const own=await get(`/repos/${central}/actions/workflows/${workflow.split('/').at(-1)}`);
  if(!Number.isSafeInteger(own.id)||own.id<1||own.path!==workflow||own.state!=='active'||run.workflow_id!==own.id)fail('BOUNDED_ENTRY_DISABLED');
  if((await get(`/repos/${central}/git/ref/heads/main`))?.object?.sha!==head.object.sha)fail('BOUNDED_RUN_SOURCE');
  return run;
}
export function resultOutcome(result) {
  if(result.reason==='EDITING')return 'paused';
  if(result.reason==='SOURCE_CHANGED'||result.reason==='MERGED_SOURCE_HANDOFF'||result.reason==='CLOSED_PR')return 'source_changed';
  const evidence=result.projectionEvidence;
  if(result.status==='READY'&&(result.reason==='CACHED_OBSERVATION'||result.reason==='MANUAL_PROJECTION')
    &&evidence&&Object.keys(evidence).sort().join(',')==='bodyDigest,commentId,previewDigest'
    &&Number.isSafeInteger(evidence.commentId)&&evidence.commentId>0&&key(evidence.bodyDigest)&&key(evidence.previewDigest))return 'done';
  return 'needs_attention';
}
/** A real event changes control state, never the original registration window. */
export async function applyCandidateEvent(registration,producer,current,post) {
  if(!Array.isArray(current.pull.labels))fail('BOUNDED_LABELS_UNKNOWN');
  const editing=current.pull.labels.some(label=>label.name==='release:editing');
  if(current.event.event==='labeled'&&!editing||current.event.event==='unlabeled'&&editing)fail('BOUNDED_EVENT_SUPERSEDED');
  let record=await post('status',{identity:registration.identity});
  if(record===null)record=await post('register',{registration,producer});
  if(!record||!sameIdentity(record.identity,registration.identity)||record.policySha!==registration.policySha
    ||record.deploymentSha!==registration.deploymentSha||!Number.isSafeInteger(record.generation)||record.generation<1)fail('BOUNDED_REGISTERED_STATE');
  const action=editing&&record.status==='PENDING'?'pause':!editing&&record.status==='PAUSED'?'resume':null;
  if(action) {
    const next=await post(action,{identity:registration.identity,expectedGeneration:record.generation,producer});
    if(!next||!sameIdentity(next.identity,record.identity)||next.t0!==record.t0||next.deadline!==record.deadline||next.consumed!==record.consumed)
      fail('BOUNDED_CONTROL_WINDOW_CHANGED');
    record=next;
  }
  return {status:record.status};
}
export async function main(env=process.env) {
  const mode=env.BOUNDED_MODE;if(!['observe','event'].includes(mode))fail('BOUNDED_MODE');
  const config=JSON.parse(await readFile(new URL('../config/bounded-recheck.json',import.meta.url),'utf8'));
  const centralReader=new NativeEvidenceReader(nativeEvidenceTransport(env.STEWARD_CENTRAL_TOKEN),central);
  const centralGet=path=>centralReader.json(path===`/repos/${central}`?'':path.replace(`/repos/${central}/`,''));
  if(env.BOUNDED_POLICY_SHA!==env.STEWARD_CONTROLLER_SHA)fail('BOUNDED_POLICY_MOVED');
  const run=await entryGuard(env,centralGet,config);
  const app=await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY??'');
  if(run.actor?.id!==app.appBotId)fail('BOUNDED_DISPATCH_ACTOR');
  const locator=JSON.parse((mode==='observe'?env.BOUNDED_IDENTITY_JSON:env.BOUNDED_EVENT_JSON)??'null');
  const root=await mkdtemp(join(tmpdir(),'bounded-release-'));
  try {return await withCandidateProduct(app,locator?.repositoryId,async(product,token,readToken)=>{
    const productReader=new NativeEvidenceReader(nativeEvidenceTransport(token),product.name);
    const get=path=>productReader.json(path===`/repos/${product.name}`?'':path.replace(`/repos/${product.name}/`,''));
    if(mode==='observe') {
      const identity=JSON.parse(env.BOUNDED_IDENTITY_JSON??'null'),requestKey=env.BOUNDED_REQUEST_KEY;
      if(!key(requestKey)||env.BOUNDED_POLICY_SHA!==env.STEWARD_CONTROLLER_SHA)fail('BOUNDED_OBSERVE_INPUT');
      const before=await candidateEvidence(get,{product});if(!sameIdentity(identity,before.identity))fail('BOUNDED_EPOCH');
      const repository={id:product.id,full_name:product.name,default_branch:product.defaultBranch};
      const state=await fetchState(root,repository,token);
      if(state.snapshot.head!==before.evidence.stateCommit)fail('BOUNDED_STATE_MOVED');
      await assertReleaseUnpaused(app,product.id);
      const result=await nativeReleaseCandidate({directory:state.directory,writeDirectory:join(root,'writes'),remote:state.remote,repository:product.name,
        repositoryId:product.id,defaultBranch:product.defaultBranch,appBotId:app.appBotId,identity:botIdentity},{token,readToken,controllerSha:env.STEWARD_CONTROLLER_SHA,
        expectedStateSha:before.evidence.stateCommit,observation:identity,
        checkRepositoryPolicy:releasePolicyGuard(app,repository)});
      const after=await candidateEvidence(get,{product});if(!sameIdentity(identity,after.identity))fail('BOUNDED_EPOCH_MOVED');
      if(after.pull.head.sha!==before.pull.head.sha)fail('BOUNDED_HUMAN_HEAD_MOVED');
      const output={schemaVersion:1,requestKey,identity,repositoryId:centralId,runId:run.id,runAttempt:run.run_attempt,
        controllerSha:env.STEWARD_CONTROLLER_SHA,sourceSha:identity.sourceSha,observedAt:new Date().toISOString(),
        status:result.status,reason:result.reason,outcome:resultOutcome(result),stateBefore:before.evidence,stateAfter:after.evidence,
        projectionEvidence:result.projectionEvidence??null};
      await writeFile('result.json',JSON.stringify(output)+'\n',{flag:'wx'});return output;
    }
    if(mode==='event') {
      const requestKey=env.BOUNDED_REQUEST_KEY;if(!key(requestKey)||!sha(config.deploymentSha))fail('BOUNDED_EVENT_CONFIG');
      const value=await validateCandidateEvent(JSON.parse(env.BOUNDED_EVENT_JSON??'null'),get,product);
      const registration={identity:value.identity,t0:value.t0,policySha:env.STEWARD_CONTROLLER_SHA,deploymentSha:config.deploymentSha};
      const output={schemaVersion:1,requestKey,registration,producer:{repositoryId:centralId,runId:run.id,attempt:run.run_attempt,controllerSha:env.STEWARD_CONTROLLER_SHA},
        sourceEvidence:{...value.evidence,eventId:value.event.id,eventCreatedAt:value.event.created_at}};
      await writeFile('registration.json',JSON.stringify(output)+'\n',{flag:'wx'});return output;
    }
  });}finally{await rm(root,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{
  const code=error?.message;
  const reason=['RELEASE_REPOSITORY_PAUSED','RELEASE_PAUSE_POLICY_UNAVAILABLE'].includes(code)?code:'BOUNDED_ENTRY_STOPPED';
  process.stderr.write(reason+'\n');
  process.exitCode=1;
});
