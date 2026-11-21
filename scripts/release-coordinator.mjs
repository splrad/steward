import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeEvidenceTransport, isolatedBuildEnvironment, githubUnits,evaluateCompletion,parseDeliveryConfig,assertProductDelivery,verifyDispatchWorkflow,encodeRepositoryPath } from '../packages/runner/dist/index.js';
import { readReleaseRecords, assertReleaseWriterProtection } from './release-record.mjs';
import {servicePages,pagesGitStore} from './pages-maintenance.mjs';
import {assertQualityProtection,qualityNativeIO} from './quality-language-summary.mjs';
import {validateReleaseConfiguration} from './release-adoption.mjs';
import {mergedRepositoryPolicy} from './repository-policy-read.mjs';

const identity={name:'splrad-steward[bot]',email:'301115370+splrad-steward[bot]@users.noreply.github.com'};
const safeCode=error=>error instanceof Error && /^RELEASE_[A-Z_]+$/.test(error.message)?error.message:'RELEASE_NATIVE_UNAVAILABLE';
const iso=clock=>new Date(clock()).toISOString();
const isGitSha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const validMatchingRefs=(refs,target)=>Array.isArray(refs)
  &&refs.every(r=>typeof r?.ref==='string'&&r.ref.startsWith(`refs/heads/${target}`)&&r.object?.type==='commit'&&isGitSha(r.object.sha))
  &&new Set(refs.map(r=>r.ref)).size===refs.length;

/** One wake has one fixed domain sequence. A publish invocation always ends this repository's wake. */
export async function serviceReleaseWake(request,refresh,invoke,clock=Date.now) {
  let snapshot=await refresh();
  if(!snapshot.repository)return {status:'WAIT',reason:'RELEASE_BOOTSTRAP_REQUIRED'};
  let candidate;
  try {
    candidate=await invoke('candidate',{...request,cycleId:snapshot.repository.activeCycleId,runId:null});
  } catch(error) {
    const reason=error?.message;
    if(!['CANDIDATE_REPOSITORY_POLICY_DISABLED','CANDIDATE_REPOSITORY_POLICY_CONFLICT',
      'CANDIDATE_REPOSITORY_POLICY_MOVED','REPOSITORY_POLICY_UNAVAILABLE']
      .includes(reason))throw error;
    candidate={status:'WAIT',reason};
  }
  snapshot=await refresh();
  const results=[];
  for(const {value:registered} of snapshot.cycles) {
    if(registered.freezeOnly && !githubUnits(registered).length) {
      if(!registered.freezeCompletedAt)results.push(await invoke('observe-channel',{...request,cycleId:registered.id,runId:null}));
      continue;
    }
    const read=snapshot.domainRecords?.filter(record=>record.path.startsWith('evidence/reads/')&&record.value.cycleId===registered.id)
      .sort((a,b)=>b.value.observedAt.localeCompare(a.value.observedAt))[0]?.value;
    if(read?.nextCheckAt&&Date.parse(read.nextCheckAt)>clock()) {
      results.push({status:'WAIT',reason:'NATIVE_READ_BACKOFF',nextCheckAt:read.nextCheckAt});continue;
    }
    const latest=snapshot.domainRecords?.find(record=>record.path===registered.completedEvidencePath)?.value;
    if(latest&&evaluateCompletion(latest.source,latest.observation,latest.observation.observedAt).distributionResult==='PASS'
      &&evaluateCompletion(latest.source,latest.observation,latest.observation.observedAt).result==='PASS')continue;
    request={...request,cycleId:registered.id,runId:null};
    if(!registered.completedEvidencePath) {
      results.push(await invoke('dispatch-build',request));await refresh();
      const publish=await invoke('publish',request);results.push(publish);
      if(publish.publishInvoked===true)return publish;
      if(publish.status==='FROZEN')continue;
    }
    if(registered.requiredChannels?.length!==0) {await refresh();results.push(await invoke('dispatch-channel',request));}
    await refresh();results.push(await invoke('observe-channel',request));
    snapshot=await refresh();
    const cycle=snapshot.cycles.find(value=>value.value.id===registered.id)?.value;
    for(const dispatch of cycle?.dispatches??[])if(dispatch.canonicalRunId!==null) {
      results.push(await invoke('rerun',{...request,runId:dispatch.canonicalRunId}));snapshot=await refresh();
    }
  }
  if(!results.length)return snapshot.cycles.length && candidate.status==='WAIT' && candidate.reason==='UNCHANGED' && !snapshot.repository.candidate
    ?{status:'COMPLETE',reason:'REGISTERED_RELEASES_VERIFIED'}:candidate;
  const nextCheckAt=results.map(value=>value.nextCheckAt??value.observation?.readObservation?.nextCheckAt).filter(Boolean).sort().at(-1)??null;
  if(results.some(value=>['UNKNOWN','CONFLICT','BLOCKED'].includes(value.status)))return {status:'UNKNOWN',reason:'NATIVE_EVIDENCE_REQUIRED',nextCheckAt};
  return {status:'WAIT',reason:'REGISTERED_CYCLES_OBSERVED',nextCheckAt};
}

/** Ports are fixed I/O boundaries, never persisted tasks, action tables or callback names. */
export async function coordinateReleaseWake({discover,observe,service,health,maintenance,pages},clock=Date.now) {
  const started=clock(),deadline=started+40*60_000,counts={scanned:0,completed:0,waiting:0,failed:0,unknown:0},errors=new Set(),ready=[];
  let inventoryComplete=false,scanComplete=true;
  if(maintenance) {
    try {const result=await maintenance();for(const code of result.errorCodes)errors.add(code);if(result.errorCodes.length)scanComplete=false;}
    catch {scanComplete=false;errors.add('MAINTENANCE_UNAVAILABLE');}
  }
  try {
    const repositories=await discover();inventoryComplete=true;
    for(const repository of repositories) {
      if(clock()>=deadline){scanComplete=false;errors.add('CLAIM_WINDOW_CLOSED');break;}
      if(repository.archived||repository.disabled)continue;
      // Pages remains independent of release bootstrap, channel waits and product release progress.
      if(pages)try {
        const result=await pages(repository);
        if(['UNKNOWN','EXHAUSTED','EXPIRED'].includes(result.status)){scanComplete=false;errors.add('PAGES_EVIDENCE_REQUIRED');}
      }catch {scanComplete=false;errors.add('PAGES_UNAVAILABLE');}
      try {const observation=await observe(repository);counts.scanned++;
        if(observation.status==='NOT_APPLICABLE')counts.completed++;
        else ready.push({repository,...observation});}
      catch(error){counts.unknown++;scanComplete=false;errors.add(safeCode(error));}
    }
    ready.sort((a,b)=>Date.parse(a.lastServedAt??'1970-01-01T00:00:00Z')-Date.parse(b.lastServedAt??'1970-01-01T00:00:00Z')||a.repository.id-b.repository.id);
    for(const item of ready) {
      if(clock()>=deadline){scanComplete=false;errors.add('CLAIM_WINDOW_CLOSED');break;}
      if(item.nextCheckAt && Date.parse(item.nextCheckAt)>clock()){counts.waiting++;continue;}
      try {
        const result=await service(item.repository);
        if(result.status==='COMPLETE')counts.completed++;
        // A prepared candidate and a protected notes edit both await human action.
        else if(['READY','WAIT','BOUND','SATISFIED','OBSERVED','ACCEPTED'].includes(result.status)
          || result.status==='CONFLICT'&&result.reason==='HUMAN_EDIT_CONFLICT')counts.waiting++;
        else {counts.unknown++;scanComplete=false;errors.add('NATIVE_EVIDENCE_REQUIRED');}
      }catch(error){counts.failed++;scanComplete=false;errors.add(safeCode(error));}
    }
  }catch(error){errors.add(safeCode(error));scanComplete=false;}
  const summary={observedAt:iso(clock),scanCompletedAt:inventoryComplete&&scanComplete?iso(clock):null,errorCodes:[...errors].sort(),counts};
  await health(summary);return summary;
}

/** Repository visibility is not product enrollment. Only proven absent inputs and obligations are inapplicable. */
export async function releaseParticipation(repository,io,{includeUnits=false}={}) {
  const read=async suffix=>{
    const r=await io.request('GET',`/repos/${repository.full_name}${suffix?'/'+suffix:''}`);
    if(r.status!==200)throw Error('RELEASE_PARTICIPATION_UNAVAILABLE');
    return JSON.parse(Buffer.from(r.bytes).toString('utf8'));
  };
  const readTree=async sha=>{
    const value=await read(`git/trees/${sha}?recursive=1`);
    if(value?.truncated!==false||!Array.isArray(value.tree))throw Error('RELEASE_PARTICIPATION_INCOMPLETE');
    if(value.tree.some(x=>typeof x?.path!=='string'||!x.path||x.path.includes('\0')||x.path.split('/').some(p=>!p||p==='.'||p==='..')
      ||!isGitSha(x.sha)||!(x.type==='tree'&&x.mode==='040000'||x.type==='blob'&&['100644','100755','120000'].includes(x.mode)||x.type==='commit'&&x.mode==='160000'))
      ||new Set(value.tree.map(x=>x.path)).size!==value.tree.length)throw Error('RELEASE_PARTICIPATION_IDENTITY');
    return value;
  };
  const actual=await read('');
  if(actual.id!==repository.id||actual.full_name!==repository.full_name||actual.default_branch!==repository.default_branch||actual.archived!==false||actual.disabled!==false)throw Error('RELEASE_PARTICIPATION_IDENTITY');
  const readDefaultRef=async()=>{
    const value=await read(`git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
    if(value?.ref!==`refs/heads/${repository.default_branch}`||value.object?.type!=='commit'||!isGitSha(value.object.sha))throw Error('RELEASE_PARTICIPATION_IDENTITY');
    return value;
  };
  const ref=await readDefaultRef();
  const tree=await readTree(ref.object.sha);
  const names=['.github/delivery.json','release-please-config.json','.release-please-manifest.json'];
  const files=names.map(path=>tree.tree.filter(x=>x.path===path));
  const refs=await read('git/matching-refs/heads/steward/release-state');
  if(!Array.isArray(refs))throw Error('RELEASE_PARTICIPATION_INCOMPLETE');
  if(!validMatchingRefs(refs,'steward/release-state'))throw Error('RELEASE_PARTICIPATION_IDENTITY');
  const stateRef=refs.find(r=>r.ref==='refs/heads/steward/release-state');
  let obligation=false;
  if(stateRef) {
    if(stateRef.object?.type!=='commit'||!isGitSha(stateRef.object.sha))throw Error('RELEASE_PARTICIPATION_IDENTITY');
    const state=await readTree(stateRef.object.sha);
    // Only the fixed central maintenance-only tree is not a product state.
    obligation=repository.id!==1296724484||repository.full_name!=='splrad/steward'
      ||state.tree.some(x=>!(x.path==='maintenance'&&x.type==='tree'&&x.mode==='040000')
        &&!(x.type==='blob'&&x.mode==='100644'&&/^maintenance\/[1-9][0-9]*\.json$/.test(x.path)));
  }
  let status='APPLICABLE',absenceFacts=null,units;
  if(files.every(x=>x.length===0)&&!obligation) {
    const candidates=await read('git/matching-refs/heads/steward/release-candidate');
    const builds=await read('git/matching-refs/heads/steward/build/');
    const releases=await read('releases?per_page=1');
    if(!Array.isArray(candidates)||!Array.isArray(builds)||!Array.isArray(releases))throw Error('RELEASE_PARTICIPATION_INCOMPLETE');
    if(candidates.length||builds.length||releases.length)throw Error('RELEASE_CONFIGURATION_REQUIRED');
    absenceFacts=[candidates,builds,releases];
    status='NOT_APPLICABLE';
  } else {
    if(files.some(x=>x.length!==1||x[0].type!=='blob'||x[0].mode!=='100644'))throw Error('RELEASE_CONFIGURATION_REQUIRED');
    const readSource=async(path,entry)=>{
      const v=await read(`contents/${encodeRepositoryPath(path)}?ref=${ref.object.sha}`);
      if(v.type!=='file'||v.path!==path||v.sha!==entry.sha||v.encoding!=='base64'||typeof v.content!=='string')throw Error('RELEASE_CONFIGURATION_INVALID');
      const bytes=Buffer.from(v.content,'base64');
      if(bytes.length!==v.size||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==v.sha)throw Error('RELEASE_CONFIGURATION_INVALID');
      return bytes;
    };
    try {
      const contents=await Promise.all(names.map(async(path,i)=>JSON.parse(await readSource(path,files[i][0]))));
      const delivery=parseDeliveryConfig(contents[0]);assertProductDelivery(delivery,repository.full_name);
      validateReleaseConfiguration(delivery,contents[1],contents[2]);
      if(delivery.buildWorkflow!==undefined) {
        const publisher=tree.tree.find(entry=>entry.path===delivery.buildWorkflow);
        if(publisher?.type!=='blob'||publisher.mode!=='100644')throw Error('RELEASE_CONFIGURATION_INVALID');
        verifyDispatchWorkflow(await readSource(delivery.buildWorkflow,publisher), {purpose:'build',buildWorkflow:delivery.buildWorkflow,
          inputs:{cycle_id:'',operation_key:'',source_sha:'',controller_sha:''}});
      }
      if(includeUnits)units=delivery.units.map(({id,path,notesPath})=>({id,path,notesPath}));
    }catch(error){if(error.message==='AUTHOR_IDENTITY_UNVERIFIED')throw error;throw Error('RELEASE_CONFIGURATION_INVALID');}
  }
  if(absenceFacts) {
    const after=[await read('git/matching-refs/heads/steward/release-candidate'),await read('git/matching-refs/heads/steward/build/'),await read('releases?per_page=1')];
    if(JSON.stringify(after)!==JSON.stringify(absenceFacts))throw Error('RELEASE_PARTICIPATION_CHANGED');
  }
  const after=await readDefaultRef();
  const stateAfter=await read('git/matching-refs/heads/steward/release-state');
  if(after.object?.sha!==ref.object.sha||JSON.stringify(stateAfter)!==JSON.stringify(refs))throw Error('RELEASE_PARTICIPATION_CHANGED');
  return {status,sourceSha:ref.object.sha,...(units?{units}:{})};
}

export async function fetchState(root,repository,token,targetRef='steward/release-state',{governanceAppId,fetcher=fetch,includeHistory=targetRef!=='steward/release-state',centralFirstUse=false,readCentralMaintenanceRules,withGovernanceRules}={}) {
  const io=nativeEvidenceTransport(token,fetcher),remote=`https://github.com/${repository.full_name}.git`;
  if(centralFirstUse) {
    if(repository.id!==1296724484||repository.full_name!=='splrad/steward'||targetRef!=='steward/release-state')throw new Error('RELEASE_CENTRAL_STATE_IDENTITY');
    const response=await io.request('GET','/repos/splrad/steward');
    if(response.status!==200)throw new Error('RELEASE_CENTRAL_STATE_UNAVAILABLE');
    const actual=JSON.parse(Buffer.from(response.bytes).toString('utf8'));
    if(actual.id!==repository.id||actual.full_name!==repository.full_name||actual.default_branch!==repository.default_branch||actual.archived!==false||actual.disabled!==false)throw new Error('RELEASE_CENTRAL_STATE_IDENTITY');
  }
  if(targetRef==='steward/governance-state'){
    const verify=ruleToken=>assertQualityProtection(qualityNativeIO(repository.full_name,ruleToken,fetcher),repository.full_name,governanceAppId);
    if(withGovernanceRules)await withGovernanceRules(verify);
    else await verify(token);
  }
  else await assertReleaseWriterProtection(repository.full_name,targetRef,io,{token,fetcher,readCentralMaintenanceRules});
  const response=await io.request('GET',`/repos/${repository.full_name}/git/ref/heads/${targetRef}`);
  // The central maintenance consumer starts without records until its first
  // real maintenance result creates steward/release-state.
  if(response.status===404&&centralFirstUse) {
    const confirmation=await io.request('GET',`/repos/${repository.full_name}/git/matching-refs/heads/${targetRef}`);
    if(confirmation.status!==200)throw new Error('RELEASE_STATE_UNAVAILABLE');
    const matches=JSON.parse(Buffer.from(confirmation.bytes).toString('utf8'));
    if(!validMatchingRefs(matches,targetRef))throw new Error('RELEASE_STATE_IDENTITY');
    if(matches.some(r=>r.ref===`refs/heads/${targetRef}`))throw new Error('RELEASE_STATE_MOVED');
    return {remote,io,snapshot:{repositoryId:repository.id,targetRef,head:null,repository:null,domainRecords:[],currentPaths:[]},
      readBytes:async()=>{throw new Error('RELEASE_STATE_FILE_UNAVAILABLE');}};
  }
  if(response.status!==200)throw new Error(response.status===404?'RELEASE_BOOTSTRAP_REQUIRED':'RELEASE_STATE_UNAVAILABLE');
  const ref=JSON.parse(Buffer.from(response.bytes).toString('utf8'));
  if(ref.ref!==`refs/heads/${targetRef}`||ref.object?.type!=='commit'||!isGitSha(ref.object.sha))throw new Error('RELEASE_STATE_IDENTITY');
  const directory=await mkdtemp(join(root,'snapshot-')),profile=await mkdtemp(join(root,'profile-'));
  const env=isolatedBuildEnvironment(process.env,profile);
  Object.assign(env,{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:`http.${remote}.extraheader`,GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+Buffer.from('x-access-token:'+token).toString('base64')});
  const git=async(...args)=>(await promisify(execFile)('git',['--no-replace-objects','-c','core.hooksPath=','-c','core.fsmonitor=false','-c','credential.helper=',...args],
    {cwd:directory,env,encoding:'buffer',maxBuffer:32*1024*1024,timeout:90_000,windowsHide:true})).stdout;
  await git('init','--initial-branch=state-read');await git('fetch','--no-tags','--no-recurse-submodules',remote,`refs/heads/${targetRef}`);
  const head=(await git('rev-parse','FETCH_HEAD')).toString().trim();if(head!==ref.object.sha)throw new Error('RELEASE_STATE_MOVED');
  await git('update-ref',`refs/heads/${targetRef}`,head);
  if(targetRef==='steward/release-state') {
    await git('fetch','--no-tags','--no-recurse-submodules',remote,`refs/heads/${repository.default_branch}`);
    await git('update-ref',`refs/heads/${repository.default_branch}`,(await git('rev-parse','FETCH_HEAD')).toString().trim());
    const governance=await io.request('GET',`/repos/${repository.full_name}/git/ref/heads/steward/governance-state`);
    if(governance.status===200) {
      await git('fetch','--no-tags','--no-recurse-submodules',remote,'refs/heads/steward/governance-state');
      const actual=(await git('rev-parse','FETCH_HEAD')).toString().trim();
      if(actual!==JSON.parse(Buffer.from(governance.bytes).toString('utf8')).object?.sha)throw new Error('RELEASE_STATE_MOVED');
      await git('update-ref','refs/heads/steward/governance-state',actual);
    }
  }
  const snapshot=await readReleaseRecords({directory,targetRef,repositoryId:repository.id,includeHistory,maintenanceOnly:centralFirstUse&&targetRef==='steward/release-state'});
  const lastServedAt=(await git('show','-s','--format=%cI',head)).toString().trim();
  const readBytes=async path=>git('show',`${head}:${path}`);
  return {directory,remote,io,snapshot,lastServedAt,readBytes};
}

/** The first central health record describes this real wake, including incomplete scans. */
export async function serviceRepositoryPages({app,root,repository,coordinator,completion,site}) {
  return app.forPagesRepository(repository.id,async token=>{
    const io=nativeEvidenceTransport(token);
    if(completion) {
      const response=await io.request('GET','/repos/'+site.repository);
      if(response.status!==200)throw Error('PAGES_PRODUCT_READ');
      const actual=JSON.parse(Buffer.from(response.bytes));
      if(actual.id!==site.repositoryId||actual.full_name!==site.repository||typeof actual.default_branch!=='string'||!actual.default_branch
        ||['private','fork','archived','disabled','has_pages'].some(field=>typeof actual[field]!=='boolean'))throw Error('PAGES_PRODUCT_IDENTITY');
      if(actual.private||actual.fork||actual.archived||actual.disabled||!actual.has_pages)return {status:'DISABLED'};
      repository=actual;
    }
    // Organization governance writer identity, as bound by quality-state-initialize and the live branch rules.
    const governanceAppId=5639432;
    const writeDirectory=await mkdtemp(join(root,'pages-writes-'));
    const store=pagesGitStore({repositoryId:repository.id,refresh:()=>fetchState(root,repository,token,'steward/governance-state',{governanceAppId}),
      writeDirectory,defaultBranch:repository.default_branch,token,identity});
    return servicePages({io,repository,store,completion,appBotId:app.appBotId,token,coordinator,
      readPolicy:()=>mergedRepositoryPolicy(app,repository)});
  });
}
