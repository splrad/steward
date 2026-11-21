import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {NativeEvidenceReader,nativeEvidenceTransport,nativeReleaseApp} from '../packages/runner/dist/index.js';
import {entryGuard} from './bounded-release-entry.mjs';
import {serviceRepositoryPages} from './release-coordinator.mjs';
import {nativeTemporaryParent} from './native-scratch.mjs';

const config=async file=>JSON.parse(await readFile(new URL('../config/'+file,import.meta.url),'utf8'));
const required=(value,reason)=>{if(!value)throw Error(reason);};
function identifier(value) {
  const n=Number(value);
  required(Number.isSafeInteger(n)&&n>0&&String(n)===value,'PAGES_EVENT_ID');
  return n;
}
export async function receiveCompletion(env,sites,getCentral,guardConfig,openApp,consume) {
  const completion={repositoryId:identifier(env.PAGES_REPOSITORY_ID),workflowId:identifier(env.PAGES_WORKFLOW_ID),
    runId:identifier(env.PAGES_RUN_ID),attempt:identifier(env.PAGES_ATTEMPT)};
  const site=sites.find(s=>s.repositoryId===completion.repositoryId&&s.workflowId===completion.workflowId);
  if(!site)return {status:'UNREGISTERED'};
  required(env.GITHUB_EVENT_NAME==='workflow_dispatch'&&env.GITHUB_RUN_ATTEMPT==='1'&&env.BOUNDED_MODE==='pages'
    &&env.PAGES_POLICY_SHA===env.STEWARD_CONTROLLER_SHA,'PAGES_EVENT_SOURCE');
  const run=await entryGuard(env,getCentral,guardConfig);
  const app=await openApp();
  required(run.actor?.id===app.appBotId&&run.triggering_actor?.id===app.appBotId,'PAGES_EVENT_ACTOR');
  return consume({app,site,completion,coordinator:{runId:run.id,runAttempt:run.run_attempt,controllerSha:run.head_sha}});
}
export async function main(env) {
  const reader=new NativeEvidenceReader(nativeEvidenceTransport(env.STEWARD_CENTRAL_TOKEN),'splrad/steward');
  const root=await mkdtemp(join(await nativeTemporaryParent('PAGES_TEMP_PARENT_LINK'),'steward-pages-event-'));
  try {
    const status=await receiveCompletion(env,(await config('pages-completion.json')).publicSites,
      path=>reader.json(path.replace(/^\/repos\/splrad\/steward\/?/,'')),await config('bounded-recheck.json'),
      ()=>nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY),({app,site,completion,coordinator})=>
        serviceRepositoryPages({app,root,site,repository:{id:site.repositoryId,full_name:site.repository},completion,coordinator}));
    const outcomes=['DISABLED','UNREGISTERED','STALE','SATISFIED','WAIT','ACCEPTED','UNKNOWN','EXHAUSTED','EXPIRED'];
    required(outcomes.includes(status.status),'PAGES_EVENT_OUTCOME');
    process.stdout.write('PAGES_EVENT_'+status.status+'\n');
    required(['DISABLED','UNREGISTERED','STALE','SATISFIED','WAIT','ACCEPTED'].includes(status.status),'PAGES_EVENT_UNCONFIRMED');
  }finally {await rm(root,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main(process.env).catch(()=>{process.stderr.write('PAGES_EVENT_UNCONFIRMED\n');process.exitCode=75;});
