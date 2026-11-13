import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { nativeReleaseApp, nativeEvidenceTransport, isolatedBuildEnvironment, evaluateCompletion,parseDeliveryConfig,assertProductDelivery } from '../packages/runner/dist/index.js';
import { readReleaseRecords, writeReleaseRecords, releaseCommand, assertReleaseWriterProtection } from './release-record.mjs';
import {serviceMaintenance,maintenanceGitStore} from './maintenance.mjs';
import {servicePages,pagesGitStore} from './pages-maintenance.mjs';
import {assertQualityProtection,qualityNativeIO} from './quality-language-summary.mjs';
import {validateReleaseConfiguration} from './release-adoption.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
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
  const candidate=await invoke('candidate',{...request,cycleId:snapshot.repository.activeCycleId,runId:null});
  snapshot=await refresh();
  const results=[];
  for(const {value:registered} of snapshot.cycles) {
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
    }
    await refresh();results.push(await invoke('dispatch-channel',request));
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
        else if(['WAIT','BOUND','SATISFIED','OBSERVED','ACCEPTED'].includes(result.status))counts.waiting++;
        else {counts.unknown++;scanComplete=false;errors.add('NATIVE_EVIDENCE_REQUIRED');}
      }catch(error){counts.failed++;scanComplete=false;errors.add(safeCode(error));}
    }
  }catch(error){errors.add(safeCode(error));scanComplete=false;}
  const summary={observedAt:iso(clock),scanCompletedAt:inventoryComplete&&scanComplete?iso(clock):null,errorCodes:[...errors].sort(),counts};
  await health(summary);return summary;
}

/** Repository visibility is not product enrollment. Only proven absent inputs and obligations are inapplicable. */
export async function releaseParticipation(repository,io) {
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
  let status='APPLICABLE',absenceFacts=null;
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
    const contents=[];
    for(let i=0;i<names.length;i++) {
      const v=await read(`contents/${names[i]}?ref=${ref.object.sha}`);
      if(v.type!=='file'||v.path!==names[i]||v.sha!==files[i][0].sha||v.encoding!=='base64')throw Error('RELEASE_CONFIGURATION_INVALID');
      const bytes=Buffer.from(v.content,'base64');
      if(bytes.length!==v.size||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==v.sha)throw Error('RELEASE_CONFIGURATION_INVALID');
      try{contents.push(JSON.parse(bytes.toString('utf8')));}catch{throw Error('RELEASE_CONFIGURATION_INVALID');}
    }
    try {
      const delivery=parseDeliveryConfig(contents[0]);assertProductDelivery(delivery,repository.full_name);
      validateReleaseConfiguration(delivery,contents[1],contents[2]);
    }catch{throw Error('RELEASE_CONFIGURATION_INVALID');}
  }
  if(absenceFacts) {
    const after=[await read('git/matching-refs/heads/steward/release-candidate'),await read('git/matching-refs/heads/steward/build/'),await read('releases?per_page=1')];
    if(JSON.stringify(after)!==JSON.stringify(absenceFacts))throw Error('RELEASE_PARTICIPATION_CHANGED');
  }
  const after=await readDefaultRef();
  const stateAfter=await read('git/matching-refs/heads/steward/release-state');
  if(after.object?.sha!==ref.object.sha||JSON.stringify(stateAfter)!==JSON.stringify(refs))throw Error('RELEASE_PARTICIPATION_CHANGED');
  return {status,sourceSha:ref.object.sha};
}

export async function fetchState(root,repository,token,targetRef='steward/release-state',{governanceAppId,fetcher=fetch,includeHistory=targetRef!=='steward/release-state',centralFirstUse=false}={}) {
  const io=nativeEvidenceTransport(token,fetcher),remote=`https://github.com/${repository.full_name}.git`;
  if(centralFirstUse) {
    if(repository.id!==1296724484||repository.full_name!=='splrad/steward'||!['steward/release-state','steward/automation-health'].includes(targetRef))throw new Error('RELEASE_CENTRAL_STATE_IDENTITY');
    const response=await io.request('GET','/repos/splrad/steward');
    if(response.status!==200)throw new Error('RELEASE_CENTRAL_STATE_UNAVAILABLE');
    const actual=JSON.parse(Buffer.from(response.bytes).toString('utf8'));
    if(actual.id!==repository.id||actual.full_name!==repository.full_name||actual.default_branch!==repository.default_branch||actual.archived!==false||actual.disabled!==false)throw new Error('RELEASE_CENTRAL_STATE_IDENTITY');
  }
  if(targetRef==='steward/governance-state')await assertQualityProtection(qualityNativeIO(repository.full_name,token,fetcher),repository.full_name,governanceAppId);
  else await assertReleaseWriterProtection(repository.full_name,targetRef,io,{token,fetcher});
  const response=await io.request('GET',`/repos/${repository.full_name}/git/ref/heads/${targetRef}`);
  // Only these two fixed central consumers may start with no records. No branch
  // is seeded: the first real maintenance fact or health summary creates it.
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
export async function recordCentralHealth({refresh,summary,repository,controllerSha,runId,runAttempt,directory,token},write=writeReleaseRecords) {
  if(repository.id!==1296724484||repository.full_name!=='splrad/steward')throw new Error('RELEASE_HEALTH_REPOSITORY');
  const state=await refresh();
  if(state.snapshot.repositoryId!==repository.id||state.snapshot.targetRef!=='steward/automation-health')throw new Error('RELEASE_HEALTH_STATE_IDENTITY');
  const old=state.snapshot.head===null?null:await state.readBytes('health.json');
  const prior=old===null?null:JSON.parse(old.toString('utf8'));
  if(prior?.observedAt.slice(0,10)===summary.observedAt.slice(0,10)
    &&(prior.scanCompletedAt===null)===(summary.scanCompletedAt===null)
    &&JSON.stringify(prior.errorCodes)===JSON.stringify(summary.errorCodes)&&JSON.stringify(prior.counts)===JSON.stringify(summary.counts))return {status:'UNCHANGED'};
  const response=await state.io.request('GET',`/repos/splrad/steward/actions/runs/${runId}`);
  if(response.status!==200)throw new Error('RELEASE_HEALTH_RUN_UNAVAILABLE');
  const run=JSON.parse(Buffer.from(response.bytes).toString('utf8'));
  if(run.id!==runId||run.run_attempt!==runAttempt||run.repository?.id!==repository.id||run.head_repository?.id!==repository.id
    ||run.path!=='.github/workflows/release.yml'||run.head_sha!==controllerSha||run.head_branch!==repository.default_branch
    ||!['schedule','workflow_dispatch'].includes(run.event))throw new Error('RELEASE_HEALTH_RUN_IDENTITY');
  const content=JSON.stringify({schemaVersion:1,workflowId:run.workflow_id,runId:run.id,runAttempt:run.run_attempt,controllerSha,...summary},null,2)+'\n';
  const written=await write({directory,remote:state.remote,repositoryId:repository.id,defaultBranch:repository.default_branch,targetRef:'steward/automation-health',writer:'health',
    expectedHead:state.snapshot.head,allowedPaths:['health.json'],changes:[{path:'health.json',content,sha256:hash(content),previousSha256:old===null?null:hash(old)}],identity},{token});
  if(!['APPLIED','UNCHANGED'].includes(written.status))throw new Error('RELEASE_HEALTH_WRITE_UNCONFIRMED');
  const after=await refresh();
  if(after.snapshot.head!==written.head||!after.snapshot.currentPaths.includes('health.json')||(await after.readBytes('health.json')).toString('utf8')!==content)throw new Error('RELEASE_HEALTH_READBACK');
  return written;
}

export async function main() {
  // Trusted central default-branch execution only. Workflow inputs cannot choose a target or credential scope.
  if(process.env.GITHUB_REPOSITORY!=='splrad/steward'||process.env.GITHUB_REPOSITORY_ID!=='1296724484'||process.env.GITHUB_REF!==`refs/heads/${process.env.STEWARD_DEFAULT_BRANCH}`
    || !['schedule','workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME??'')||!/^[a-f0-9]{40}$/.test(process.env.STEWARD_CONTROLLER_SHA??''))throw new Error('RELEASE_CENTRAL_IDENTITY');
  const root=await mkdtemp(join(tmpdir(),'steward-release-wake-'));
  try {
    const app=await nativeReleaseApp(process.env.STEWARD_APP_PRIVATE_KEY??''),controllerSha=process.env.STEWARD_CONTROLLER_SHA;
    const summary=await coordinateReleaseWake({
      maintenance:()=>app.forRepository(1296724484,async token=>{
        const repository={id:1296724484,full_name:'splrad/steward',default_branch:process.env.STEWARD_DEFAULT_BRANCH};
        const writeDirectory=await mkdtemp(join(root,'maintenance-writes-'));
        const store=maintenanceGitStore({refresh:()=>fetchState(root,repository,token,'steward/release-state',{includeHistory:true,centralFirstUse:true}),writeDirectory,defaultBranch:repository.default_branch,token,identity});
        return serviceMaintenance({io:nativeEvidenceTransport(token),store,defaultBranch:repository.default_branch,
          coordinator:{runId:Number(process.env.GITHUB_RUN_ID),runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT),controllerSha}});
      }),discover:()=>app.discover(),
      pages:repository=>app.forPagesRepository(repository.id,async token=>{
        const {governanceAppId}=JSON.parse(await readFile(new URL('../config/review/quality-language.json',import.meta.url),'utf8'));
        const writeDirectory=await mkdtemp(join(root,'pages-writes-'));
        const store=pagesGitStore({repositoryId:repository.id,refresh:()=>fetchState(root,repository,token,'steward/governance-state',{governanceAppId}),
          writeDirectory,defaultBranch:repository.default_branch,token,identity});
        return servicePages({io:nativeEvidenceTransport(token),repository,store,appBotId:app.appBotId,token,
          coordinator:{runId:Number(process.env.GITHUB_RUN_ID),runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT),controllerSha}});
      }),
      observe:repository=>app.forRepository(repository.id,async token=>{
        const participation=await releaseParticipation(repository,nativeEvidenceTransport(token));
        if(participation.status==='NOT_APPLICABLE')return participation;
        const state=await fetchState(root,repository,token);
        // Per-operation read receipts retain backoff; an old channel wait must not suppress candidate preparation.
        return {lastServedAt:state.lastServedAt,nextCheckAt:null};
      }),
      service:repository=>app.forRepository(repository.id,async token=>{
        if((await releaseParticipation(repository,nativeEvidenceTransport(token))).status!=='APPLICABLE')throw new Error('RELEASE_PARTICIPATION_CHANGED');
        const writeDirectory=await mkdtemp(join(root,'writes-'));let state;
        const request={directory:'',writeDirectory,remote:`https://github.com/${repository.full_name}.git`,repository:repository.full_name,repositoryId:repository.id,
          defaultBranch:repository.default_branch,appBotId:app.appBotId,cycleId:null,runId:null,identity};
        const refresh=async()=>{state=await fetchState(root,repository,token);request.directory=state.directory;return state.snapshot;};
        const centralTransport=nativeEvidenceTransport(process.env.STEWARD_CENTRAL_TOKEN);
        const centralIo={request:(method,path,...args)=>{if(method!=='GET'||!path.startsWith('/repos/splrad/steward/'))throw new Error('RELEASE_CENTRAL_READ_ONLY');return centralTransport.request(method,path,...args);}};
        const result=await serviceReleaseWake(request,refresh,async(command,input)=>command==='candidate'
          ? app.forCandidateRepository(repository.id,(candidateToken,candidateReadToken)=>releaseCommand(command,{...input,directory:request.directory},
            {token:candidateToken,io:state.io,centralIo,candidateReadToken,copilotToken:process.env.STEWARD_COPILOT_TOKEN,controllerSha,controllerDirectory:process.cwd()}))
          : releaseCommand(command,{...input,directory:request.directory},{token,io:state.io,centralIo,controllerDirectory:process.cwd(),
            centralInvocation:{runId:Number(process.env.GITHUB_RUN_ID),runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT),controllerSha,defaultBranch:process.env.STEWARD_DEFAULT_BRANCH}}));
        await refresh();
        const old=await state.readBytes('state.json'),current=state.snapshot.repository;
        const base=await state.io.request('GET',`/repos/${repository.full_name}/commits/${encodeURIComponent(repository.default_branch)}`);
        if(base.status!==200)throw new Error('RELEASE_DEFAULT_BRANCH_UNAVAILABLE');
        const source=JSON.parse(Buffer.from(base.bytes).toString('utf8')).sha;if(!/^[a-f0-9]{40}$/.test(source))throw new Error('RELEASE_DEFAULT_BRANCH_IDENTITY');
        const nextCheckAt=[current.nextCheckAt,result.nextCheckAt].filter(Boolean).sort().at(-1)??null;
        const content=JSON.stringify({...current,revision:current.revision+1,lastObservedDefaultSha:source,nextCheckAt,lastErrorCode:result.status==='UNKNOWN'?'native-evidence-required':current.lastErrorCode},null,2)+'\n';
        const written=await writeReleaseRecords({directory:join(writeDirectory,'service'),remote:request.remote,repositoryId:repository.id,defaultBranch:repository.default_branch,
          targetRef:'steward/release-state',writer:'release',expectedHead:state.snapshot.head,allowedPaths:['state.json'],changes:[{path:'state.json',content,sha256:hash(content),previousSha256:hash(old)}],identity},{token});
        if(!['APPLIED','UNCHANGED'].includes(written.status))throw new Error('RELEASE_SERVICE_RECORD_UNCONFIRMED');
        return result;
      }),
      health:summary=>app.forRepository(1296724484,async token=>{
        const repository={id:1296724484,full_name:'splrad/steward',default_branch:process.env.STEWARD_DEFAULT_BRANCH};
        const parent=await mkdtemp(join(root,'health-'));
        return recordCentralHealth({refresh:()=>fetchState(root,repository,token,'steward/automation-health',{centralFirstUse:true}),summary,repository,controllerSha,
          runId:Number(process.env.GITHUB_RUN_ID),runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT),directory:join(parent,'write'),token});
      })});
    // Public output contains only counts and fixed codes. Private repository data remains in per-repository temporary contexts.
    process.stdout.write(JSON.stringify(summary)+'\n');
    if(summary.scanCompletedAt===null||summary.counts.failed||summary.counts.unknown)process.exitCode=75;
  }finally {await rm(root,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{process.stderr.write('RELEASE_COORDINATOR_UNAVAILABLE\n');process.exitCode=75;});
