import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,mkdir,readFile,open} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {TagName} from 'release-please/build/src/util/tag-name.js';
import {Version} from 'release-please/build/src/version.js';
import {isolatedBuildEnvironment,parseDeliveryConfig,NativeEvidenceReader,nativeEvidenceTransport,
  inspectNativeCycle,inspectPublications,decodeReleaseRecord,assertRepositoryWrite,nativePythonSourceVersion} from '../packages/runner/dist/index.js';

const fail=reason=>{throw new Error('RELEASE_ADOPTION: '+reason);};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const digest=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>a?.sourceSha===b?.sourceSha&&a?.prNumber===b?.prNumber;

/** Shared adopted/current product configuration contract. */
export function validateReleaseConfiguration(delivery,settings,versions) {
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const paths=delivery.units.map(u=>u.path).sort();
  if(!object(settings)||settings['separate-pull-requests']!==false||!object(settings.packages)
    ||JSON.stringify(Object.keys(settings.packages).sort())!==JSON.stringify(paths)
    ||!object(versions)||Object.keys(versions).some(path=>!paths.includes(path)))fail('adopted configuration');
  for(const path of paths) {
    if(!object(settings.packages[path]))fail('adopted configuration');
    if(Object.hasOwn(versions,path)) {
      if(typeof versions[path]!=='string')fail('adopted configuration');
      try {if(Version.parse(versions[path]).toString()!==versions[path])fail('adopted configuration');}catch{fail('adopted configuration');}
    }
  }
}

/** A/P comes only from the merged onboarding PR. The source history is never truncated at A for first-release generation. */
export async function withReleaseAdoption(request,adoption,io,operation) {
  if(!adoption||!sha(adoption.sourceSha)||!Number.isSafeInteger(adoption.prNumber)||adoption.prNumber<1
    ||!isAbsolute(request.directory)||!Number.isSafeInteger(request.repositoryId)||request.repositoryId<1
    ||!Number.isSafeInteger(request.appBotId)||request.appBotId<1
    ||!/^\w[\w.-]*\/\w[\w.-]*$/.test(request.repository)||!request.defaultBranch)fail('input identity');
  const reader=new NativeEvidenceReader(io,request.repository),repo=await reader.json('');
  if(repo.id!==request.repositoryId||repo.full_name!==request.repository||repo.default_branch!==request.defaultBranch||repo.archived!==false||repo.disabled!==false)fail('repository identity');
  const pull=await reader.json(`pulls/${adoption.prNumber}`);
  const checkPull=value=>value.number===adoption.prNumber&&value.merged===true&&value.merge_commit_sha===adoption.sourceSha
    &&value.base?.ref===request.defaultBranch&&value.base?.repo?.id===request.repositoryId&&value.head?.repo?.id===request.repositoryId;
  if(!checkPull(pull))fail('merged adoption PR');
  const defaultHead=(await reader.json(`commits/${encodeURIComponent(request.defaultBranch)}`)).sha;
  if(!sha(defaultHead))fail('default head');
  const home=await mkdtemp(join(tmpdir(),'steward-adoption-read-'));
  try {
    const env=isolatedBuildEnvironment(process.env,home);
    const gitBytes=async(...args)=>(await promisify(execFile)('git',['--no-replace-objects','--no-optional-locks','-c','core.hooksPath=','-c','core.fsmonitor=false',...args],
      {cwd:request.directory,env,encoding:'buffer',windowsHide:true,timeout:30_000,maxBuffer:64*1024*1024})).stdout;
    const git=async(...args)=>(await gitBytes(...args)).toString('utf8').trim();
    if(await git('rev-parse','--is-shallow-repository')!=='false')fail('full source history required');
    await git('merge-base','--is-ancestor',adoption.sourceSha,defaultHead);
    const fileBytes=async(commit,path)=>{
      if(!sha(commit)||typeof path!=='string'||path.startsWith('/')||/[\0\\:]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))fail('source path');
      const entry=await git('ls-tree',commit,'--',path);
      if(!/^100644 blob [a-f0-9]{40}\t/.test(entry))fail('source file required');
      return gitBytes('show',`${commit}:${path}`);
    };
    const file=async(commit,path)=>(await fileBytes(commit,path)).toString('utf8').trim();
    const settings=JSON.parse(await file(adoption.sourceSha,'release-please-config.json'));
    const manifest=JSON.parse(await file(adoption.sourceSha,'.release-please-manifest.json'));
    const delivery=parseDeliveryConfig(JSON.parse(await file(adoption.sourceSha,'.github/delivery.json')));
    validateReleaseConfiguration(delivery,settings,manifest);
    for(const path of ['.github/workflows/steward-release-publish.yml','.github/workflows/steward-release-channels.yml','.github/release-template.md.mustache'])await file(adoption.sourceSha,path);
    if(request.repositoryId===1187527897) {
      if(request.repository!=='splrad/LayerScape'||Object.keys(manifest).length||settings.packages?.['.']?.['initial-version']!=='1.0.0'
        ||['bootstrap-sha','draft','force-tag-creation'].some(key=>Object.hasOwn(settings,key)||Object.hasOwn(settings.packages['.'],key)))fail('LayerScape first-release configuration');
    }
    const reachable=(await git('rev-list','--reverse',`${adoption.sourceSha}..${defaultHead}`)).split('\n').filter(Boolean);
    if(!reachable.every(sha))fail('reachable history');
    const verifySource=async(pr,cycle)=>{
      const S=pr.merge_commit_sha;
      const config=JSON.parse(await file(S,'release-please-config.json')),versions=JSON.parse(await file(S,'.release-please-manifest.json'));
      const sourceDelivery=parseDeliveryConfig(JSON.parse(await file(S,'.github/delivery.json')));
      // Historical recovery verifies the obligations frozen at S. Current product
      // onboarding requirements are enforced before admitting a new candidate.
      if(!cycle||cycle.sourceSha!==S||cycle.prNumber!==pr.number)fail('original cycle required');
      for(const target of cycle.units) {
        const unit=sourceDelivery.units.find(value=>value.id===target.id);
        if(!unit||versions[unit.path]!==target.version||!config.packages?.[unit.path])fail('native unit version');
        const options={...config,...config.packages[unit.path]},component=options['include-component-in-tag']===false?undefined:options.component;
        if(options['include-component-in-tag']!==false&&!component)fail('tag component');
        if(new TagName(Version.parse(target.version),component,options['tag-separator'],options['include-v-in-tag']).toString()!==target.tag)fail('native tag');
        const unitPath=path=>unit.path==='.'?path:`${unit.path}/${path}`;
        if(options['release-type']==='simple') {if(await file(S,unitPath(options['version-file']))!==target.version)fail('native VERSION');}
        else if(options['release-type']==='node') {if(JSON.parse(await file(S,unitPath('package.json'))).version!==target.version)fail('native package version');}
        else if(options['release-type']==='python') {
          await nativePythonSourceVersion(fileURLToPath(new URL('..',import.meta.url)),await fileBytes(S,unitPath('pyproject.toml')),target.version);
        }
        else fail('native version adapter required');
      }
      return true;
    };
    const result=await operation({reader,git,file,defaultHead,reachable,releaseAdoption:adoption,verifySource});
    if(!checkPull(await reader.json(`pulls/${adoption.prNumber}`))||(await reader.json(`commits/${encodeURIComponent(request.defaultBranch)}`)).sha!==defaultHead)fail('adoption source moved');
    return result;
  }finally{await rm(home,{recursive:true,force:true});}
}

async function verifyCurrentEvidence(request,snapshot,io,centralIo,now) {
  for(const {value:cycle} of snapshot.cycles) {
    const context={repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle};
    const publications=snapshot.domainRecords.filter(r=>r.path.startsWith('evidence/publication/')&&r.value.cycleId===cycle.id);
    const publication=centralIo?await inspectPublications(context,publications,io,centralIo,now()):undefined;
    const evidence=await inspectNativeCycle(context,snapshot.domainRecords.filter(r=>r.path.startsWith('evidence/native/')),io,now(),
      {complete:true,publication,observations:snapshot.domainRecords.filter(r=>r.path.startsWith('evidence/reads/')).map(r=>r.value),
        retryLimits:snapshot.domainRecords.filter(r=>r.path.startsWith('evidence/retry-limit/')),sourceRejections:snapshot.domainRecords.filter(r=>r.path.startsWith('evidence/source-rejection/')),
        channelEvidence:snapshot.domainRecords.filter(r=>r.path.startsWith('evidence/channel/')||r.path.startsWith('evidence/channel-read/'))});
    if(evidence.currentFacts.unknownEvidence.length||evidence.currentFacts.conflictEvidence.length||evidence.currentFacts.inFlightWaveKeys.length||evidence.readObservation.disposition!=='COMPLETE')fail('original native evidence unknown');
  }
}

/** Restore original cache bytes only. No empty state, new cycle or completion fact can be invented here. */
export async function recoverReleaseCaches(request,snapshot,{token,io=nativeEvidenceTransport(token),centralIo,now=()=>new Date().toISOString()}={}) {
  const missing=!snapshot.repository || snapshot.history.some(record=>record.status!=='DECODED')
    || snapshot.repository.activeCycleId && !snapshot.cycles.some(record=>record.value.id===snapshot.repository.activeCycleId)
    || snapshot.repository.lastCompletedCycleId && !snapshot.cycles.some(record=>record.value.id===snapshot.repository.lastCompletedCycleId);
  if(missing) {
    const {readReleaseRecords}=await import('./release-record.mjs');
    snapshot=await readReleaseRecords({directory:request.directory,targetRef:'steward/release-state',repositoryId:request.repositoryId,includeHistory:true});
  }
  if(snapshot.history.some(r=>r.path.startsWith('cycles/')&&!snapshot.cycles.some(c=>r.path===`cycles/${c.value.id}.json`)))fail('original cycle record unavailable');
  const paths=['state.json',...snapshot.cycles.map(r=>`cycles/${r.value.id}.json`)];
  const damaged=paths.filter(path=>!snapshot.history.some(r=>r.commit===snapshot.head&&r.path===path&&r.status==='DECODED'));
  if(!damaged.length)return {snapshot,directory:request.directory};
  assertRepositoryWrite(snapshot.repository);
  const {writeReleaseRecords,readReleaseRecords,assertReleaseWriterProtection}=await import('./release-record.mjs');
  return withReleaseAdoption(request,snapshot.repository.releaseAdoption,io,async proof=>{
    for(const {value:cycle} of snapshot.cycles) {
      const pr=await proof.reader.json(`pulls/${cycle.prNumber}`);
      if(!pr.merged||pr.user?.id!==request.appBotId||pr.base?.repo?.id!==request.repositoryId||pr.head?.repo?.id!==request.repositoryId
        ||pr.base?.ref!==request.defaultBranch||!proof.reachable.includes(pr.merge_commit_sha))fail('recovery source identity');
      await proof.verifySource(pr,cycle);
    }
    await verifyCurrentEvidence(request,snapshot,io,centralIo,now);
    const changes=[];
    const bytes=async oid=>{const blob=await proof.reader.json(`git/blobs/${oid}`);if(blob.encoding!=='base64')fail('recovery blob encoding');return Buffer.from(blob.content,'base64');};
    for(const path of damaged) {
      const original=snapshot.history.find(r=>r.path===path&&r.status==='DECODED');if(!original)fail('original record unavailable');
      const current=snapshot.history.find(r=>r.path===path&&r.commit===snapshot.head),content=(await bytes(original.blobSha)).toString('utf8');
      changes.push({path,content,sha256:digest(content),previousSha256:current?digest(await bytes(current.blobSha)):null});
    }
    if((await proof.reader.json('git/ref/heads/steward/release-state')).object?.sha!==snapshot.head)fail('recovery ref moved');
    await assertReleaseWriterProtection(request.repository,'steward/release-state',io,{token});
    await mkdir(request.writeDirectory,{recursive:true});const directory=join(request.writeDirectory,'recover-'+digest(JSON.stringify([snapshot.head,changes])));
    const written=await writeReleaseRecords({directory,remote:request.remote,repositoryId:request.repositoryId,defaultBranch:request.defaultBranch,
      targetRef:'steward/release-state',writer:'release',expectedHead:snapshot.head,allowedPaths:changes.map(f=>f.path),changes,identity:request.identity},{token});
    if(!['APPLIED','UNCHANGED'].includes(written.status))fail('recovery write unconfirmed');
    const back=await readReleaseRecords({directory,targetRef:'steward/release-state',repositoryId:request.repositoryId});
    if(back.head!==written.head||(await proof.reader.json('git/ref/heads/steward/release-state')).object?.sha!==written.head
      ||JSON.stringify(back.repository)!==JSON.stringify(snapshot.repository))fail('recovery readback');
    // Keep the product's complete source objects available to subsequent A..D/S checks.
    await proof.git('fetch','--no-tags','--no-recurse-submodules',directory,'refs/heads/steward/release-state');
    if(await proof.git('rev-parse','FETCH_HEAD')!==back.head)fail('recovery local ref');
    await proof.git('update-ref','refs/heads/steward/release-state',back.head,snapshot.head);
    return {snapshot:back,directory:request.directory};
  });
}

/** Explicit E10/E11 entry, never called by fetchState or the ordinary coordinator. */
export async function initializeReleaseAdoption(request,{token,io=nativeEvidenceTransport(token),centralIo,fetcher=fetch,now=()=>new Date().toISOString()}={}) {
  const keys=['directory','writeDirectory','remote','repository','repositoryId','defaultBranch','appBotId','identity','releaseAdoption'];
  if(Object.keys(request).sort().join()!==keys.sort().join()||!isAbsolute(request.writeDirectory)
    ||request.remote!==`https://github.com/${request.repository}.git`&&!isAbsolute(request.remote))fail('closed request');
  const {readReleaseRecords,writeReleaseRecords,assertReleaseWriterProtection}=await import('./release-record.mjs');
  return withReleaseAdoption(request,request.releaseAdoption,io,async proof=>{
    const response=await io.request('GET',`/repos/${request.repository}/git/ref/heads/steward/release-state`);
    if(![200,404].includes(response.status))fail('state visibility unknown');
    let snapshot=null;
    if(response.status===200) {
      snapshot=await readReleaseRecords({directory:request.directory,targetRef:'steward/release-state',repositoryId:request.repositoryId,includeHistory:true});
      if(snapshot.head!==JSON.parse(Buffer.from(response.bytes).toString('utf8')).object?.sha||!snapshot.repository)fail('state source unknown');
      if(snapshot.repository.schemaVersion===3) {
        if(!same(snapshot.repository.releaseAdoption,request.releaseAdoption))return {status:'CONFLICT',reason:'RELEASE_ADOPTION_CHANGED'};
        return {status:'UNCHANGED',head:snapshot.head,releaseAdoption:snapshot.repository.releaseAdoption};
      }
    } else {
      // A deleted local/native record cannot be reinterpreted as a new repository.
      if((await proof.git('for-each-ref','--format=%(refname)','refs/heads/steward/release-state')).trim())fail('missing adopted state requires recovery');
    }
    const view=snapshot??{head:null,cycles:[],domainRecords:[],repositoryHistory:[]};
    const closed=await proof.reader.pages('pulls?state=closed&sort=created&direction=asc','');
    const all=new Map(closed.map(pr=>[pr.number,pr]));
    for(const commit of proof.reachable)for(const pr of await proof.reader.pages(`commits/${commit}/pulls`,''))all.set(pr.number,pr);
    const candidates=view.repositoryHistory.flatMap(r=>r.value.candidate?[r.value.candidate]:[]);
    const branches=new Set(['steward/release-candidate',...candidates.map(c=>c.branch)]),discovered=new Set();
    for(const listed of all.values()) {
      if(!branches.has(listed.head?.ref)&&!candidates.some(c=>c.prNumber===listed.number))continue;
      const pr=await proof.reader.json(`pulls/${listed.number}`);
      if(!pr.merged||!proof.reachable.includes(pr.merge_commit_sha))continue;
      if(pr.user?.id!==request.appBotId||pr.base?.repo?.id!==request.repositoryId||pr.head?.repo?.id!==request.repositoryId||pr.base?.ref!==request.defaultBranch||!branches.has(pr.head?.ref))fail('obligation identity');
      const cycle=view.cycles.find(r=>r.value.prNumber===pr.number&&r.value.sourceSha===pr.merge_commit_sha)?.value;
      await proof.verifySource(pr,cycle);discovered.add(cycle.id);
    }
    if(view.cycles.some(r=>!discovered.has(r.value.id)))fail('original obligation outside adopted history');
    if(!snapshot) {
      const releases=await proof.reader.pages('releases',''),tags=await proof.reader.pages('tags','');
      if(releases.length||tags.length||discovered.size)fail('unrecorded release obligations');
    }
    await verifyCurrentEvidence(request,view,io,centralIo,now);
    const previous=snapshot?.repository;
    const repository=previous?{...previous,schemaVersion:3,releaseAdoption:request.releaseAdoption,revision:previous.revision+1}
      :{schemaVersion:3,repositoryId:request.repositoryId,defaultBranch:request.defaultBranch,revision:0,releaseAdoption:request.releaseAdoption,
        lastObservedDefaultSha:request.releaseAdoption.sourceSha,lastCompletedCycleId:null,activeCycleId:null,candidate:null,nextCheckAt:null,lastProgressAt:null,lastErrorCode:null};
    const content=JSON.stringify(repository,null,2)+'\n';decodeReleaseRecord('repository',Buffer.from(content));assertRepositoryWrite(repository,previous);
    await assertReleaseWriterProtection(request.repository,'steward/release-state',io,{token,fetcher});
    if((await proof.reader.json(`commits/${encodeURIComponent(request.defaultBranch)}`)).sha!==proof.defaultHead)fail('default head moved');
    const current=await io.request('GET',`/repos/${request.repository}/git/ref/heads/steward/release-state`);
    if(current.status!==response.status||current.status===200&&JSON.parse(Buffer.from(current.bytes).toString()).object?.sha!==snapshot.head)fail('state moved');
    await mkdir(request.writeDirectory,{recursive:true});const directory=join(request.writeDirectory,'adoption-'+digest(content));
    // Hash exact bytes, not the trimmed text used for source validation.
    const prior=snapshot?(await promisify(execFile)('git',['--no-replace-objects','show',`${snapshot.head}:state.json`],{cwd:request.directory,encoding:'buffer',windowsHide:true})).stdout:null;
    const written=await writeReleaseRecords({directory,remote:request.remote,repositoryId:request.repositoryId,defaultBranch:request.defaultBranch,
      targetRef:'steward/release-state',writer:'release',expectedHead:snapshot?.head??null,allowedPaths:['state.json'],
      changes:[{path:'state.json',content,sha256:digest(content),previousSha256:prior?digest(prior):null}],identity:request.identity},{token});
    if(!['APPLIED','UNCHANGED'].includes(written.status))return written;
    const back=await readReleaseRecords({directory,targetRef:'steward/release-state',repositoryId:request.repositoryId});
    if(back.head!==written.head||JSON.stringify(back.repository)!==JSON.stringify(repository)
      ||(await proof.reader.json('git/ref/heads/steward/release-state')).object?.sha!==written.head)fail('adoption readback');
    return {status:written.status,head:written.head,releaseAdoption:repository.releaseAdoption,migrated:!!previous};
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  if(args.length!==4||args[0]!=='--input'||args[2]!=='--output')fail('arguments');
  const input=JSON.parse(await readFile(args[1],'utf8')),output=await open(args[3],'wx',0o600);
  try {const result=await initializeReleaseAdoption(input,{token:process.env.STEWARD_STATE_TOKEN});await output.writeFile(JSON.stringify(result,null,2)+'\n');
    if(!['APPLIED','UNCHANGED'].includes(result.status))process.exitCode=75;
  }finally{await output.close();}
}
