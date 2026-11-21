import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {NativeEvidenceReader, nativeEvidenceTransport, nativeReleaseApp} from '../packages/runner/dist/index.js';
import {assertReleaseWriterProtection} from './release-record.mjs';
import {fetchState} from './release-coordinator.mjs';
import {maintenanceDefinition, maintenanceGitStore, recoverMaintenanceRun} from './maintenance.mjs';

const repository = {id:1296724484, full_name:'splrad/steward', default_branch:'main'};
const receiver = '.github/workflows/maintenance-event.yml';
const producers = new Map([
  [408662213, 'sync-managed.yml'],
  [408662210, 'quality-language-summary.yml'],
  [408662199, 'governance-promotion.yml'],
]);
const check = (ok, code) => { if (!ok) throw Error('MAINTENANCE_EVENT_'+code); };

export async function verifyCompletion(env, event, reader) {
  const run = event.workflow_run;
  const file = producers.get(run?.workflow_id);
  check(env.GITHUB_EVENT_NAME==='workflow_run' && event.action==='completed' && run?.status==='completed' &&
    env.GITHUB_REPOSITORY===repository.full_name && env.GITHUB_REPOSITORY_ID===String(repository.id) &&
    event.repository?.id===repository.id && event.repository.default_branch==='main' && env.GITHUB_REF==='refs/heads/main' &&
    env.GITHUB_WORKFLOW_REF===repository.full_name+'/'+receiver+'@refs/heads/main' &&
    env.GITHUB_SHA===env.STEWARD_CONTROLLER_SHA && /^[0-9a-f]{40}$/.test(env.GITHUB_SHA), 'RECEIVER');
  check(file && run.path==='.github/workflows/'+file && run.repository?.id===repository.id &&
    run.head_repository?.id===repository.id && run.head_branch==='main' &&
    [run.id,run.run_attempt].every(n=>Number.isSafeInteger(n)&&n>0), 'PRODUCER');
  const definition=await maintenanceDefinition(file);
  check(definition.events.includes(run.event) && /^[0-9a-f]{40}$/.test(run.head_sha),'PRODUCER_EVENT');
  const coordinator = {runId:Number(env.GITHUB_RUN_ID), runAttempt:Number(env.GITHUB_RUN_ATTEMPT)};
  check([coordinator.runId,coordinator.runAttempt].every(n=>Number.isSafeInteger(n)&&n>0),'ORIGIN_ID');
  const origin = await reader.json('actions/runs/'+coordinator.runId);
  const active = async () => {
    const main = await reader.json('git/ref/heads/main');
    check(main.ref==='refs/heads/main' && main.object?.type==='commit' && main.object.sha===env.GITHUB_SHA,'POLICY_MOVED');
    const own = await reader.json('actions/workflows/maintenance-event.yml');
    check(own.path===receiver && own.id===origin.workflow_id && own.state==='active','RECEIVER_STATE');
  };
  check(origin.id===coordinator.runId && origin.run_attempt===coordinator.runAttempt && origin.event==='workflow_run' &&
    origin.repository?.id===repository.id && origin.head_repository?.id===repository.id && origin.head_branch==='main' &&
    origin.head_sha===env.GITHUB_SHA && origin.path===receiver,'ORIGIN');
  await active();
  const workflow = await reader.json('actions/workflows/'+run.workflow_id);
  check(workflow.id===run.workflow_id && workflow.path===run.path,'WORKFLOW');
  return {workflow, definition, coordinator, beforePost:active};
}

export async function main(env=process.env) {
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
  const reader = new NativeEvidenceReader(nativeEvidenceTransport(env.STEWARD_CENTRAL_TOKEN),repository.full_name);
  const target = await verifyCompletion(env,event,reader);
  if(target.workflow.state!=='active')return {status:'PAUSED'};
  const app = await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY);
  const root = await mkdtemp(join(tmpdir(),'central-maintenance-'));
  try {
    return await app.forRepository(repository.id,async token=>{
      const readCentralMaintenanceRules=app.readCentralMaintenanceRules;
      const io=nativeEvidenceTransport(token);
      const beforeWrite=async()=>{
        await target.beforePost();
        await assertReleaseWriterProtection(repository.full_name,'steward/release-state',io,{readCentralMaintenanceRules});
      };
      const store = maintenanceGitStore({
        refresh:()=>fetchState(root,repository,token,'steward/release-state',{includeHistory:true,centralFirstUse:true,readCentralMaintenanceRules}),
        writeDirectory:join(root,'writes'), defaultBranch:'main', token, beforePush:beforeWrite,
        identity:{name:app.appBotLogin,email:'301115370+'+app.appBotLogin+'@users.noreply.github.com'},
      });
      // Recheck queued policy before each ledger update, including the final response receipt.
      const guardedStore={load:store.load,save:async(value,prior)=>{
        await target.beforePost();
        return store.save(value,prior);
      }};
      return recoverMaintenanceRun({...target, beforePost:beforeWrite, reader, io, store:guardedStore, branch:'main',
        runId:event.workflow_run.id, expectedRun:event.workflow_run});
    },'maintenance');
  } finally { await rm(root,{recursive:true,force:true}); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().then(result=>{
    console.log(result.status);
    if(!['ACCEPTED','SATISFIED','SUPERSEDED','PAUSED','REGISTRATION'].includes(result.status))process.exitCode=1;
  }).catch(error=>{
    console.error(/^MAINTENANCE_[A-Z_]+$/.test(error.message)?error.message:'MAINTENANCE_EVENT_UNAVAILABLE');
    process.exitCode=1;
  });
