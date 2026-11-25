import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeEvidenceTransport, isolatedBuildEnvironment, parseDeliveryConfig,assertProductDelivery,verifyDispatchWorkflow,encodeRepositoryPath,applyWorkflowDelivery,assertRegisteredAdapters } from '../packages/runner/dist/index.js';
import { readReleaseRecords, assertReleaseWriterProtection } from './release-record.mjs';
import {servicePages,pagesGitStore} from './pages-maintenance.mjs';
import {assertQualityProtection,qualityNativeIO} from './quality-language-summary.mjs';
import {validateReleaseConfiguration} from './release-adoption.mjs';
import {mergedRepositoryPolicy} from './repository-policy-read.mjs';

const identity={name:'splrad-steward[bot]',email:'301115370+splrad-steward[bot]@users.noreply.github.com'};
const isGitSha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const validMatchingRefs=(refs,target)=>Array.isArray(refs)
  &&refs.every(r=>typeof r?.ref==='string'&&r.ref.startsWith(`refs/heads/${target}`)&&r.object?.type==='commit'&&isGitSha(r.object.sha))
  &&new Set(refs.map(r=>r.ref)).size===refs.length;

/** Repository visibility is not product enrollment. Only proven absent inputs and obligations are inapplicable. */
export async function releaseParticipation(repository,io,{includeUnits=false,requireWorkflowGitHubDelivery=false}={}) {
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
        &&!(x.type==='blob'&&x.mode==='100644'&&/^maintenance\/(?:[1-9][0-9]*|candidate-draft-[1-9][0-9]*-[a-f0-9]{40})\.json$/.test(x.path)));
  }
  let status='APPLICABLE',absenceFacts=null,units;
  const candidateBranch='release-please--branches--'+repository.default_branch;
  const readCandidate=async()=>{
    const refs=await read('git/matching-refs/heads/'+encodeURIComponent(candidateBranch));
    if(!validMatchingRefs(refs,candidateBranch))throw Error('RELEASE_PARTICIPATION_IDENTITY');
    return refs.find(item=>item.ref==='refs/heads/'+candidateBranch)??null;
  };
  if(files.every(x=>x.length===0)&&!obligation) {
    const candidate=await readCandidate();
    const builds=await read('git/matching-refs/heads/steward/build/');
    const releases=await read('releases?per_page=1');
    if(!Array.isArray(builds)||!Array.isArray(releases))throw Error('RELEASE_PARTICIPATION_INCOMPLETE');
    if(candidate||builds.length||releases.length)throw Error('RELEASE_CONFIGURATION_REQUIRED');
    absenceFacts=[candidate,builds,releases];
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
      const delivery=parseDeliveryConfig(contents[0],contents[1]);assertProductDelivery(delivery);
      validateReleaseConfiguration(delivery,contents[1],contents[2]);
      if(delivery.buildWorkflow!==undefined) {
        const publisher=tree.tree.find(entry=>entry.path===delivery.buildWorkflow);
        if(publisher?.type!=='blob'||publisher.mode!=='100644')throw Error('RELEASE_CONFIGURATION_INVALID');
        const workflow=await readSource(delivery.buildWorkflow,publisher);
        verifyDispatchWorkflow(workflow, {purpose:'build',buildWorkflow:delivery.buildWorkflow,
          inputs:{cycle_id:'',operation_key:'',source_sha:'',controller_sha:''}});
        if(delivery.schemaVersion===3) {
          applyWorkflowDelivery(delivery,workflow);
          assertRegisteredAdapters(repository.id,repository.full_name,delivery);
        }
      }
      if(requireWorkflowGitHubDelivery&&(delivery.schemaVersion!==3||delivery.units.length!==1||
        delivery.units[0].id!=='root'||delivery.units[0].path!=='.'||
        !delivery.units[0].channels.some(channel=>channel.id==='github-release'&&channel.required)))
        throw Error('OFFICIAL_CANDIDATE_GITHUB_DELIVERY');
      if(includeUnits)units=delivery.units.map(({id,path,notesPath})=>({id,path,notesPath}));
    }catch(error){
      if(['AUTHOR_IDENTITY_UNVERIFIED','OFFICIAL_CANDIDATE_GITHUB_DELIVERY'].includes(error.message))throw error;
      throw Error('RELEASE_CONFIGURATION_INVALID');
    }
  }
  if(absenceFacts) {
    const after=[await readCandidate(),await read('git/matching-refs/heads/steward/build/'),await read('releases?per_page=1')];
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
