// Install as scripts/business-flow-acceptance.mjs in the reviewed controller tree.
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const digest = text => createHash('sha256').update(text).digest('hex');
const requireFact = (ok, code) => { if (!ok) throw Error('ACCEPTANCE_'+code); };
export function validatePlan(raw, expectedHash, env) {
  requireFact(digest(raw)===expectedHash,'PLAN_DIGEST');
  const p=JSON.parse(raw),sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
  requireFact(env.GITHUB_REPOSITORY==='splrad/steward'&&env.GITHUB_REPOSITORY_ID==='1296724484'
    &&env.GITHUB_REF==='refs/heads/main'&&env.GITHUB_EVENT_NAME==='workflow_dispatch'
    &&env.GITHUB_RUN_ATTEMPT==='1'&&env.GITHUB_WORKFLOW_REF==='splrad/steward/.github/workflows/business-flow-acceptance.yml@refs/heads/main'
    &&sha(p.controllerSha)&&p.controllerSha===env.GITHUB_SHA&&p.controllerSha===env.WORKFLOW_SHA,'CONTROLLER');
  requireFact(p.schemaVersion===1&&['quality','release'].includes(p.kind)&&[0,1].includes(p.maxRequests),'MODE');
  requireFact(p.expectControlledStop===undefined||p.expectControlledStop===false||p.expectControlledStop===true&&p.kind==='quality'&&p.maxRequests===0,'CONTROLLED_STOP_PLAN');
  requireFact(p.repository&&/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(p.repository.full_name)
    &&Number.isSafeInteger(p.repository.id)&&p.repository.id>0&&p.repository.default_branch==='main'
    &&typeof p.repository.private==='boolean'&&sha(p.baseSha)&&sha(p.stateSha),'TARGET');
  requireFact(!['steward-e08-controller','steward-e08-product','steward-e08-bootstrap','steward-e08-settings'].includes(p.repository.full_name.split('/')[1]),'EXCLUDED');
  if(p.kind==='quality')requireFact(Number.isSafeInteger(p.pr)&&p.pr>0&&sha(p.head)&&Array.isArray(p.sources)&&p.sources.length>0
    &&/^[a-f0-9]{64}$/.test(p.sourceSetDigest)&&Number.isSafeInteger(p.governanceAppId)&&p.governanceAppId>0
    &&typeof p.configVersion==='string'&&p.configVersion.length>0,'QUALITY');
  return p;
}
export function boundedClient(client, maximum) {
  let calls=0;
  return {get calls(){return calls;},preflight:()=>{requireFact(calls<maximum,'CALL_LIMIT');return client.preflight();},async call(input){
    requireFact(calls<maximum,'CALL_LIMIT');calls++;return client.call(input);
  }};
}
export async function executePlan(p,{root,controllerDirectory,app,modelToken,fetcher=fetch}) {
  const lib=await import(pathToFileURL(join(controllerDirectory,'packages/runner/dist/index.js')).href);
  const q=await import(pathToFileURL(join(controllerDirectory,'scripts/quality-language-summary.mjs')).href);
  const verifyRepository=async token=>{
    const io=q.qualityNativeIO(p.repository.full_name,token,fetcher);
    const r=(await io.get('/repos/'+p.repository.full_name)).value;
    requireFact(r.id===p.repository.id&&r.full_name===p.repository.full_name&&r.private===p.repository.private
      &&r.default_branch===p.repository.default_branch&&!r.archived&&!r.disabled,'REPOSITORY_CHANGED');
    const ref=(await io.get('/repos/'+p.repository.full_name+'/git/ref/heads/main')).value;
    requireFact(ref.object?.sha===p.baseSha,'BASE_CHANGED');return io;
  };
  if(p.kind==='quality')return app.forQualityRepository(p.repository.id,async token=>{
    const io=await verifyRepository(token);
    const ref=(await io.get('/repos/'+p.repository.full_name+'/git/ref/heads/steward/governance-state')).value;
    requireFact(ref.object?.sha===p.stateSha,'STATE_CHANGED');
    const approvedPr=(await io.get('/repos/'+p.repository.full_name+'/pulls/'+p.pr)).value;
    requireFact(approvedPr.number===p.pr&&approvedPr.head?.sha===p.head&&approvedPr.state==='open'&&approvedPr.base?.repo?.id===p.repository.id,'HEAD_CHANGED');
    const state=await q.openQualityStore(root,p.repository,token,io,p.governanceAppId);
    requireFact(state.snapshot.head===p.stateSha,'STATE_CHANGED');
    const context={repository:p.repository.full_name,repositoryId:p.repository.id,pullRequestNumber:p.pr,
      head:p.head,appId:4243096,configVersion:p.configVersion};
    const sources=await lib.collectQualitySources(context,p.sources,io);
    requireFact(p.maxRequests===0||sources.length>0,'SOURCE_EMPTY');
    // Digest binds the complete read set including native IDs, commits, times and original bodies.
    requireFact(digest(JSON.stringify(sources))===p.sourceSetDigest,'SOURCE_CHANGED');
    const cache=await lib.reconcileQualitySources(state.cache(p.pr),{...context,observedAt:new Date().toISOString()},sources);
    const store=state.forPull(p.pr),client=boundedClient(lib.copilotQualityClient(controllerDirectory,modelToken),p.maxRequests);
    await store.save(cache);
    await lib.translateQualitySources(cache,client,store,{remaining:p.maxRequests,deadline:Date.now()+180000});
    const pr=(await io.get('/repos/'+p.repository.full_name+'/pulls/'+p.pr)).value;
    requireFact(pr.head?.sha===p.head&&pr.state==='open'&&pr.base?.repo?.id===p.repository.id,'HEAD_CHANGED');
    await verifyRepository(token);
    requireFact(digest(JSON.stringify(await lib.collectQualitySources(context,p.sources,io)))===p.sourceSetDigest,'SOURCE_CHANGED');
    const result=await lib.publishQualityCheck(context,cache,io,store);
    if(p.expectControlledStop){
      requireFact(client.calls===0&&result.pending>0,'CONTROLLED_STOP_NOT_OBSERVED');
      return {kind:p.kind,status:'CONTROLLED_STOP',calls:0,pending:result.pending};
    }
    requireFact(result.pending===0,'QUALITY_PENDING');return {kind:p.kind,status:'COMPLETE',calls:client.calls,complete:result.complete};
  });
  return app.forCandidateRepository(p.repository.id,async(token,readToken)=>{
    await verifyRepository(token);
    const {fetchState}=await import(pathToFileURL(join(controllerDirectory,'scripts/release-coordinator.mjs')).href);
    const {nativeReleaseCandidate}=await import(pathToFileURL(join(controllerDirectory,'scripts/release-candidate.mjs')).href);
    const guardedFetch=async(url,init)=>{
      const response=await fetcher(url,init);
      const refs=new Map([
        ['https://api.github.com/repos/'+p.repository.full_name+'/git/ref/heads/main',p.baseSha],
      ]);
      if(refs.has(String(url)))requireFact(response.ok&&(await response.clone().json()).object?.sha===refs.get(String(url)),'SOURCE_OR_STATE_CHANGED');
      return response;
    };
    const state=await fetchState(root,p.repository,token,'steward/release-state',{fetcher:guardedFetch,includeHistory:false});
    requireFact(state.snapshot.head===p.stateSha,'STATE_CHANGED');
    const client=boundedClient(lib.copilotReleaseClient(controllerDirectory,modelToken),p.maxRequests);
    const result=await nativeReleaseCandidate({directory:state.directory,writeDirectory:join(root,'writes'),remote:state.remote,
      repository:p.repository.full_name,repositoryId:p.repository.id,defaultBranch:'main',appBotId:app.appBotId,
      identity:{name:'splrad-steward[bot]',email:'301115370+splrad-steward[bot]@users.noreply.github.com'}},
      {token,readToken,controllerSha:p.controllerSha,controllerDirectory,temporaryRoot:root,fetcher:guardedFetch,language:client,expectedStateSha:p.stateSha});
    requireFact(result.status==='READY','CANDIDATE_PENDING');return {kind:p.kind,calls:client.calls,status:result.status};
  });
}
export async function main(env=process.env) {
  const plan=validatePlan(env.STEWARD_ACCEPTANCE_PLAN??'',env.APPROVED_PLAN_SHA256??'',env);
  requireFact(plan.kind===env.ACCEPTANCE_CONSUMER,'CONSUMER');
  requireFact(env.AUTHORIZE_BUSINESS_ACCEPTANCE==='true','NOT_AUTHORIZED');
  const directory=process.cwd(),lib=await import(pathToFileURL(join(directory,'packages/runner/dist/index.js')).href);
  const root=await mkdtemp(join(tmpdir(),'steward-business-acceptance-'));
  try {
    const app=await lib.nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY??'');
    const result=await executePlan(plan,{root,controllerDirectory:directory,app,modelToken:env.STEWARD_COPILOT_TOKEN??''});
    process.stdout.write(JSON.stringify(result)+'\n');
  }finally{await rm(root,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
  const code=/^ACCEPTANCE_[A-Z_]+$/.test(error?.message??'')?error.message:'BUSINESS_ACCEPTANCE_STOPPED';
  process.stderr.write(JSON.stringify({status:'STOPPED',code})+'\n');process.exitCode=75;
});