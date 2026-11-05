import { createHash } from 'node:crypto';
import { decodeNativePublication, type NativePublication } from '../../core/src/native-evidence.js';
import { type NativeAttemptSet, type NativeAttemptEvidence, type ArchivedAttempt } from '../../core/src/release-observation.js';
import { NativeEvidenceReader, formalReleaseReader, nativeRunFact, jobFact, EvidenceReadError, stableReleaseFacts, stableAssetFacts,
  type EvidenceContext, type EvidenceTransport, type EvidenceStore, type ArchiveFile } from './native-release-evidence.js';

const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function check(v:unknown,s:string):asserts v {if(!v)throw new Error('NATIVE_PUBLICATION: '+s);}
export interface PublicationFile {path:string;commit:string;value:NativePublication}
export interface CentralInvocation {runId:number;runAttempt:number;controllerSha:string;defaultBranch:string}
const central='splrad/steward',centralId=1296724484;
export function publicationFile(value:NativePublication):ArchiveFile {
  const content=JSON.stringify(value)+'\n',sha256=hash(content);decodeNativePublication(Buffer.from(content));
  return {path:`evidence/publication/${sha256}.json`,content,sha256};
}
function targets(context:EvidenceContext) {
  return context.cycle.units.map(unit=>{
    check(unit.manifestDigest&&unit.notesDigest&&unit.assets.length,'frozen publication input required');
    return {unitId:unit.id,tag:unit.tag,manifestDigest:unit.manifestDigest,bodyDigest:unit.notesDigest};
  }).sort((a,b)=>a.unitId.localeCompare(b.unitId));
}
function validate(context:EvidenceContext,file:PublicationFile) {
  const value=decodeNativePublication(Buffer.from(JSON.stringify(file.value)));
  check(/^[a-f0-9]{40}$/.test(file.commit)&&publicationFile(value).path===file.path&&value.repositoryId===context.repositoryId
    &&value.cycleId===context.cycle.id&&value.sourceSha===context.cycle.sourceSha&&same(value.targets,targets(context))
    &&value.targetsDigest===hash(JSON.stringify(value.targets)),'protected publication provenance');
  check(value.centralRun.repositoryId===centralId&&value.centralRun.headRepositoryId===centralId
    &&value.centralRun.path==='.github/workflows/release.yml'&&['schedule','workflow_dispatch'].includes(value.centralRun.event),'central source');
  return value;
}
async function centralAttempt(io:EvidenceTransport,id:number,attempt:number,expected?:CentralInvocation) {
  const reader=new NativeEvidenceReader(io,central),run=nativeRunFact(await reader.json(`actions/runs/${id}/attempts/${attempt}`));
  const repository=await reader.json(''),workflow=await reader.json(`actions/workflows/${run.workflowId}`);
  check(repository.id===centralId&&repository.full_name===central&&repository.archived===false&&repository.disabled===false
    &&run.id===id&&run.runAttempt===attempt&&run.repositoryId===centralId&&run.headRepositoryId===centralId
    &&run.path==='.github/workflows/release.yml'&&workflow.id===run.workflowId&&workflow.path===run.path
    &&['schedule','workflow_dispatch'].includes(run.event),'native central identity');
  if(expected)check(run.headSha===expected.controllerSha&&run.headBranch===expected.defaultBranch&&repository.default_branch===expected.defaultBranch,'current central source');
  const jobs=(await reader.pages(`actions/runs/${id}/attempts/${attempt}/jobs`,'jobs')).map(jobFact);
  check(jobs.every(job=>job.runId===id&&job.runAttempt===attempt&&job.headSha===run.headSha),'central jobs');
  return {run,jobs,reader};
}
async function objects(context:EvidenceContext,io:EvidenceTransport):Promise<NativePublication['objects']> {
  const reader=new NativeEvidenceReader(io,context.repository),result:NativePublication['objects']=[];
  for(const unit of context.cycle.units) {
    let path=unit.releaseId===null?`releases/tags/${encodeURIComponent(unit.tag)}`:`releases/${unit.releaseId}`;
    const proof:NativePublication['objects'][number]={unitId:unit.id,releaseId:null,status:'UNKNOWN',digest:null,sourceUrl:`https://api.github.com${reader.path(path)}`};
    try {
      let release,discoveredDraft=false;
      try {release=await reader.json(path);}catch(error) {
        if(!(error instanceof EvidenceReadError)||error.status!==404||unit.releaseId!==null)throw error;
        // The tag endpoint exposes published releases; recover an existing draft by its native ID.
        const matches=(await reader.pages('releases','')).filter(value=>value.tag_name===unit.tag);
        if(!matches.length){proof.status='ABSENT';result.push(proof);continue;}
        check(matches.length===1&&Number.isSafeInteger(matches[0].id)&&matches[0].id>0,'ambiguous release identity');
        path=`releases/${matches[0].id}`;release=await reader.json(path);discoveredDraft=true;
        check(release.id===matches[0].id,'discovered release identity');
      }
      proof.releaseId=release.id;proof.sourceUrl=`https://api.github.com${reader.path(path)}`;
      const marker=`<!-- steward-release:${hash(JSON.stringify([context.repositoryId,unit.id,unit.tag,context.cycle.sourceSha,unit.manifestDigest]))} -->`;
      check(Number.isSafeInteger(release.id)&&release.id>0&&release.tag_name===unit.tag&&release.author?.id===context.appBotId
        &&(unit.releaseId===null||release.id===unit.releaseId)&&typeof release.draft==='boolean'&&typeof release.body==='string'
        &&(hash(release.body)===unit.notesDigest||release.draft&&release.body===marker)
        &&(!release.draft||release.target_commitish===context.cycle.sourceSha),'release identity');
      check((await reader.json(`commits/${encodeURIComponent(unit.tag)}`)).sha===context.cycle.sourceSha,'tag source');
      const assetReader=release.draft===false?await formalReleaseReader(context,io):reader;
      check(same(stableReleaseFacts(release),stableReleaseFacts(await assetReader.json(path))),'release visibility changed');
      const assets=await assetReader.pages(`releases/${release.id}/assets`,''),bytes=[];
      for(const asset of assets) {
        const actual=await assetReader.downloadDigest(`releases/assets/${asset.id}`);
        check(actual.size===asset.size&&unit.assets.some(value=>value.path===asset.name&&value.size===actual.size&&value.sha256===actual.digest),'release bytes');
        bytes.push([asset.id,asset.name,actual.size,actual.digest]);
      }
      check(new Set(assets.map(asset=>asset.name)).size===assets.length,'duplicate release asset');
      check(same(stableReleaseFacts(release),stableReleaseFacts(await assetReader.json(path)))&&same(stableAssetFacts(assets),stableAssetFacts(await assetReader.pages(`releases/${release.id}/assets`,''))),'release changed');
      if(discoveredDraft)check(same((await reader.pages('releases','')).filter(value=>value.tag_name===unit.tag).map(value=>value.id),[release.id]),'release inventory changed');
      proof.digest=hash(JSON.stringify([stableReleaseFacts(release),bytes.sort((a,b)=>Number(a[0])-Number(b[0]))]));
      proof.status=release.draft===false&&release.immutable===true&&assets.length===unit.assets.length?'MATCH':'ABSENT';
    }catch(error) {
      if (error instanceof EvidenceReadError && error.status === 404) {
        try {
          const all = await reader.pages('releases','');
          if (!all.some(r => r.tag_name === unit.tag || r.id === unit.releaseId))
            proof.status = unit.releaseId === null ? 'ABSENT' : 'CONFLICT';
        } catch { /* Incomplete visibility is unknown. */ }
      } else if (error instanceof Error && error.message.startsWith('NATIVE_PUBLICATION:')) proof.status = 'CONFLICT';
    }
    result.push(proof);
  }
  return result;
}
function outcome(proofs:NativePublication['objects'],terminal:boolean) {
  return proofs.some(p=>p.status==='CONFLICT')?'FACT_CONFLICT':proofs.some(p=>p.status==='UNKNOWN')?'UNKNOWN':
    proofs.length&&proofs.every(p=>p.status==='MATCH')?'EFFECT_CONFIRMED':terminal?'BUSINESS_FAILED':null;
}
/** Re-read every real central attempt. Only product-private adopted starts prove this product was invoked. */
export async function inspectPublications(context:EvidenceContext,history:PublicationFile[],productIo:EvidenceTransport,centralIo:EvidenceTransport,observedAt:string) {
  const native:NativeAttemptSet={complete:true,runs:[],attempts:[]},files:ArchiveFile[]=[],missing:string[]=[],archived:ArchivedAttempt[]=[];
  const records=history.filter(file=>file.value.cycleId===context.cycle.id).map(file=>({file,value:validate(context,file)}));
  const starts=records.filter(record=>record.value.startEvidencePath===null);
  const ids=[...new Set([...starts.map(record=>record.value.centralRun.id),...context.cycle.publications.map(item=>item.centralRunId)])];
  for(const id of ids) {
    try {
      const reader=new NativeEvidenceReader(centralIo,central);
      let actuals:{run:NativePublication['centralRun'];jobs:NativePublication['job'][]}[]=[],expiredCommit:string|null=null;
      let initialRun:NativePublication['centralRun']|undefined;
      try {
        const latest=nativeRunFact(await reader.json(`actions/runs/${id}`));initialRun=latest;
        for(let attempt=1;attempt<=latest.runAttempt;attempt++) {
          const actual=await centralAttempt(centralIo,id,attempt);actuals.push({run:actual.run,jobs:actual.jobs});
        }
        check(same(latest,nativeRunFact(await reader.json(`actions/runs/${id}`))),'central Run changed');
      }catch(error) {
        const prior=records.filter(r=>r.value.centralRun.id===id&&r.value.attempts.length).sort((a,b)=>b.value.observedAt.localeCompare(a.value.observedAt))[0];
        let expired = (error instanceof EvidenceReadError) && error.status === 410;
        if (prior && (error instanceof EvidenceReadError) && error.status === 404) {
          try{expired=!(await reader.pages(`actions/workflows/${prior.value.centralRun.workflowId}/runs`,'workflow_runs')).some(run=>run.id===id);}catch{/* Read denial is not expiry. */}
        }
        check(expired&&prior&&prior.value.attempts.every(a=>a.run.status==='completed'),'complete expired central history required');
        actuals=prior.value.attempts;expiredCommit=prior.file.commit;
      }
      const latest=actuals.at(-1)!.run;
      const inputDigest=starts.find(record=>record.value.centralRun.id===id)?.value.execution.inputDigest;
      check(inputDigest,'original private start required');
      for(const actual of actuals) {
        const attempt=actual.run.runAttempt,matches=starts.filter(record=>record.value.centralRun.id===id&&record.value.centralRun.runAttempt===attempt);
        check(matches.length<=1,'duplicate central invocation');
        const invocations:NativeAttemptEvidence['invocations']=[],selectedJobs:NativeAttemptEvidence['jobs']=[];
        for(const {file,value:start} of matches) {
          const job=actual.jobs.find(job=>job.id===start.job.id),step=job?.steps.find(step=>step.number===start.stepNumber);
          check(job&&step&&same([actual.run.headSha,actual.run.workflowId,actual.run.createdAt],[start.centralRun.headSha,start.centralRun.workflowId,start.centralRun.createdAt])
            &&step.name===start.job.steps.find(step=>step.number===start.stepNumber)?.name,'publication native step');
          const proofs=await objects(context,productIo),result=outcome(proofs,actual.run.status==='completed');
          const value:NativePublication={...start,observedAt,centralRun:actual.run,job,objects:proofs,attempts:actuals,startEvidencePath:file.path,
            execution:{...start.execution,outcome:result,completedAt:actual.run.status==='completed'?step.completedAt:null,observedAt}};
          const archived=publicationFile(value);files.push(archived);
          const evidence={...value.execution,nativeEvidencePath:file.path,objectEvidencePaths:[archived.path]};
          selectedJobs.push({id:job.id,steps:[step]});invocations.push({jobId:job.id,stepNumber:step.number,evidence});
        }
        if(!expiredCommit)check(same(actual.run,nativeRunFact(await reader.json(`actions/runs/${id}/attempts/${attempt}`)))
          &&same(actual.jobs,(await reader.pages(`actions/runs/${id}/attempts/${attempt}/jobs`,'jobs')).map(jobFact)),'central observation changed');
        const observed:NativeAttemptEvidence={repositoryId:context.repositoryId,cycleId:context.cycle.id,workflowId:latest.workflowId,runId:id,runAttempt:attempt,entry:'publish',
          sourceSha:context.cycle.sourceSha,inputDigest,executorControllerSha:actual.run.headSha,actorId:actual.run.actorId,status:matches.length?actual.run.status:'completed',
          observedAt,jobsComplete:true,jobs:selectedJobs,invocations,sourceUrl:`https://api.github.com/repos/${central}/actions/runs/${id}/attempts/${attempt}`,evidenceDigest:hash(JSON.stringify(actual))};
        if(expiredCommit)archived.push({stateCommit:expiredCommit,rawDigest:hash(JSON.stringify(observed)),attempt:observed});else native.attempts.push(observed);
      }
      if(!expiredCommit)check(same(initialRun,nativeRunFact(await reader.json(`actions/runs/${id}`))),'central Run changed');
      native.runs.push({runId:id,workflowId:latest.workflowId,entry:'publish',sourceSha:context.cycle.sourceSha,inputDigest,actorId:latest.actorId,latestAttempt:latest.runAttempt,availability:expiredCommit?'expired':'live'});
    }catch{native.complete=false;missing.push(`publication:${id}:native-evidence`);}
  }
  return {native,files,missing,archived};
}
/** Fixed E06 publisher boundary: adopted private start and readback precede the first business API write. */
export async function invokePublication(context:EvidenceContext,current:CentralInvocation,history:PublicationFile[],store:EvidenceStore,
  productIo:EvidenceTransport,centralIo:EvidenceTransport,publish:()=>Promise<void>,observedAt:string,clock=()=>new Date().toISOString()) {
  if(history.some(file=>validate(context,file).centralRun.id===current.runId&&file.value.centralRun.runAttempt===current.runAttempt))
    return {status:'WAIT',reason:'PUBLICATION_ALREADY_INVOKED',publishInvoked:false};
  const actual=await centralAttempt(centralIo,current.runId,current.runAttempt,current),jobs=actual.jobs.filter(job=>job.name==='release-coordinator');
  check(jobs.length===1&&actual.run.status==='in_progress','current central invocation');
  const job=jobs[0]!,steps=job.steps.filter(step=>step.name==='business-release-coordinator'&&step.startedAt!==null&&step.completedAt===null);
  check(steps.length===1,'current business step');const step=steps[0]!,set=targets(context),targetsDigest=hash(JSON.stringify(set));
  const inputDigest=hash(JSON.stringify([context.repositoryId,context.cycle.id,context.cycle.sourceSha,targetsDigest]));
  const start:NativePublication={schemaVersion:1,repositoryId:context.repositoryId,cycleId:context.cycle.id,sourceSha:context.cycle.sourceSha,observedAt,
    centralRun:actual.run,job,stepNumber:step.number,startEvidencePath:null,targets:set,targetsDigest,objects:[],attempts:[],execution:{repositoryId:context.repositoryId,
      cycleId:context.cycle.id,workflowId:actual.run.workflowId,runId:actual.run.id,runAttempt:actual.run.runAttempt,entry:'publish',jobId:job.id,unitId:null,channelId:null,
      invocationKey:hash(JSON.stringify([context.repositoryId,context.cycle.id,actual.run.id,actual.run.runAttempt,'publish'])),inputDigest,startedAt:observedAt,
      businessStartedProven:true,nativeEvidencePath:'evidence/publication/start.json',outcome:null,completedAt:null,objectEvidencePaths:[],observedAt}};
  const file=publicationFile(start),saved=await store.archive([file]);
  if(!['APPLIED','UNCHANGED'].includes(saved.status)||!saved.head||!saved.files?.some(value=>value.path===file.path&&value.content===file.content))
    return {status:'UNKNOWN',reason:'PUBLICATION_START_NOT_ADOPTED',publishInvoked:false};
  // An unchanged receipt belongs to a previous invocation; its write response may have been lost.
  if(saved.status!=='APPLIED')return {status:'UNKNOWN',reason:'PUBLICATION_START_ALREADY_ADOPTED',publishInvoked:false};
  const readback=await centralAttempt(centralIo,current.runId,current.runAttempt,current);
  if(!same(actual.run,readback.run)||!same(actual.jobs,readback.jobs))return {status:'UNKNOWN',reason:'PUBLICATION_SOURCE_CHANGED',publishInvoked:false};
  try{await publish();}catch{ /* Actual native effects decide the result, including a lost response. */ }
  const observed=await inspectPublications(context,[...history,{path:file.path,commit:saved.head,value:start}],productIo,centralIo,clock());
  const adopted=await store.archive(observed.files);
  return {status:observed.native.complete&&['APPLIED','UNCHANGED'].includes(adopted.status)&&observed.files.every(file=>adopted.files?.some(value=>value.path===file.path&&value.content===file.content))?'OBSERVED':'UNKNOWN',reason:'PUBLICATION_NATIVE_RECONCILIATION',publishInvoked:true,publication:observed};
}
