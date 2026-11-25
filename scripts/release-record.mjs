import apiVersion from "../config/github-api.json" with { type: "json" };
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile, mkdir, lstat, readdir, realpath, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Octokit } from '@octokit/rest';
import { completeNativeRuleParameters } from './native-rule-parameters.mjs';
import { githubUnits, decodeReleaseRecord, decodeStateFile, stateRecordOwner, assertRepositoryWrite, isolatedBuildEnvironment, decodeBuildJson, assertMaintenanceProgress, assertPagesProgress,
  inspectNativeCycle, recoverNativeCycle, archiveFile, nativeReadFile, nativeEvidenceTransport,
  dispatchNativeRun, prepareBuildDispatch, defaultBuildWorkflow, dispatchWorkflow, encodeRepositoryPath, verifyDispatchWorkflow, inspectPublications, invokePublication, inspectCycleHistory, verifyFrozenReceipts, completionFile, decodeCompletionArchive, mergedBuildCycle,
  pipelinePreparePublication, readCycleDelivery, prepareNormalizedDelivery, NativeGitHubRelease, nativeGhCommand, nativeReleaseDownload, verifyOfficialPublicationProof, NativeEvidenceReader, nativeRunFact,
  publicationManifestDigest,sameWorkflowDelivery,prepareWorkflowChannelReceipts,selectWorkflowGithubDelivery,
  retainedChannelObservations, observeNativeChannels, readChannelSourceRejections, selectChannelDispatch, prepareChannelDispatch, channelTargetsDigest, verifyChannelResult, verifyContinuationReleases, evaluateCompletion } from '../packages/runner/dist/index.js';

import {withReleaseAdoption,recoverReleaseCaches} from './release-adoption.mjs';
import { approvedCycleTarget, readBoundOfficialDraft, readOfficialScope } from './official-release.mjs';

const refs = new Set(['steward/release-state','steward/governance-state','steward/automation-health']);
const hash = value => typeof value==='string' && /^[a-f0-9]{40}$/.test(value) && value.length===40;
const ordered = values => [...values].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
function compatibleCycle(a,b) {
  if (a.sourceSha!==b.sourceSha || a.controllerSha!==b.controllerSha || a.deliveryConfigSha!==b.deliveryConfigSha || a.buildWorkflow!==b.buildWorkflow || a.workflowDelivery!==b.workflowDelivery || a.repairOf!==b.repairOf
    || ['headSha','pullBodyDigest','bodyDigest'].some(key=>a.officialRelease?.[key]!==b.officialRelease?.[key])
    || JSON.stringify(ordered(a.requiredChannels.map(x=>[x.unitId,x.channelId])))!==JSON.stringify(ordered(b.requiredChannels.map(x=>[x.unitId,x.channelId])))
    || JSON.stringify(ordered(a.units.map(x=>[x.id,x.version,x.tag])))!==JSON.stringify(ordered(b.units.map(x=>[x.id,x.version,x.tag])))) return false;
  for (const unit of a.units) {
    const other=b.units.find(value=>value.id===unit.id);
    if(unit.githubDisabled!==other.githubDisabled
      ||unit.githubDelivery&&other.githubDelivery&&!sameWorkflowDelivery(unit.githubDelivery,other.githubDelivery))return false;
    for(const receipt of unit.channelDeliveries??[]) {
      const match=other.channelDeliveries?.find(item=>item.channelId===receipt.channelId);
      if(match&&JSON.stringify(match)!==JSON.stringify(receipt))return false;
    }
    for (const key of ['releaseId','notesDigest','manifestDigest']) if(unit[key]!==null && other[key]!==null && unit[key]!==other[key]) return false;
    const assets=value=>JSON.stringify(ordered(value.map(x=>[x.id,x.path,x.size,x.sha256])));
    if(unit.assets.length && other.assets.length && assets(unit.assets)!==assets(other.assets)) return false;
  }
  return true;
}
/** Read immutable Git blobs without checkout, hooks, external diff or textconv. */
export async function readReleaseRecords({ directory, targetRef, repositoryId, includeHistory=true, maintenanceOnly=false, candidateRound=null }) {
  if (!refs.has(targetRef) || !Number.isSafeInteger(repositoryId) || repositoryId<1) throw new Error('RELEASE_RECORD: target');
  if(maintenanceOnly&&(repositoryId!==1296724484||targetRef!=='steward/release-state'||!includeHistory))throw new Error('RELEASE_RECORD: central maintenance identity');
  if(candidateRound!==null && candidateRound!=='lookup' && !digest(candidateRound))fail('official candidate lookup target');
  const includeCandidate=path=>candidateRound==='lookup'
    ?path.endsWith('-lookup.json')||path.includes('/seen-'):candidateRound!==null&&path.startsWith(`candidates/${candidateRound}/`);
  const home=await mkdtemp(join(tmpdir(),'steward-record-read-'));
  const env=isolatedBuildEnvironment(process.env,home);
  // These plumbing reads never apply attributes, filters or text conversion.
  const git=async (...args)=>(await promisify(execFile)('git',['--no-replace-objects','--no-optional-locks','-c','core.hooksPath=','-c','core.fsmonitor=false',...args],
    {cwd:resolve(directory),env,encoding:'buffer',maxBuffer:16*1024*1024,timeout:30_000,windowsHide:true})).stdout;
  const batch=async(args,input)=>new Promise((done,reject)=>{
    const child=execFile('git',['--no-replace-objects','--no-optional-locks','-c','core.hooksPath=','-c','core.fsmonitor=false',...args],
      {cwd:resolve(directory),env,encoding:'buffer',maxBuffer:17*1024*1024,timeout:30_000,windowsHide:true},
      (error,stdout)=>error?reject(error):done(stdout));
    child.stdin.on('error',reject);child.stdin.end(input);
  });
  // Git object IDs identify immutable bytes. Reuse the bytes within this read;
  // still decode and validate every path and historical transition below.
  const blobs=new Map();
  const readBlob=async oid=>{
    if(!blobs.has(oid))blobs.set(oid,await git('cat-file','blob',oid));
    return blobs.get(oid);
  };
  const ref=`refs/heads/${targetRef}`;
  try {
    if((await git('rev-parse','--is-shallow-repository')).toString().trim()!=='false')throw new Error('RELEASE_RECORD: incomplete history');
    const head=(await git('rev-parse','--verify',`${ref}^{commit}`)).toString().trim();
    if (!hash(head)) throw new Error('RELEASE_RECORD: head');
    const commits=includeHistory?(await git('rev-list',head)).toString().trim().split('\n'):[head];
    const commitTimes=new Map((await git('log',...(includeHistory?[]:['-1']),'--format=%H %cI',head)).toString().trim().split('\n').map(line=>line.split(' ')));
    // Read each immutable object once in bounded batches. A long protected
    // history must not start one Windows process for every archived blob.
    // Decoding, path ownership and historical transitions remain per record.
    const entriesByCommit=new Map(),objects=new Set();
    for(const commit of commits) {
      if(!hash(commit))throw new Error('RELEASE_RECORD: history');
      const entries=(await git('ls-tree','-r','-z',commit)).toString('utf8').split('\0').filter(Boolean);
      entriesByCommit.set(commit,entries);
      for(const entry of entries) {
        const match=/^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(entry);
        if(!match)throw new Error('RELEASE_RECORD: tree');
        const [,mode,type,oid,path]=match;
        if(maintenanceOnly&&stateRecordOwner(targetRef,path)!=='maintenance')throw new Error('RELEASE_RECORD: central maintenance history');
        if(targetRef==='steward/release-state'&&path.startsWith('candidates/')) {
          stateRecordOwner(targetRef,path);
          if(mode!=='100644'||type!=='blob')fail('unsafe candidate path');
          if(!includeCandidate(path))continue;
        }
        if(targetRef!=='steward/release-state'||path==='state.json'||/^(cycles|generated|content|candidates|maintenance|official)\//.test(path)
          ||/^evidence\/(native|reads|dispatch|retry-limit|publication|completion|channel|channel-read|normalized-delivery|source-rejection)\//.test(path)) {
          if(mode!=='100644'||type!=='blob') {
            const kind=targetRef!=='steward/release-state'||path==='state.json'||path.startsWith('cycles/')?'':
              path.startsWith('maintenance/')?'maintenance ':/^(generated|content)\//.test(path)?'candidate ':'archive ';
            throw new Error(`RELEASE_RECORD: unsafe ${kind}path`);
          }
          objects.add(oid);
        }
      }
    }
    const ids=[...objects];
    if(ids.length) {
      const sizes=(await batch(['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],ids.join('\n')+'\n')).toString('ascii').trim().split('\n');
      if(sizes.length!==ids.length)throw new Error('RELEASE_RECORD: batch coverage');
      const groups=[];let group=[],size=0;
      for(let i=0;i<ids.length;i++) {
        const match=/^([a-f0-9]{40}) blob (0|[1-9][0-9]*)$/.exec(sizes[i]);
        const length=Number(match?.[2]);
        if(!match||match[1]!==ids[i]||!Number.isSafeInteger(length)||length>16*1024*1024)throw new Error('RELEASE_RECORD: batch object');
        if(group.length&&size+length+64>16*1024*1024){groups.push(group);group=[];size=0;}
        group.push({oid:ids[i],length});size+=length+64;
      }
      if(group.length)groups.push(group);
      for(const group of groups) {
        const bytes=await batch(['cat-file','--batch'],group.map(value=>value.oid).join('\n')+'\n');let offset=0;
        for(const {oid,length} of group) {
          const end=bytes.indexOf(10,offset);
          if(end<offset||bytes.subarray(offset,end).toString('ascii')!==`${oid} blob ${length}`
            ||end+1+length>=bytes.length||bytes[end+1+length]!==10)throw new Error('RELEASE_RECORD: batch framing');
          const content=Buffer.from(bytes.subarray(end+1,end+1+length));
          if(createHash('sha1').update(`blob ${length}\0`).update(content).digest('hex')!==oid)throw new Error('RELEASE_RECORD: batch object digest');
          blobs.set(oid,content);offset=end+length+2;
        }
        if(offset!==bytes.length)throw new Error('RELEASE_RECORD: batch trailing bytes');
      }
    }
    const history=[], repositoryHistory=[], cycleHistory=[], currentPaths=[], cycles=new Map(), domainRecords=new Map(), candidateBlobs=new Map(); let repository=null, repositoryCommit=null, adoption=null;
    for (const commit of commits) {
      if (!hash(commit)) throw new Error('RELEASE_RECORD: history');
      const entries=entriesByCommit.get(commit);
      for (const entry of entries) {
        const match=/^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(entry);
        if(!match)throw new Error('RELEASE_RECORD: tree');
        const [,mode,type,oid,path]=match;
        if(commit===head)currentPaths.push(path);
        if(targetRef==='steward/release-state'&&path.startsWith('candidates/')&&!includeCandidate(path))continue;
        if(targetRef!=='steward/release-state') {
          if(mode!=='100644'||type!=='blob')throw new Error('RELEASE_RECORD: unsafe path');
          const bytes=await readBlob(oid);
          const value=decodeStateFile(targetRef,path,bytes,repositoryId);
          if(path.startsWith('maintenance/pages/')&&domainRecords.has(path))assertPagesProgress(value,domainRecords.get(path).value);
          if(!domainRecords.has(path))domainRecords.set(path,{commit,path,blobSha:oid,value,content:bytes.toString('utf8')});
          history.push({commit,path,blobSha:oid,status:'DECODED'});continue;
        }
        if(path.startsWith('evidence/native/')||path.startsWith('evidence/reads/')||path.startsWith('evidence/dispatch/')||path.startsWith('evidence/retry-limit/')||path.startsWith('evidence/publication/')||path.startsWith('evidence/completion/')||path.startsWith('evidence/channel/')||path.startsWith('evidence/channel-read/')||path.startsWith('evidence/normalized-delivery/')||path.startsWith('evidence/source-rejection/')) {
          if(mode!=='100644'||type!=='blob')throw new Error('RELEASE_RECORD: unsafe archive path');
          const bytes=await readBlob(oid), value=decodeStateFile(targetRef,path,bytes,repositoryId);
          if(!path.endsWith('/'+createHash('sha256').update(bytes).digest('hex')+'.json'))throw new Error('RELEASE_RECORD: archive digest');
          if(!domainRecords.has(path))domainRecords.set(path,{commit,path,blobSha:oid,value,content:bytes.toString('utf8')});
          history.push({commit,path,blobSha:oid,status:'DECODED'});continue;
        }
        if(path.startsWith('maintenance/')) {
          if(mode!=='100644'||type!=='blob')throw new Error('RELEASE_RECORD: unsafe maintenance path');
          const bytes=await readBlob(oid),value=decodeStateFile(targetRef,path,bytes,repositoryId);
          const previous=domainRecords.get(path);
          if(previous && path.startsWith('maintenance/candidate-draft-')) {
            if(previous.blobSha!==oid)fail('candidate draft recovery is immutable');
          } else if(previous)assertMaintenanceProgress(value,previous.value);
          else domainRecords.set(path,{commit,path,blobSha:oid,value,content:bytes.toString('utf8')});
          history.push({commit,path,blobSha:oid,status:'DECODED'});continue;
        }
        if(path.startsWith('official/')) {
          if(mode!=='100644'||type!=='blob')fail('unsafe official receipt path');
          const bytes=await readBlob(oid),value=decodeStateFile(targetRef,path,bytes,repositoryId),latest=domainRecords.get(path);
          if(latest) officialReceiptProgress(path,value,latest.value);
          else domainRecords.set(path,{commit,path,blobSha:oid,value,content:bytes.toString('utf8')});
          history.push({commit,path,blobSha:oid,status:'DECODED'});continue;
        }
        if(path.startsWith('generated/')||path.startsWith('content/')||path.startsWith('candidates/')) {
          if(mode!=='100644'||type!=='blob')throw new Error('RELEASE_RECORD: unsafe candidate path');
          const key=path+'\0'+oid;
          if(!candidateBlobs.has(key)) {
            const bytes=await readBlob(oid),value=decodeStateFile(targetRef,path,bytes,repositoryId);
            candidateBlobs.set(key,{value,content:bytes.toString('utf8')});
          }
          const stored=domainRecords.get(path);
          if(path.startsWith('candidates/')&&stored&&stored.blobSha!==oid)fail('official candidate checkpoint changed');
          if(!stored)domainRecords.set(path,{commit,path,blobSha:oid,...candidateBlobs.get(key)});
          history.push({commit,path,blobSha:oid,status:'DECODED'});continue;
        }
        if(path!=='state.json'&&!path.startsWith('cycles/'))continue;
        if(mode!=='100644'||type!=='blob'||path!=='state.json'&&!/^cycles\/pr-[1-9][0-9]*-[a-f0-9]{40}\.json$/.test(path))throw new Error('RELEASE_RECORD: unsafe path');
        const bytes=await readBlob(oid);
        // Unknown schema must not be bypassed by selecting a convenient older
        // supported version. Malformed bytes remain in history for recovery.
        let raw;try{raw=JSON.parse(bytes.toString('utf8'));}catch{history.push({commit,path,blobSha:oid,status:'MALFORMED_JSON'});continue;}
        if(path==='state.json'&&![2,3].includes(raw?.schemaVersion))throw new Error('RELEASE_RECORD: unsupported schema');
        // A valid A/P cannot be discarded merely because another field in the same record is damaged.
        if(path==='state.json'&&raw.schemaVersion===3&&hash(raw.releaseAdoption?.sourceSha)
          &&Number.isSafeInteger(raw.releaseAdoption?.prNumber)&&raw.releaseAdoption.prNumber>0) {
          if(adoption&&(adoption.sourceSha!==raw.releaseAdoption.sourceSha||adoption.prNumber!==raw.releaseAdoption.prNumber))throw new Error('RELEASE_RECORD: release adoption conflict');
          adoption=raw.releaseAdoption;
        }
        try {
          const value=decodeReleaseRecord(path==='state.json'?'repository':'cycle',bytes);
          if(path==='state.json') {
            if(value.repositoryId!==repositoryId)throw new Error('RELEASE_RECORD: repository identity');
            if(value.schemaVersion===3) {
              if(repository?.schemaVersion===2)throw new Error('RELEASE_RECORD: schema downgrade');
              if(repositoryHistory.some(r=>r.value.schemaVersion===3&&(r.value.releaseAdoption.sourceSha!==value.releaseAdoption.sourceSha||r.value.releaseAdoption.prNumber!==value.releaseAdoption.prNumber)))throw new Error('RELEASE_RECORD: release adoption conflict');
            }
            repositoryHistory.push({commit,value,committedAt:commitTimes.get(commit)});
            if(repository===null){repository=value;repositoryCommit=commit;}
          } else {
            if(path!==`cycles/${value.id}.json`)throw new Error('RELEASE_RECORD: cycle identity');
            const prior=cycles.get(value.id);
            if(prior)cycleProgress(value,prior.value);
            if(!prior)cycles.set(value.id,{commit,blobSha:oid,value});
            cycleHistory.push({commit,blobSha:oid,value,committedAt:commitTimes.get(commit)});
          }
          history.push({commit,path,blobSha:oid,status:'DECODED'});
        } catch(error) {
          if ((error instanceof Error) && /^RELEASE_RECORD:/.test(error.message)) throw error;
          history.push({commit,path,blobSha:oid,status:'INVALID_RECORD'});
        }
      }
    }
    const current=(await git('rev-parse','--verify',`${ref}^{commit}`)).toString().trim();
    if(current!==head)throw new Error('RELEASE_RECORD: ref moved');
    // Missing registered records are the bounded recovery trigger; healthy wakes read one tree.
    if(!includeHistory && targetRef==='steward/release-state' && (!repository
      || history.some(record=>record.status!=='DECODED')
      || [repository.activeCycleId,repository.lastCompletedCycleId].some(id=>id&&!cycles.has(id))
      || [...cycles.values()].some(({value})=>value.completedEvidencePath&&(!domainRecords.has(value.completedEvidencePath)
        || domainRecords.get(value.completedEvidencePath).value.provenance.some(proof=>!domainRecords.has(proof.path))))))
      return readReleaseRecords({directory,targetRef,repositoryId,includeHistory:true,candidateRound});
    return {repositoryId,targetRef,head,repository,repositoryCommit,cycles:[...cycles.values()],cycleHistory,domainRecords:[...domainRecords.values()],history,repositoryHistory,currentPaths,
      completion:{result:'UNKNOWN',reason:'NATIVE_RECONCILIATION_REQUIRED'}};
  } finally { await rm(home,{recursive:true,force:true}); }
}

const digest = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value) && value.length===64;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error('RELEASE_RECORD: '+code); };
const candidatePhases = ['source','draft','branch','pull'];
const candidateChunkBytes = 256 * 1024;

function officialCandidateRound(snapshot, roundId) {
  if (!digest(roundId)) fail('official candidate round ID');
  const currentPaths=new Set(snapshot.currentPaths);
  const records=snapshot.domainRecords.filter(({path})=>path.startsWith(`candidates/${roundId}/`)&&currentPaths.has(path));
  const round = {head:snapshot.head,source:null,draft:null,branch:null,pull:null};
  let gap = false;
  for (const phase of candidatePhases) {
    const prefix=`candidates/${roundId}/${phase}-`;
    const lookup=records.find(({path})=>path===prefix+'lookup.json')?.value;
    const chunks = records.filter(({path})=>path.startsWith(prefix)&&path!==prefix+'lookup.json')
      .map(({value})=>value).sort((a,b)=>a.index-b.index);
    if (!chunks.length) {
      if(lookup) fail('official candidate checkpoint coverage');
      gap = true;
      continue;
    }
    const first = chunks[0];
    if (gap || chunks.length!==first.count || chunks.some((chunk,index)=>chunk.index!==index
      || chunk.count!==first.count || chunk.payloadDigest!==first.payloadDigest)) fail('official candidate checkpoint coverage');
    const bytes = Buffer.concat(chunks.map(({content})=>{
      const value=Buffer.from(content,'base64');
      if(value.length>candidateChunkBytes || value.toString('base64')!==content) fail('official candidate checkpoint encoding');
      return value;
    }));
    if(sha256(bytes)!==first.payloadDigest) fail('official candidate checkpoint digest');
    const payload = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if (!payload || typeof payload!=='object' || Array.isArray(payload)
      || !Buffer.from(JSON.stringify(payload),'utf8').equals(bytes)) fail('official candidate checkpoint payload');
    round[phase] = payload;
    if(['source','branch'].includes(phase)) {
      const source=round.source;
      if(!lookup||lookup.payloadDigest!==first.payloadDigest||lookup.sourceSha!==payload.sourceSha||lookup.defaultBranch!==source.candidate?.base
        ||lookup.baseline.tag!==source.baseline?.tag||lookup.baseline.sha!==source.baseline?.sha)
        fail('official candidate checkpoint lookup changed');
    }
  }
  return round;
}

export async function readOfficialCandidateRound({directory,repositoryId,roundId}) {
  const snapshot=await readReleaseRecords({directory,repositoryId,targetRef:'steward/release-state',includeHistory:false,candidateRound:roundId});
  return officialCandidateRound(snapshot,roundId);
}

export async function findOfficialCandidateRound({directory,repositoryId,defaultBranch,sourceSha,baseline}) {
  if(!hash(sourceSha) || !baseline || typeof defaultBranch!=='string') fail('official candidate lookup');
  const snapshot=await readReleaseRecords({directory,repositoryId,targetRef:'steward/release-state',includeHistory:false,candidateRound:'lookup'});
  const currentPaths=new Set(snapshot.currentPaths);
  const indexes=snapshot.domainRecords.filter(({path})=>path.startsWith('candidates/')&&currentPaths.has(path));
  const sources=new Map(indexes.filter(({path})=>path.endsWith('/source-lookup.json'))
    .map(({value})=>[value.roundId,value]));
  const matches=new Set();
  for(const {value} of indexes) {
    const index=sources.get(value.roundId);
    if(index?.defaultBranch===defaultBranch&&index.baseline.tag===baseline.tag&&index.baseline.sha===baseline.sha
      && value.sourceSha===sourceSha) matches.add(value.roundId);
  }
  if(matches.size>1) fail('official candidate lookup ambiguous');
  const [roundId]=matches;
  if(!roundId)return null;
  const round=await readOfficialCandidateRound({directory,repositoryId,roundId});
  if(round.head!==snapshot.head||!round.source)fail('official candidate lookup ref moved');
  return {roundId,...round};
}

async function writeOfficialCandidateFacts(request,snapshot,changes,slot,{token,admit,io=nativeEvidenceTransport(token)}={}) {
  const {writeDirectory,repository,repositoryId,defaultBranch,identity,roundId}=request;
  if(!token || typeof admit!=='function' || !isAbsolute(writeDirectory)
    || !/^splrad\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repository)) fail('official candidate checkpoint request');
  const reader=new NativeEvidenceReader(io,repository);
  const verifyRef=async head=>{
    const ref=await reader.json('git/ref/heads/steward/release-state');
    if(ref.ref!=='refs/heads/steward/release-state'||ref.object?.type!=='commit'||ref.object.sha!==head)
      fail('official candidate checkpoint ref changed');
  };
  const actual=await reader.json('');
  if(actual.id!==repositoryId || actual.full_name!==repository || actual.default_branch!==defaultBranch
    || actual.archived!==false || actual.disabled!==false) fail('official candidate checkpoint repository');
  await verifyRef(snapshot.head);
  if(!changes.length) return snapshot;
  await assertReleaseWriterProtection(repository,'steward/release-state',io,{token});
  await admit();
  const output=join(writeDirectory,`candidate-${roundId}-${slot}`);
  const written=await writeReleaseRecords({directory:output,remote:`https://github.com/${repository}.git`,repositoryId,defaultBranch,
    targetRef:'steward/release-state',writer:'release',expectedHead:snapshot.head,allowedPaths:changes.map(change=>change.path),changes,
    identity},{token,beforePush:admit});
  if(!['APPLIED','UNCHANGED'].includes(written.status)) fail('official candidate checkpoint unconfirmed');
  const verified=await readReleaseRecords({directory:output,repositoryId,targetRef:'steward/release-state',includeHistory:false,candidateRound:roundId});
  await verifyRef(verified.head);
  if(verified.head!==written.head||changes.some(change=>!verified.domainRecords.some(record=>record.path===change.path&&record.content===change.content)))
    fail('official candidate checkpoint readback');
  return verified;
}

export async function writeOfficialCandidateCheckpoint(request,options) {
  const {directory,repositoryId,defaultBranch,roundId,phase,data}=request;
  if(!candidatePhases.includes(phase)||!data||typeof data!=='object'||Array.isArray(data)) fail('official candidate checkpoint request');
  const snapshot=await readReleaseRecords({directory,repositoryId,targetRef:'steward/release-state',includeHistory:false,candidateRound:roundId});
  const round=officialCandidateRound(snapshot,roundId);
  const bytes=Buffer.from(JSON.stringify(data),'utf8');
  const payloadDigest=sha256(bytes);
  if(round[phase]!==null) {
    if(sha256(JSON.stringify(round[phase]))!==payloadDigest) fail('official candidate checkpoint conflict');
    await writeOfficialCandidateFacts(request,snapshot,[],phase,options);
    return round;
  }
  const index=candidatePhases.indexOf(phase);
  if(index>0 && round[candidatePhases[index-1]]===null) fail('official candidate predecessor required');
  const count=Math.ceil(bytes.length/candidateChunkBytes);
  const source=phase==='source'?data:round.source;
  const lookup=['source','branch'].includes(phase)&&{sourceSha:data.sourceSha,defaultBranch,baseline:source.baseline};
  if(lookup&&(source.candidate?.base!==defaultBranch||!lookup.baseline||!hash(lookup.sourceSha))) fail('official candidate lookup');
  const changes=Array.from({length:count},(_,index)=>{
    const path=`candidates/${roundId}/${phase}-${index}.json`;
    const content=JSON.stringify({schemaVersion:1,repositoryId,roundId,phase,index,count,payloadDigest,
      content:bytes.subarray(index*candidateChunkBytes,(index+1)*candidateChunkBytes).toString('base64')})+'\n';
    return {path,content,sha256:sha256(content),previousSha256:null};
  });
  if(lookup) {
    const path=`candidates/${roundId}/${phase}-lookup.json`;
    const content=JSON.stringify({schemaVersion:1,repositoryId,roundId,phase,payloadDigest,...lookup})+'\n';
    changes.push({path,content,sha256:sha256(content),previousSha256:null});
  }
  return officialCandidateRound(await writeOfficialCandidateFacts(request,snapshot,changes,phase,options),roundId);
}

export async function recordOfficialCandidateSource(request,options) {
  const {directory,repositoryId,defaultBranch,roundId,sourceSha}=request;
  if(!hash(sourceSha)) fail('official candidate source alias');
  const snapshot=await readReleaseRecords({directory,repositoryId,targetRef:'steward/release-state',includeHistory:false,candidateRound:roundId});
  const round=officialCandidateRound(snapshot,roundId);
  if(!round.source||round.source.candidate?.base!==defaultBranch) fail('official candidate source alias requires a recorded round');
  const slot=`seen-${sourceSha}`,path=`candidates/${roundId}/${slot}.json`;
  const content=JSON.stringify({schemaVersion:1,repositoryId,roundId,sourceSha})+'\n';
  const exists=round.branch?.sourceSha===sourceSha||round.source.sourceSha===sourceSha||snapshot.currentPaths.includes(path);
  const changes=exists?[]:[{path,content,sha256:sha256(content),previousSha256:null}];
  const io=options?.io??nativeEvidenceTransport(options?.token);
  const reader=new NativeEvidenceReader(io,request.repository);
  const admit=async()=>{
    await options.admit();
    const ref=await reader.json('git/ref/heads/'+encodeURIComponent(defaultBranch));
    if(ref.ref!==`refs/heads/${defaultBranch}`||ref.object?.type!=='commit'||ref.object.sha!==sourceSha)
      fail('official candidate source alias HEAD changed');
  };
  return officialCandidateRound(await writeOfficialCandidateFacts(request,snapshot,changes,slot,{...options,io,admit}),roundId);
}
const exact = (value,keys) => {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!==[...keys].sort().join(','))fail('closed input');
};
const writerRefs={release:'steward/release-state',maintenance:'steward/release-state',quality:'steward/governance-state',
  bootstrap:'steward/governance-state',pages:'steward/governance-state'};
const busy=new Set();

function validateWrite(request) {
  exact(request,['directory','remote','repositoryId','defaultBranch','targetRef','writer','expectedHead','allowedPaths','changes','identity']);
  if(!isAbsolute(request.directory) || /[\r\n\0]/.test(request.directory) || !Object.hasOwn(writerRefs,request.writer) || writerRefs[request.writer]!==request.targetRef
    || !Number.isSafeInteger(request.repositoryId) || request.repositoryId<1 || request.expectedHead!==null && !hash(request.expectedHead)
    || typeof request.defaultBranch!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(request.defaultBranch))fail('write target');
  exact(request.identity,['name','email']);
  if(![request.identity.name,request.identity.email].every(value=>typeof value==='string' && value.trim()===value && value.length>0 && !/[\x00-\x1f\x7f<>"\\#;]/.test(value))
    || !/^[^\s@]+@[^\s@]+$/.test(request.identity.email))fail('Git identity');
  if(typeof request.remote!=='string' || !( /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git$/.test(request.remote)
    || isAbsolute(request.remote) && !/[\r\n\0]/.test(request.remote)))fail('remote');
  if(request.writer==='maintenance'&&(request.repositoryId!==1296724484
    ||request.remote.startsWith('https:')&&request.remote!=='https://github.com/splrad/steward.git'))fail('central maintenance identity');
  if(!Array.isArray(request.allowedPaths) || !Array.isArray(request.changes) || !request.changes.length
    || request.allowedPaths.length!==request.changes.length || new Set(request.allowedPaths.map(path=>path.toLowerCase())).size!==request.allowedPaths.length)fail('allowed paths');
  let total=0;
  for(const change of request.changes) {
    exact(change,['path','content','sha256','previousSha256']);
    if(!request.allowedPaths.includes(change.path) || stateRecordOwner(request.targetRef,change.path)!==request.writer
      || typeof change.content!=='string' || !digest(change.sha256) || change.previousSha256!==null && !digest(change.previousSha256))fail('write path/digest');
    const bytes=Buffer.from(change.content,'utf8');
    if(bytes.toString('utf8')!==change.content || sha256(bytes)!==change.sha256)fail('write bytes');
    if(/^evidence\/(native|reads|dispatch|retry-limit|publication|completion|channel|channel-read|normalized-delivery|source-rejection)\//.test(change.path) && !change.path.endsWith('/'+change.sha256+'.json'))fail('archive content address');
    const decoded=decodeStateFile(request.targetRef,change.path,bytes,request.repositoryId);
    if(request.targetRef==='steward/release-state'&&change.path==='state.json')assertRepositoryWrite(decoded);
    // Candidate source documents are explicit, digest-bound fragments. Their
    // aggregate may exceed 32 MiB; each fragment retains the 512 KiB decoder bound.
    if(change.path.startsWith('candidates/')&&change.previousSha256!==null)fail('official candidate checkpoint is append-only');
    if(!/^(?:generated|content|candidates)\/.+\.json$/.test(change.path))total+=bytes.length;
  }
  if(new Set(request.changes.map(file=>file.path)).size!==request.allowedPaths.length || total>16*1024*1024)fail('write bounds');
  return request;
}

async function noLinks(directory) {
  const stat=await lstat(directory);
  if(stat.isSymbolicLink() || !stat.isDirectory())fail('workspace path');
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name), info=await lstat(path);
    if(info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink!==1))fail('workspace link');
    if(info.isDirectory())await noLinks(path);
  }
}
function gitConfig(request) {
  const {identity,remote,targetRef,repositoryId}=request;
  return `[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n\tlogallrefupdates = false\n\tsymlinks = false\n\tautocrlf = false\n[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n[remote "origin"]\n\turl = ${JSON.stringify(remote)}\n[branch "steward-record-write"]\n\tremote = origin\n\tmerge = refs/heads/${targetRef}\n[steward]\n\trepositoryId = ${repositoryId}\n`;
}
function cycleProgress(before,after) {
  if(!compatibleCycle(before,after) || before.freezeCompletedAt && before.freezeCompletedAt!==after.freezeCompletedAt
    || before.officialDraftScopeDigest && before.officialDraftScopeDigest!==after.officialDraftScopeDigest
    || before.freezeBuildAttempt!==undefined && before.freezeBuildAttempt!==after.freezeBuildAttempt
    || before.freezeOnly && JSON.stringify(before.freezeOnly)!==JSON.stringify(after.freezeOnly))fail('immutable cycle conflict');
  const oldDecision=before.approvedRepairDecision,newDecision=after.approvedRepairDecision;
  if(oldDecision && JSON.stringify(oldDecision)!==JSON.stringify(newDecision)) {
    if(oldDecision.cycleId===before.id || !newDecision || newDecision.cycleId!==after.id
      || Date.parse(newDecision.createdAt)<Date.parse(oldDecision.createdAt))fail('repair decision changed');
  }
  for(const old of before.units) {
    const current=after.units.find(unit=>unit.id===old.id);
    if(['releaseId','notesDigest','manifestDigest'].some(key=>old[key]!==null && old[key]!==current[key])
      || old.assets.length && !current.assets.length
      || old.githubDelivery&&!current.githubDelivery
      || old.channelDeliveries?.some(receipt=>!current.channelDeliveries?.some(item=>item.channelId===receipt.channelId)))fail('frozen cycle fact removed');
  }
  for(const old of before.dispatches) {
    const current=after.dispatches.find(item=>item.requestKey===old.requestKey);
    if(!current)fail('dispatch fact removed');
    for(const key of ['requestKey','operationKey','purpose','workflowId','buildWorkflow','ref','sourceSha','targetKey','inputs','inputDigest','executionSha','sentAt','continuationOfRunId','retryLimitEvidencePath'])
      if(JSON.stringify(old[key])!==JSON.stringify(current[key]))fail('immutable dispatch conflict');
    if(old.canonicalRunId!==null && old.canonicalRunId!==current.canonicalRunId)fail('canonical Run conflict');
    if(old.canonicalRunId!==null && old.nativeResponseEvidencePath!==current.nativeResponseEvidencePath)fail('canonical evidence conflict');
    if(old.searchWindows.some(window=>!current.searchWindows.some(value=>JSON.stringify(value)===JSON.stringify(window))))fail('dispatch search history removed');
  }
}

function officialReceiptProgress(path,before,after) {
  if(path.startsWith('official/merged/')) {
    if(JSON.stringify(before)!==JSON.stringify(after)) fail('official merge receipt changed');
    return;
  }
  if(before.releaseId!==after.releaseId || before.url!==after.url
    || before.readyAt && (before.readyAt!==after.readyAt || before.assets.length!==after.assets.length)
    || before.assets.some(({assetId,name})=>!after.assets.some(asset=>asset.assetId===assetId&&asset.name===name)))
    fail('official draft receipt changed');
}

function officialReceiptFile(request,cycle,kind,data) {
  const path=`official/${kind}/${cycle.id}.json`;
  const content=JSON.stringify({schemaVersion:1,repositoryId:request.repositoryId,cycleId:cycle.id,...data})+'\n';
  return {path,content,sha256:sha256(content)};
}

function officialReceipt(snapshot,cycle,kind) {
  const path=`official/${kind}/${cycle.id}.json`;
  const receipt=snapshot.domainRecords.find(record=>record.path===path)?.value;
  if(receipt&&!snapshot.currentPaths.includes(path)) fail('official receipt missing from current state');
  return receipt;
}

function draftReadyResult(snapshot,cycle) {
  const receipt=officialReceipt(snapshot,cycle,'draft'),unit=cycle.units[0];
  if(!receipt?.readyAt) return null;
  if(receipt.releaseId!==unit.releaseId || !unit.githubDelivery || receipt.assets.length!==unit.assets.length
    || receipt.assets.some(asset=>!unit.assets.some(file=>file.path===asset.name))) fail('official draft receipt mismatch');
  return {status:'DRAFT_READY',reason:'OFFICIAL_DRAFT_ATTACHMENTS_READY',publishInvoked:false,
    draft:{releaseId:receipt.releaseId,url:receipt.url,assets:receipt.assets,tag:unit.tag,sourceSha:cycle.sourceSha,
      runId:unit.githubDelivery.runId,attempt:unit.githubDelivery.buildAttempt??unit.githubDelivery.attempt}};
}

/** Fixed Git transport. The caller must first verify native repository identity,
 * App identity and effective branch protection. This API grants no permission.
 * The dedicated Git directory retains the prepared commit on UNKNOWN; invoking
 * the same request again recovers it from HEAD without a second intent store.
 */
export async function writeReleaseRecords(input,{token,beforePush}={}) {
  const request=validateWrite(structuredClone(input));
  const directory=resolve(request.directory), ref=`refs/heads/${request.targetRef}`;
  if(busy.has(directory))fail('workspace busy');
  busy.add(directory);
  let home;
  try {
    if(await realpath(dirname(directory))!==dirname(directory))fail('workspace parent link');
    const local=!request.remote.startsWith('https://');
    if(local && await realpath(request.remote)!==resolve(request.remote))fail('remote link');
    if(token!==undefined && (typeof token!=='string' || !token || /\s|\0/.test(token)))fail('credential');
    home=await mkdtemp(join(tmpdir(),'steward-record-git-'));
    const env=isolatedBuildEnvironment(process.env,home);
    if(token!==undefined && !local)Object.assign(env,{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:`http.${request.remote}.extraheader`,
      GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+Buffer.from('x-access-token:'+token).toString('base64')});
    let fresh=false;
    try { await mkdir(directory); fresh=true; } catch(error) { if(error.code!=='EEXIST')throw error; }
    await noLinks(directory);
    const git=async(...args)=>{
      try {
        const result=await promisify(execFile)('git',['--no-replace-objects','--no-optional-locks','-c','core.hooksPath=','-c','core.fsmonitor=false',
          '-c','credential.helper=','-c','diff.external=','-c','commit.gpgsign=false','-c','core.longpaths=true','-c','protocol.allow=never','-c',local?'protocol.file.allow=always':'protocol.https.allow=always',...args],
          {cwd:directory,env,encoding:'buffer',maxBuffer:16*1024*1024,timeout:30_000,windowsHide:true});
        return {code:0,bytes:result.stdout};
      } catch(error) { return {code:Number.isInteger(error.code)?error.code:null,bytes:Buffer.alloc(0)}; }
    };
    const required=async(...args)=>{const result=await git(...args);if(result.code!==0)fail(`Git operation unavailable (${args[0]})`);return result.bytes;};
    const config=gitConfig(request);
    if(fresh) {
      await required('-c','init.templateDir=','init','--initial-branch=steward-record-write');
      await writeFile(join(directory,'.git','config'),config);
    } else if((await readFile(join(directory,'.git','config'),'utf8'))!==config)fail('workspace ownership');
    // Prevent partial/shallow history and local replacements from hiding parents.
    for(const path of ['.git/shallow','.git/info/grafts','.git/objects/info/alternates']) {
      try { await lstat(join(directory,path));fail('incomplete local history'); } catch(error) { if(error.code!=='ENOENT')throw error; }
    }
    await required('check-ref-format','--branch',request.defaultBranch);
    const localHead=async()=>{const result=await git('rev-parse','--verify','HEAD');return result.code===0?result.bytes.toString().trim():null;};
    const remoteHead=async(branch=request.targetRef)=>{
      const result=await git('ls-remote','--heads','--refs',request.remote,`refs/heads/${branch}`);
      if(result.code!==0)return {known:false,head:null};
      const lines=result.bytes.toString().trim();
      if(!lines)return {known:true,head:null};
      const match=/^([a-f0-9]{40})\t([^\r\n]+)$/.exec(lines);
      if(!match || match[2]!==`refs/heads/${branch}`)return {known:false,head:null};
      return {known:true,head:match[1]};
    };
    const fetchHead=async(head,branch=request.targetRef)=>{
      if((await git('fetch','--no-tags','--no-recurse-submodules',request.remote,`refs/heads/${branch}`)).code!==0)return false;
      try { await lstat(join(directory,'.git','shallow'));fail('incomplete fetched history'); } catch(error) { if(error.code!=='ENOENT')throw error; }
      return (await required('rev-parse','FETCH_HEAD')).toString().trim()===head;
    };
    const verifiedTrees=new Map(),verifiedBlobs=new Map(),changedPaths=new Set(request.allowedPaths);
    const tree=async commit=>{
      if(verifiedTrees.has(commit))return verifiedTrees.get(commit);
      const files=new Map(),names=new Set();if(commit===null)return files;
      const raw=new TextDecoder('utf-8',{fatal:true}).decode(await required('ls-tree','-r','-l','-z','--full-tree',commit));
      let size=0;
      for(const entry of raw.split('\0').filter(Boolean)) {
        const match=/^100644 blob ([a-f0-9]{40}) +([0-9]+)\t([^\r\n]+)$/.exec(entry);
        if(!match)fail('unsafe tree');
        const [,oid,lengthText,path]=match,length=Number(lengthText);
        stateRecordOwner(request.targetRef,path);
        const cacheKey=path+'\0'+oid;
        let cached=verifiedBlobs.get(cacheKey);
        if(!Number.isSafeInteger(length) || length<0 || length>512*1024)fail('tree bound');
        if(!/^(?:generated|content|candidates)\/.+\.json$/.test(path) && (size+=length)>16*1024*1024)fail('tree bound');
        if(names.has(path.toLowerCase()))fail('duplicate tree path');names.add(path.toLowerCase());
        if(path.startsWith('candidates/')&&!changedPaths.has(path)) {
          files.set(path,{oid});
          continue;
        }
        if(!cached) {
          const bytes=await required('cat-file','blob',oid);let value;
          try { value=decodeStateFile(request.targetRef,path,bytes,request.repositoryId); }
          catch(error) {
            if(request.targetRef!=='steward/release-state'||path!=='state.json'&&!/^cycles\/pr-[1-9][0-9]*-[a-f0-9]{40}\.json$/.test(path))throw error;
            // A corrupt current cache may be replaced only after complete history is read below.
            // Unsupported versions cannot be bypassed by selecting an older record.
            let raw;try{raw=JSON.parse(bytes);}catch{}
            if(path==='state.json'&&raw&&![2,3].includes(raw.schemaVersion))throw error;
            value=null;
          }
          if(/^evidence\/(native|reads|dispatch|retry-limit|publication|completion|channel|channel-read|normalized-delivery|source-rejection)\//.test(path) && !path.endsWith('/'+sha256(bytes)+'.json'))fail('archive content address');
          cached={sha256:sha256(bytes),value};verifiedBlobs.set(cacheKey,cached);
        }
        files.set(path,{oid,sha256:cached.sha256,value:cached.value});
      }
      verifiedTrees.set(commit,files);return files;
    };
    const ancestry=async(ancestor,descendant)=>{
      if(ancestor===null)return true;
      const result=await git('merge-base','--is-ancestor',ancestor,descendant);
      if(result.code===0 || result.code===1)return result.code===0;
      // A rewritten remote may no longer advertise the old object. Traverse
      // the complete fetched descendant history before classifying divergence.
      const history=await git('rev-list',descendant);
      if(history.code!==0)fail('history unavailable');
      const commits=history.bytes.toString().trim().split('\n');
      if(!commits.length || !commits.every(hash))fail('history unavailable');
      return commits.includes(ancestor);
    };
    const identity=async commit=>{
      const raw=(await required('show','-s','--format=%P%n%an%n%ae%n%cn%n%ce%n%B',commit)).toString('utf8');
      const [parents,an,ae,cn,ce,...message]=raw.split('\n');
      if([an,cn].some(value=>value!==request.identity.name)||[ae,ce].some(value=>value!==request.identity.email)
        || message.join('\n').trim()!==`Record ${request.writer} facts\n\nSigned-off-by: ${request.identity.name} <${request.identity.email}>`
        || parents && !hash(parents))fail('prepared commit identity');
      return parents || null;
    };
    const matches=files=>request.changes.every(file=>files.get(file.path)?.sha256===file.sha256);
    const validateBase=files=>{
      for(const file of request.changes)if((files.get(file.path)?.sha256??null)!==file.previousSha256)fail('expected bytes conflict');
    };
    const validateProposal=async commit=>{
      const parent=await identity(commit);
      if(request.expectedHead!==null && (parent===null || !await ancestry(request.expectedHead,parent)))fail('prepared parent conflict');
      const [base,proposed]=await Promise.all([tree(parent),tree(commit)]);
      if(request.writer==='maintenance') {
        if([...base.keys(),...proposed.keys()].some(path=>stateRecordOwner(request.targetRef,path)!=='maintenance'))fail('central maintenance tree');
      } else if(request.targetRef==='steward/release-state') {
        if(!proposed.get('state.json')?.value)fail('repository record required');
        assertRepositoryWrite(proposed.get('state.json').value,base.get('state.json')?.value);
      }
      if(!matches(proposed))fail('prepared bytes conflict');
      for(const path of new Set([...base.keys(),...proposed.keys()])) {
        const before=base.get(path),after=proposed.get(path);
        if((before?.sha256??before?.oid)!==(after?.sha256??after?.oid)&&!changedPaths.has(path))fail('prepared path conflict');
      }
      return parent;
    };
    let proposal=await localHead(),parent=null;
    if(proposal===request.expectedHead)proposal=null;
    if(proposal!==null)parent=await validateProposal(proposal);
    const result=(status,head,reason)=>({status,head,proposedCommit:proposal,reason});
    for(let attempt=0;attempt<3;attempt++) {
      const observed=await remoteHead();
      if(!observed.known)return result('UNKNOWN',null,'REMOTE_READ_UNAVAILABLE');
      const head=observed.head;
      if(head===null) {
        if(request.expectedHead!==null)return result('CONFLICT',null,'STATE_REF_DISAPPEARED');
        const base=await remoteHead(request.defaultBranch);
        if(!base.known)return result('UNKNOWN',null,'DEFAULT_REF_UNAVAILABLE');
        if(base.head===null)return result('CONFLICT',null,'DEFAULT_BRANCH_REQUIRED');
      } else if(!await fetchHead(head))continue;
      if(request.expectedHead!==null && !await ancestry(request.expectedHead,head))return result('CONFLICT',head,'STATE_HISTORY_CHANGED');
      const current=await tree(head);
      if(request.writer==='maintenance'&&[...current.keys()].some(path=>stateRecordOwner(request.targetRef,path)!=='maintenance'))fail('central maintenance tree');
      const expected=await tree(request.expectedHead);validateBase(expected);
      // Unknown historical release schemas and immutable cycle conflicts stop a
      // write even when today's cache looks plausible.
      if(head!==null) {
        await required('update-ref',ref,head);
        if(request.targetRef==='steward/release-state'||request.targetRef==='steward/governance-state') {
          const history=await readReleaseRecords({directory,targetRef:request.targetRef,repositoryId:request.repositoryId,includeHistory:request.writer!=='release',maintenanceOnly:request.writer==='maintenance'});
          if(request.targetRef==='steward/release-state'&&request.writer!=='maintenance') {
            const update=request.changes.find(file=>file.path==='state.json');
            const record=update?decodeReleaseRecord('repository',Buffer.from(update.content)):current.get('state.json')?.value;
            if(!record)fail('repository record required');
            assertRepositoryWrite(record,history.repository);
            for(const prior of history.repositoryHistory)if(prior.value.schemaVersion===3)assertRepositoryWrite(record,prior.value);
            for(const file of request.changes.filter(file=>file.path.startsWith('cycles/'))) {
              const previous=history.cycles.find(r=>file.path===`cycles/${r.value.id}.json`);
              if(previous)cycleProgress(previous.value,decodeReleaseRecord('cycle',Buffer.from(file.content)));
              else if(current.has(file.path)&&current.get(file.path).value===null)fail('original cycle unavailable');
            }
            for(const file of request.changes.filter(file=>file.path.startsWith('official/'))) {
              const previous=history.domainRecords.find(record=>record.path===file.path);
              if(previous) officialReceiptProgress(file.path,previous.value,decodeStateFile(request.targetRef,file.path,Buffer.from(file.content),request.repositoryId));
            }
          }
          for(const file of request.changes.filter(file=>file.path.startsWith('maintenance/'))) {
            const previous=history.domainRecords.find(record=>record.path===file.path);
            if(previous && file.path.startsWith('maintenance/candidate-draft-')) {
              if(previous.content!==file.content)fail('candidate draft recovery is immutable');
            } else if(previous)(file.path.startsWith('maintenance/pages/')?assertPagesProgress:assertMaintenanceProgress)(previous.value,decodeStateFile(request.targetRef,file.path,Buffer.from(file.content),request.repositoryId));
          }
        }
      }
      if(proposal!==null && head!==null && await ancestry(proposal,head))
        return result(matches(current)?'APPLIED':'CONFLICT',head,matches(current)?'COMMIT_REACHABLE_AND_BYTES_MATCH':'ADOPTED_BYTES_CHANGED');
      if(matches(current))return result('UNCHANGED',head,'BYTES_ALREADY_MATCH');
      for(const file of request.changes) {
        const actual=current.get(file.path), prior=expected.get(file.path);
        if((actual?.sha256??null)!==file.previousSha256 && actual?.sha256!==file.sha256)return result('CONFLICT',head,'OWN_PATH_CHANGED');
        if(file.path.startsWith('cycles/') && actual?.value)cycleProgress(actual.value,decodeReleaseRecord('cycle',Buffer.from(file.content)));
        if(file.path.startsWith('cycles/') && prior?.value)cycleProgress(prior.value,decodeReleaseRecord('cycle',Buffer.from(file.content)));
      }
      if(proposal===null || parent!==head) {
        if(head!==null)await required('checkout','--detach','--force',head);
        else if(await localHead()!==null)fail('initial parent conflict');
        await noLinks(directory);
        for(const file of request.changes) {
          const path=join(directory,...file.path.split('/'));
          await mkdir(dirname(path),{recursive:true});
          await writeFile(path,Buffer.from(file.content,'utf8'));
        }
        // Exact allowlisted paths only; bounded argv also works on Windows when
        // a large content archive contains thousands of independent fragments.
        let staged=[], length=0;
        for(const path of request.allowedPaths) {
          if(staged.length && length+path.length+3>8000) { await required('add','--',...staged); staged=[];length=0; }
          staged.push(path);length+=path.length+3;
        }
        if(staged.length)await required('add','--',...staged);
        await required('commit','--signoff','--no-gpg-sign','-m',`Record ${request.writer} facts`);
        proposal=await localHead();parent=head;
        if(!hash(proposal) || await validateProposal(proposal)!==head)fail('prepared parent');
      }
      // Always a plain fast-forward push. Exit status is not adoption evidence;
      // the next iteration reads the exact ref and checks reachability/bytes.
      if(beforePush)await beforePush();
      await git('push','--porcelain',request.remote,`HEAD:${ref}`);
    }
    const observed=await remoteHead();
    if(observed.known && observed.head!==null && await fetchHead(observed.head) && proposal!==null && await ancestry(proposal,observed.head)) {
      const current=await tree(observed.head);
      await required('update-ref',ref,observed.head);
      return result(matches(current)?'APPLIED':'CONFLICT',observed.head,matches(current)?'COMMIT_REACHABLE_AND_BYTES_MATCH':'ADOPTED_BYTES_CHANGED');
    }
    return result('UNKNOWN',observed.head,'RETRY_FROM_PRESERVED_COMMIT');
  } catch(error) {
    if(error instanceof Error && (/^RELEASE_RECORD:/.test(error.message) ||
      ['RELEASE_REPOSITORY_PAUSED','RELEASE_PAUSE_POLICY_UNAVAILABLE'].includes(error.message)))throw error;
    throw new Error('RELEASE_RECORD: validation or local operation failed');
  } finally {
    busy.delete(directory);
    if(home)await rm(home,{recursive:true,force:true});
  }
}

/** Fixed state/native connection. Input selects one existing cycle, never supplies its evidence or a job list. */
export async function inspectReleaseEvidence(request,{token,io=nativeEvidenceTransport(token),centralIo,centralInvocation,publisher,publicationUnits,now=()=>new Date().toISOString()}={}) {
  exact(request,['directory','writeDirectory','remote','repository','repositoryId','defaultBranch','appBotId','cycleId','runId','identity']);
  if(!isAbsolute(request.directory)||!isAbsolute(request.writeDirectory)||!Number.isSafeInteger(request.appBotId)||request.appBotId<1
    || request.runId!==null && (!Number.isSafeInteger(request.runId)||request.runId<1))fail('evidence input');
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository)||request.repository.split('/').some(part=>part==='.'||part==='..'))fail('evidence repository');
  if(request.remote!==`https://github.com/${request.repository}.git` && !isAbsolute(request.remote))fail('evidence remote');
  let snapshot=await readReleaseRecords({directory:request.directory,targetRef:'steward/release-state',repositoryId:request.repositoryId,includeHistory:false});
  const recovered=await recoverReleaseCaches(request,snapshot,{token,io,centralIo,now});snapshot=recovered.snapshot;request={...request,directory:recovered.directory};assertRepositoryWrite(snapshot.repository);
  const cycle=snapshot.cycles.find(record=>record.value.id===request.cycleId)?.value;
  if(!cycle || snapshot.repository?.defaultBranch!==request.defaultBranch)fail('evidence cycle');
  if(cycle.dispatches.some(dispatch=>dispatch.canonicalRunId!==null&&!snapshot.domainRecords.some(record=>
    record.path.startsWith('evidence/native/')&&record.value.run.id===dispatch.canonicalRunId))) {
    const original=await readReleaseRecords({directory:request.directory,targetRef:'steward/release-state',repositoryId:request.repositoryId,includeHistory:true});
    if(original.head!==snapshot.head)fail('state snapshot must match native ref');snapshot=original;
  }

  const response=await io.request('GET',`/repos/${request.repository}/git/ref/heads/steward/release-state`);
  if(response.status!==200 || JSON.parse(Buffer.from(response.bytes).toString('utf8')).object?.sha!==snapshot.head)fail('state snapshot must match native ref');
  const context={repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle};
  const history=snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/native/')).map(record=>({path:record.path,commit:record.commit,value:record.value}));
  const publications=snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/publication/')&&record.value.cycleId===cycle.id
    &&(!publicationUnits || record.value.centralRun.id===centralInvocation?.runId&&record.value.centralRun.runAttempt===centralInvocation?.runAttempt
      || record.value.targets.some(target=>publicationUnits.has(target.unitId))));
  const publication=centralIo?await inspectPublications(context,publications,io,centralIo,now()):
    {native:{complete:publications.length===0,runs:[],attempts:[]},files:[],missing:publications.length?['central-publication:read-credential-required']:[]};
  const readHistory={complete:true,publication,channelEvidence:snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/channel/')||record.path.startsWith('evidence/channel-read/')),sourceRejections:snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/source-rejection/')),retryLimits:snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/retry-limit/')),observations:snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/reads/')).map(record=>record.value)};
  const store={archive:async files=>{
    if(!files.length)return {status:'UNCHANGED',head:snapshot.head,records:history};
    const batch=sha256(JSON.stringify([snapshot.head,files.map(file=>[file.path,file.sha256]).sort()]));
    await mkdir(request.writeDirectory,{recursive:true});
    const directory=join(request.writeDirectory,batch);
    const written=await writeReleaseRecords({directory,remote:request.remote,repositoryId:request.repositoryId,defaultBranch:request.defaultBranch,
      targetRef:'steward/release-state',writer:'release',expectedHead:snapshot.head,allowedPaths:files.map(file=>file.path),
      changes:files.map(file=>({...file,previousSha256:snapshot.currentPaths.includes(file.path)?file.sha256:null})),identity:request.identity},{token});
    if(!['APPLIED','UNCHANGED'].includes(written.status))return {...written,records:[]};
    const readback=await readReleaseRecords({directory,targetRef:'steward/release-state',repositoryId:request.repositoryId,includeHistory:false});
    if(readback.head!==written.head || JSON.stringify(readback.cycles.find(record=>record.value.id===cycle.id)?.value)!==JSON.stringify(cycle))
      return {status:'CONFLICT',head:readback.head,records:[]};
    const nativeRef=await io.request('GET',`/repos/${request.repository}/git/ref/heads/steward/release-state`);
    if(nativeRef.status!==200 || JSON.parse(Buffer.from(nativeRef.bytes).toString('utf8')).object?.sha!==written.head)
      return {status:'UNKNOWN',head:written.head,records:[]};
    for(const file of files.filter(file=>file.path.startsWith('evidence/publication/'))) {
      const value=JSON.parse(file.content);
      if(value.startEvidencePath===null&&readback.domainRecords.some(other=>other.path.startsWith('evidence/publication/')&&other.path!==file.path
        &&other.value.startEvidencePath===null&&other.value.execution.invocationKey===value.execution.invocationKey))return {status:'CONFLICT',head:readback.head,records:[]};
    }
    snapshot=readback;request.directory=directory;
    return {...written,files:files.filter(file=>readback.domainRecords.some(record=>record.path===file.path&&JSON.stringify(record.value)===JSON.stringify(JSON.parse(file.content)))),records:readback.domainRecords.filter(record=>record.path.startsWith('evidence/native/')).map(record=>({path:record.path,commit:record.commit,value:record.value}))};
  }};
  const observedAt=now();
  if(publication.files.length) {const saved=await store.archive(publication.files);if(!['APPLIED','UNCHANGED'].includes(saved.status))return {status:'UNKNOWN',reason:'PUBLICATION_ARCHIVE_NOT_ADOPTED'};}
  if(publisher&&centralIo&&centralInvocation) {
    const frozenPublicationBuilds=new Map();
    if(cycle.workflowDelivery&&publicationUnits) {
      for(const id of publicationUnits) {
        const delivery=cycle.units.find(unit=>unit.id===id)?.githubDelivery;
        if(!delivery)fail('publication frozen workflow delivery required');
        const buildAttempt=delivery.buildAttempt??delivery.attempt;
        frozenPublicationBuilds.set(delivery.runId,Math.max(buildAttempt,frozenPublicationBuilds.get(delivery.runId)??0));
      }
    }
    const observation=await inspectNativeCycle(context,history,io,observedAt,{...readHistory,frozenPublicationBuilds});
    const saved=await store.archive([...observation.archives.map(archiveFile),nativeReadFile(observation.readObservation)]);
    if(!['APPLIED','UNCHANGED'].includes(saved.status)||observation.currentFacts.unknownEvidence.length||observation.currentFacts.conflictEvidence.length)return {status:'UNKNOWN',reason:'PUBLICATION_EVIDENCE_UNKNOWN',publishInvoked:false};
    if(observation.currentFacts.inFlightWaveKeys.length)return {status:'WAIT',reason:'RUN_IN_FLIGHT',publishInvoked:false};

    return invokePublication(context,centralInvocation,publications,store,io,centralIo,()=>publisher(context,async next=>{
      const adopted=await adoptReleaseCycle(request,snapshot,next,{token,io});
      snapshot=adopted.snapshot;request.directory=adopted.directory;Object.assign(cycle,next);
    }),now(),now,publicationUnits);
  }
  if(request.runId!==null)return recoverNativeCycle(context,request.runId,store,history,io,observedAt,readHistory);
  const observation=await inspectNativeCycle(context,history,io,observedAt,readHistory);
  const saved=await store.archive([...observation.archives.map(archiveFile),nativeReadFile(observation.readObservation)]);
  return {status:['APPLIED','UNCHANGED'].includes(saved.status)?observation.readObservation.disposition==='UNRECOVERABLE'?'BLOCKED':'OBSERVED':'UNKNOWN',archiveHead:saved.head,observation};
}

/** Persist exact frozen inputs or a native Release binding with the existing fast-forward writer. */
async function adoptReleaseCycle(request,snapshot,cycle,{token,io,beforePush},extraFiles=[]) {
  decodeReleaseRecord('cycle',Buffer.from(JSON.stringify(cycle)));
  await assertReleaseWriterProtection(request.repository,'steward/release-state',io,{token});
  const path=`cycles/${cycle.id}.json`,content=JSON.stringify(cycle,null,2)+'\n';
  const home=await mkdtemp(join(tmpdir(),'steward-cycle-read-'));let previous;
  try {previous=(await promisify(execFile)('git',['--no-replace-objects','-c','core.hooksPath=','-C',request.directory,'show',`${snapshot.head}:${path}`],
    {env:isolatedBuildEnvironment(process.env,home),encoding:'buffer',windowsHide:true,maxBuffer:16*1024*1024})).stdout;}
  finally{await rm(home,{recursive:true,force:true});}
  const files=extraFiles.filter(file=>!snapshot.domainRecords.some(record=>record.path===file.path&&record.content===file.content));
  if(previous.equals(Buffer.from(content))&&!files.length)return {snapshot,directory:request.directory};
  await mkdir(request.writeDirectory,{recursive:true});const directory=join(request.writeDirectory,'cycle-'+sha256(snapshot.head+content+JSON.stringify(files.map(file=>file.sha256))));
  const written=await writeReleaseRecords({directory,remote:request.remote,repositoryId:request.repositoryId,defaultBranch:request.defaultBranch,
    targetRef:'steward/release-state',writer:'release',expectedHead:snapshot.head,allowedPaths:[path,...files.map(file=>file.path)],
    changes:[{path,content,sha256:sha256(content),previousSha256:sha256(previous)},...files.map(file=>{
      const current=snapshot.domainRecords.find(record=>record.path===file.path);
      return {...file,previousSha256:snapshot.currentPaths.includes(file.path)
        ?(file.path.startsWith('official/')&&current?sha256(current.content):file.sha256):null};
    })],identity:request.identity},{token,beforePush});
  if(!['APPLIED','UNCHANGED'].includes(written.status))fail('cycle write unconfirmed');
  const next=await readReleaseRecords({directory,targetRef:'steward/release-state',repositoryId:request.repositoryId,includeHistory:false});
  const ref=await io.request('GET',`/repos/${request.repository}/git/ref/heads/steward/release-state`);
  if(next.head!==written.head||ref.status!==200||JSON.parse(Buffer.from(ref.bytes).toString('utf8')).object?.sha!==next.head
    ||JSON.stringify(next.cycles.find(record=>record.value.id===cycle.id)?.value)!==JSON.stringify(cycle)
    ||files.some(file=>!next.domainRecords.some(record=>record.path===file.path&&record.content===file.content)))fail('cycle binding readback');
  return {snapshot:next,directory};
}

/** Bind the verified merged official PR before the existing product dispatch can acquire work. */
export async function registerOfficialMergedCycle(request,snapshot,receipt,{config,delivery,workflow,controllerSha,token,io,readBytes,admit}) {
  const repository=snapshot.repository;
  assertRepositoryWrite(repository);
  if(receipt.repositoryId!==request.repositoryId||receipt.repository!==request.repository||receipt.defaultBranch!==request.defaultBranch
    || receipt.authorId!==request.appBotId||receipt.path!=='.'||repository.defaultBranch!==request.defaultBranch
    || sha256(config)!==receipt.configDigest||sha256(receipt.body)!==receipt.bodyDigest)
    fail('official merge source');
  const cycle=mergedBuildCycle({prNumber:receipt.prNumber,sourceSha:receipt.sourceSha,controllerSha,repository:request.repository,
    repositoryId:request.repositoryId,deliveryBlobSha:createHash('sha1').update(`blob ${delivery.length}\0`).update(delivery).digest('hex'),
    delivery:JSON.parse(delivery.toString('utf8')),releasePlease:JSON.parse(config.toString('utf8')),workflow,
    units:[{id:'root',path:receipt.path,version:receipt.version,tag:receipt.tag}],
    officialRelease:{headSha:receipt.candidateHead,pullBodyDigest:receipt.pullBodyDigest,bodyDigest:receipt.bodyDigest}});
  const existing=snapshot.cycles.find(item=>item.value.id===cycle.id)?.value;
  if(existing) {
    // The original controller also remains fixed when a delayed merge event reaches a newer controller.
    if(!compatibleCycle(existing,{...cycle,controllerSha:existing.controllerSha}))fail('official merge receipt conflict');
    return {status:'CYCLE_READY',cycleId:existing.id,sourceSha:existing.sourceSha};
  }
  if(snapshot.cycles.some(item=>item.value.prNumber===cycle.prNumber||item.value.sourceSha===cycle.sourceSha))
    fail('official merge already bound');
  const active=snapshot.cycles.find(item=>item.value.id===repository.activeCycleId)?.value;
  if(active&&!active.officialRelease&&!active.completedEvidencePath)return {status:'WAIT',reason:'LEGACY_RELEASE_CYCLE_ACTIVE'};
  const state={...repository,activeCycleId:cycle.id,revision:repository.revision+1};
  const previous=await readBytes('state.json');
  const merged=officialReceiptFile(request,cycle,'merged',{mergedAt:receipt.mergedAt,bodyBase64:Buffer.from(receipt.body,'utf8').toString('base64')});
  const changes=[{path:'state.json',content:JSON.stringify(state,null,2)+'\n',previousSha256:sha256(previous)},
    {path:`cycles/${cycle.id}.json`,content:JSON.stringify(cycle,null,2)+'\n',previousSha256:null},
    {...merged,previousSha256:null}];
  await assertReleaseWriterProtection(request.repository,'steward/release-state',io,{token});
  await admit();
  const written=await writeReleaseRecords({directory:join(request.writeDirectory,'register-official'),remote:request.remote,
    repositoryId:request.repositoryId,defaultBranch:request.defaultBranch,targetRef:'steward/release-state',writer:'release',
    expectedHead:snapshot.head,allowedPaths:changes.map(file=>file.path),changes:changes.map(file=>({...file,sha256:sha256(file.content)})),
    identity:request.identity},{token,beforePush:admit});
  if(!['APPLIED','UNCHANGED'].includes(written.status))fail('official merge state write');
  const adopted=await readReleaseRecords({directory:join(request.writeDirectory,'register-official'),targetRef:'steward/release-state',
    repositoryId:request.repositoryId,includeHistory:false});
  const ref=await new NativeEvidenceReader(io,request.repository).json('git/ref/heads/steward/release-state');
  if(adopted.head!==written.head||ref.ref!=='refs/heads/steward/release-state'||ref.object?.type!=='commit'
    ||ref.object.sha!==written.head||adopted.repository.activeCycleId!==cycle.id
    || JSON.stringify(adopted.cycles.find(item=>item.value.id===cycle.id)?.value)!==JSON.stringify(cycle)
    || !adopted.domainRecords.some(record=>record.path===merged.path&&record.content===merged.content))fail('official merge state readback');
  return {status:'CYCLE_READY',cycleId:cycle.id,sourceSha:cycle.sourceSha};
}

/** Once-per-source historical normalization. Unknown permission never selects the legacy path. */
async function ensureCycleDelivery(request,snapshot,cycle,{token,io,centralIo,now}) {
  const context={repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle};
  try {const {delivery}=await readCycleDelivery(context,snapshot.domainRecords,io);return {snapshot,directory:request.directory,delivery};}
  catch(error) {
    if(error?.message!=='RELEASE_PIPELINE: NORMALIZED_DELIVERY_EVIDENCE_REQUIRED')throw error;
    const file=await prepareNormalizedDelivery(context,io,centralIo,now());
    const adopted=await adoptReleaseCycle(request,snapshot,cycle,{token,io},[file]);
    const {delivery}=await readCycleDelivery(context,adopted.snapshot.domainRecords,io);
    return {...adopted,delivery};
  }
}

/** Central App publisher. Frozen metadata is adopted before the native invocation and each exact ID before upload. */
export async function publicationAssetFacts(unit,manifest,names,directory) {
  const reserved=new Set([...manifest.artifacts.map(asset=>asset.id),...unit.assets.map(asset=>asset.id)]),assets=[];
  for(const path of names) {
    const bytes=await readFile(join(directory,path)),business=manifest.artifacts.find(asset=>asset.path===path);
    let id=unit.assets.find(asset=>asset.path===path)?.id??business?.id;
    if(!id) {const base='metadata-'+path.toLowerCase().replaceAll('.', '-');id=base;let suffix=0;while(reserved.has(id))id=base+'-'+(++suffix);}
    reserved.add(id);assets.push({id,path,size:bytes.length,sha256:sha256(bytes)});
  }
  return assets;
}
async function confirmFrozenCycle(request,snapshot,cycle,{token,io,now}) {
  // Older workflow freezes can recover their exact attempt from protected native evidence.
  if(!cycle.freezeCompletedAt || cycle.workflowDelivery&&cycle.freezeBuildAttempt===undefined) {
    const context={repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle};
    let attempt;
    try {attempt=await verifyFrozenReceipts(context,snapshot.domainRecords,io);}
    catch(error) {
      if(error?.message==='BUILD_RUN_NOT_READY')return {status:'WAIT',reason:'BUILD_RUN_NOT_READY',publishInvoked:false};
      return {status:'UNKNOWN',reason:'FROZEN_BUILD_SOURCE_UNAVAILABLE',publishInvoked:false};
    }
    const confirmed={...cycle,freezeCompletedAt:cycle.freezeCompletedAt??now(),...(attempt===undefined?{}:{freezeBuildAttempt:attempt})};
    snapshot=(await adoptReleaseCycle(request,snapshot,confirmed,{token,io})).snapshot;
  }
  return {status:'FROZEN',reason:'NO_PUBLICATION_CHANNELS',archiveHead:snapshot.head,publishInvoked:false};
}
async function verifyFormalPublication(context,io,token,unitIds) {
  await verifyContinuationReleases(context,io,unitIds);
  if(context.cycle.officialRelease) {
    if(!token)fail('official formal proof credential');
    for(const unit of githubUnits(context.cycle).filter(unit=>!unitIds||unitIds.has(unit.id)))
      await verifyOfficialPublicationProof(context,unit.id,args=>nativeGhCommand(args,token),nativeReleaseDownload(token));
  }
}
export async function verifyDraftAssetReceipts(reader,releaseId,receipts,expected) {
  const assets=await reader.pages('releases/'+releaseId+'/assets','');
  if(assets.length!==receipts.length)fail('official draft receipt assets changed');
  for(const {assetId,name} of receipts) {
    const asset=assets.find(item=>item.id===assetId),file=expected.find(item=>item.path===name);
    if(!file||asset?.name!==name||asset.state!=='uploaded'||asset.size!==file.size)
      fail('official draft receipt assets changed');
    if(asset.digest) {
      if(asset.digest!=='sha256:'+file.sha256)fail('official draft receipt assets changed');
    } else {
      const downloaded=await reader.downloadDigest('releases/assets/'+assetId);
      if(downloaded.size!==file.size||downloaded.digest!==file.sha256)fail('official draft receipt assets changed');
    }
  }
}
async function observeReadyDraft(request,snapshot,context,{token,io,verifyPublic=true}) {
  const {cycle}=context,ready=draftReadyResult(snapshot,cycle);
  if(!ready)return null;
  const reader=new NativeEvidenceReader(io,request.repository);
  const release=await reader.json('releases/'+ready.draft.releaseId);
  if(release.id!==ready.draft.releaseId||release.tag_name!==ready.draft.tag||typeof release.draft!=='boolean')
    fail('official release ready identity');
  if(!release.draft) {
    if(!verifyPublic)return {status:'WAIT',reason:'FORMAL_RELEASE_READBACK_REQUIRED',publishInvoked:false};
    await verifyFormalPublication(context,io,token);
    return {status:'OBSERVED',reason:'FORMAL_RELEASES_VERIFIED',publishInvoked:false};
  }
  await readBoundOfficialDraft(approvedCycleTarget(context,request.defaultBranch),reader);
  await verifyDraftAssetReceipts(reader,ready.draft.releaseId,ready.draft.assets,cycle.units[0].assets);
  return ready;
}
export async function publishNativeCycle(request,{token,io=nativeEvidenceTransport(token),centralIo,centralInvocation,controllerDirectory,official,now=()=>new Date().toISOString()}) {
  if(!token||!centralIo||!centralInvocation||!isAbsolute(controllerDirectory))fail('central publisher identity');
  const root=await mkdtemp(join(tmpdir(),'steward-publication-'));
  try {
    let snapshot=await readReleaseRecords({directory:request.directory,targetRef:'steward/release-state',repositoryId:request.repositoryId,includeHistory:false});
  const recovered=await recoverReleaseCaches(request,snapshot,{token,io,centralIo,now});snapshot=recovered.snapshot;request={...request,directory:recovered.directory};assertRepositoryWrite(snapshot.repository);
    const cycle=structuredClone(snapshot.cycles.find(record=>record.value.id===request.cycleId)?.value);
    if(!cycle)fail('registered publication cycle required');
    const context={repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle};
    if(official?.stage&&!cycle.officialRelease)
      return {status:'WAIT',reason:'OFFICIAL_RELEASE_NOT_ADOPTED',publishInvoked:false};
    if(cycle.officialRelease) {
      const ready=await observeReadyDraft(request,snapshot,context,{token,io,verifyPublic:!official?.stage});
      if(ready) return ready;
    }
    const targets=githubUnits(cycle),reader=new NativeEvidenceReader(io,request.repository);
    const normalized=await ensureCycleDelivery(request,snapshot,cycle,{token,io,centralIo,now});snapshot=normalized.snapshot;request={...request,directory:normalized.directory};
    const alreadyPublished=new Set(),unavailable=new Set(),rejected=[];
    for(const unit of targets.filter(unit=>unit.releaseId!==null)) {
      const release=await reader.json('releases/'+unit.releaseId);
      if(!cycle.officialRelease&&release.draft!==false)
        return {status:'WAIT',reason:'LEGACY_PUBLICATION_READ_ONLY',publishInvoked:false};
      if(release.draft===false) {
        if(official?.stage)return {status:'WAIT',reason:'FORMAL_RELEASE_READBACK_REQUIRED',publishInvoked:false};
        await verifyFormalPublication(context,io,token,new Set([unit.id]));
        alreadyPublished.add(unit.id);
      }
    }
    if(alreadyPublished.size&&alreadyPublished.size===targets.length)return {status:'OBSERVED',reason:'FORMAL_RELEASES_VERIFIED',publishInvoked:false};
    if(cycle.officialRelease&&!official?.enabled)
      return {status:'WAIT',reason:'OFFICIAL_RELEASE_DISABLED',publishInvoked:false};
    const approval=cycle.officialRelease?approvedCycleTarget(context,request.defaultBranch):null;
    const isOfficialPreparation=approval&&official.stage==='prepare';
    if(approval&&official.stage==='select') {
      const delivery=await selectWorkflowGithubDelivery(context,reader,
        (path,field)=>reader.pages(path.slice(`repos/${request.repository}/`.length).replace(/\?per_page=100$/,''),field),official.attempt);
      return {status:'WAIT',reason:'OFFICIAL_RELEASE_DELIVERY_SELECTED',publishInvoked:false,
        officialDelivery:{repository:request.repository,cycleId:cycle.id,...delivery}};
    }
    if(isOfficialPreparation&&approval.releaseId!==null)
      return {status:'WAIT',reason:'BOUND_OFFICIAL_DRAFT_READY',publishInvoked:false};
    if(approval&&!isOfficialPreparation&&approval.releaseId===null&&!official.ready)
      return await official.preparation(cycle.id);
    if(approval) {
      const merged=officialReceipt(snapshot,cycle,'merged');
      if(merged) {
        const bytes=Buffer.from(merged.bodyBase64,'base64');
        if(bytes.toString('base64')!==merged.bodyBase64 || sha256(bytes)!==approval.bodyDigest) fail('official merged body digest');
        approval.frozenBody=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      }
    }
    const officialDraft=approval&&!isOfficialPreparation?(approval.releaseId===null
      ?await official.confirm(approval):await readBoundOfficialDraft(approval,reader)):null;
    const officialBody=approval?(approval.frozenBody??officialDraft?.body??await official.readBody(approval)):undefined;
    const selected=approval?official.selectedDelivery:undefined;
    if(approval&&(!selected||selected.repository!==request.repository||selected.cycleId!==cycle.id))
      fail('official release original delivery selection required');
    const pending=alreadyPublished.size||unavailable.size
      ?new Set(targets.filter(unit=>!alreadyPublished.has(unit.id)&&!unavailable.has(unit.id)).map(unit=>unit.id)):undefined;
    const records=await pipelinePreparePublication(context,root,controllerDirectory,token,undefined,io,undefined,undefined,snapshot.domainRecords,
      pending,approval?official.download:undefined,cycle.workflowDelivery?unitId=>unavailable.add(unitId):undefined,
      cycle.workflowDelivery?(unitId,reason)=>rejected.push({unitId,channelId:'github-release',reason}):undefined,officialBody,selected);
    if(!Array.isArray(records))return records;
    if(cycle.workflowDelivery&&!targets.length)return cycle.requiredChannels.length
      ?{status:'WAIT',reason:'FORMAL_RELEASE_REQUIRED',publishInvoked:false}:confirmFrozenCycle(request,snapshot,cycle,{token,io,now});
    const deliveryDetails={...(unavailable.size?{units:[...unavailable].sort()}:{}),...(rejected.length?{rejected}:{})};
    if(!records.length&&rejected.length)return {status:'BLOCKED',reason:'WORKFLOW_GITHUB_DELIVERY_INVALID',publishInvoked:false,...deliveryDetails};
    if(!records.length&&unavailable.size)return {status:'UNKNOWN',reason:'WORKFLOW_GITHUB_DELIVERY_REQUIRED',publishInvoked:false,...deliveryDetails};
    const adapter=new NativeGitHubRelease(args=>nativeGhCommand(args,token),nativeReleaseDownload(token));
    const target=(item,releaseId)=>({delivery:item.delivery,publicBody:item.publicBody,manifest:item.manifest,
      directory:item.directory,releaseId,appBotId:request.appBotId,
      ...(officialDraft?{official:{prerelease:officialDraft.prerelease}}:{})});
    const publicationUnits=records.filter(item=>!item.delivery?.channels.some(channel=>channel.id==='github-release' && !channel.required));
    const freezeRecords=records.filter(item=>!publicationUnits.includes(item));
    if(!cycle.officialRelease&&publicationUnits.length)
      return {status:'WAIT',reason:'LEGACY_PUBLICATION_READ_ONLY',publishInvoked:false};
    if (freezeRecords.length) {
      const receipts=[...(cycle.freezeOnly ?? [])];
      for(const item of freezeRecords) {
        const unit=cycle.units.find(unit=>unit.id===item.unitId);
        if(!item.archive || !unit || unit.releaseId!==null || cycle.requiredChannels.some(channel=>channel.unitId===unit.id))
          fail('freeze-only archive identity');
        const names=adapter.names({manifest:item.manifest,directory:item.directory,releaseId:null,appBotId:request.appBotId});
        unit.assets=await publicationAssetFacts(unit,item.manifest,names,item.directory);
        unit.notesDigest=sha256(await readFile(join(item.directory,'release-notes.md')));
        unit.manifestDigest=sha256(await readFile(join(item.directory,'artifact-manifest.json')));
        receipts.push({unitId:item.unitId,runId:item.archive.runId,attempt:item.archive.attempt,
          producerAttempt:item.archive.producerAttempt,artifactId:item.archive.artifactId,archiveDigest:item.archive.digest});
      }
      cycle.freezeOnly=receipts;
    }
    for(const item of publicationUnits) {
      const unit=cycle.units.find(value=>value.id===item.unitId),names=adapter.names(target(item,unit.releaseId));
      const assets=await publicationAssetFacts(unit,item.manifest,names,item.directory);
      const frozen={assets,notesDigest:sha256(item.publicBody??await readFile(join(item.directory,'release-notes.md'))),
        manifestDigest:await publicationManifestDigest(item.directory,item.manifest),
        ...(item.githubDelivery?{githubDelivery:item.githubDelivery}:{})};
      if(unit.assets.length&&JSON.stringify(ordered(unit.assets))!==JSON.stringify(ordered(assets))
        ||unit.manifestDigest!==null&&unit.manifestDigest!==frozen.manifestDigest
        ||unit.notesDigest!==null&&unit.notesDigest!==frozen.notesDigest)fail('frozen publication changed');
      Object.assign(unit,frozen);
    }
    if(isOfficialPreparation) {
      if(publicationUnits.length!==1||freezeRecords.length||publicationUnits[0].manifest.schemaVersion!==4)
        fail('official release original delivery required');
      const item=publicationUnits[0];
      await adapter.freezeProof(target(item,cycle.units[0].releaseId));
      await official.admit();
      cycle.officialDraftScopeDigest??=await readOfficialScope(approval,token,officialBody);
      const adopted=await adoptReleaseCycle(request,snapshot,cycle,{token,io,beforePush:official.admit});
      return {status:'WAIT',reason:'OFFICIAL_RELEASE_PREFLIGHT_READY',publishInvoked:false,
        officialPlan:{approval,stateHead:adopted.snapshot.head,scopeDigest:cycle.officialDraftScopeDigest}};
    }
    const save=async (files,beforePush)=>{
      const adopted=await adoptReleaseCycle(request,snapshot,cycle,{token,io,beforePush},files);
      snapshot=adopted.snapshot;
      request={...request,directory:adopted.directory};
    };
    if(!githubUnits(cycle).length) {
      await save([]);
      return confirmFrozenCycle(request,snapshot,cycle,{token,io,now});
    }
    if(!officialDraft||publicationUnits.length!==1)fail('official draft confirmation required');
    const unit=cycle.units[0],item=publicationUnits[0],bound=await adapter.claimOfficialDraft(target(item,unit.releaseId));
    if(bound.releaseId!==officialDraft.releaseId)fail('official draft changed after action');
    const release=await adapter.read(bound),url=new URL(release.html_url);
    if(!release.draft||url.origin!=='https://github.com'||!url.pathname.startsWith(`/${request.repository}/releases/`))
      fail('official draft URL');
    unit.releaseId=bound.releaseId;
    const current=officialReceipt(snapshot,cycle,'draft');
    if(current&&(current.releaseId!==unit.releaseId||current.url!==url.href))fail('official draft binding changed');
    const draft={releaseId:unit.releaseId,url:url.href,assets:current?.assets??[],readyAt:null};
    const saveDraft=async()=>{
      await official.admit();
      await save([officialReceiptFile(request,cycle,'draft',draft)],official.admit);
    };
    await saveDraft();
    const finished=await adapter.uploadDraft(bound,[...draft.assets],async asset=>{
      draft.assets.push(asset);
      await saveDraft();
    },official.admit);
    if(finished.releaseId!==draft.releaseId||finished.url!==draft.url
      || JSON.stringify(ordered(finished.assets))!==JSON.stringify(ordered(draft.assets))) fail('official draft attachments changed');
    draft.readyAt=now();
    await saveDraft();
    return draftReadyResult(snapshot,cycle);
  }finally{await rm(root,{recursive:true,force:true});}
}

export async function assertReleaseWriterProtection(repository,branch,io,{token,fetcher=fetch,readCentralMaintenanceRules}={}) {
  const build=/^steward\/build\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)&&!branch.includes('..');
  if(!build&&branch!=='steward/release-state')fail('writer protection target');
  const native=async path=>{const response=await io.request('GET',`/repos/${repository}${path?'/'+path:''}`);if(response.status!==200)fail('writer protection read unavailable');return JSON.parse(Buffer.from(response.bytes).toString('utf8'));};
  const rules=[];
  for(let page=1;;page++) {
    if(page>10000)fail('writer protection pagination');
    const batch=await native(`rules/branches/${encodeURIComponent(branch)}?per_page=100&page=${page}`);
    if(!Array.isArray(batch))fail('protected writer rules');rules.push(...batch);if(batch.length<100)break;
  }
  const required=build?['creation','update','deletion']:['creation','update','non_fast_forward','deletion'];
  if(!required.every(type=>rules.some(rule=>rule.type===type&&Number.isSafeInteger(rule.ruleset_id))))fail('protected writer rules');
  const relevant=rules.filter(rule=>['creation','update','non_fast_forward','deletion'].includes(rule.type));
  let fixedRules;
  if(readCentralMaintenanceRules) {
    if(repository!=='splrad/steward'||branch!=='steward/release-state')fail('central maintenance protection target');
    const ids={creation:26678450,update:26678450,deletion:26678449,non_fast_forward:26678449};
    if(!relevant.every(r=>r.ruleset_id===ids[r.type]&&r.ruleset_source_type==='Organization'))fail('central maintenance effective rules');
    fixedRules=await readCentralMaintenanceRules();
    if(!Array.isArray(fixedRules)||fixedRules.length!==2)fail('central maintenance rules');
  }
  let client;
  for(const id of new Set(relevant.map(rule=>rule.ruleset_id))) {
    if(!Number.isSafeInteger(id)||id<1)fail('protected writer rules');
    let rule=fixedRules?fixedRules.find(entry=>entry.id===id):await native(`rulesets/${id}`);
    if(rule?.id!==id||rule.enforcement!=='active'||rule.target!=='branch'||!Array.isArray(rule.bypass_actors)||!Array.isArray(rule.rules)
      ||relevant.filter(value=>value.ruleset_id===id).some(value=>!rule.rules.some(item=>item.type===value.type)))fail('writer protection identity');
    if(rule.rules.some(value=>value.type==='update'&&value.parameters===undefined)) {
      if(!token)fail('writer update parameters unavailable');
      client??=new Octokit({auth:token,log:{debug(){},info(){},warn(){},error(){}},request:{fetch:fetcher,timeout:60_000,headers:{'x-github-api-version':apiVersion.version}}});
      rule=await completeNativeRuleParameters(client,rule);
    }
    // App creation/update authority and immutable history are separate native rulesets.
    const types=rule.rules.map(value=>value.type);
    if(types.includes('creation')||!build&&types.includes('update')) {
      if(rule.bypass_actors.length!==1||rule.bypass_actors[0].actor_type!=='Integration'
        ||rule.bypass_actors[0].actor_id!==4243096||rule.bypass_actors[0].bypass_mode!=='always')fail('single App writer required');
    }
    if(types.includes('deletion')||types.includes('non_fast_forward')||build&&types.includes('update')) {
      if(rule.bypass_actors.length!==0)fail('writer integrity bypass');
    }
    if(rule.rules.some(value=>value.type==='update'&&value.parameters?.update_allows_fetch_and_merge!==false))fail('writer fetch and merge exception');
  }
}

/** Fixed Git/native history reader. E05/E06 supply fresh source/channel observations through one trusted I/O boundary. */
export async function inspectRepositoryHistory(request,{token,io=nativeEvidenceTransport(token),completionReader,now=()=>new Date().toISOString(),handoff,centralIo,beforeArchivePush}={}) {
  let snapshot=await readReleaseRecords({directory:request.directory,targetRef:'steward/release-state',repositoryId:request.repositoryId,includeHistory:true});
  const native=async path=>{const response=await io.request('GET',`/repos/${request.repository}${path?'/'+path:''}`);if(response.status!==200)fail('history native read');return JSON.parse(Buffer.from(response.bytes).toString('utf8'));};
  if(snapshot.repository?.schemaVersion!==3)return {result:'UNKNOWN',inventoryComplete:false,reason:'RELEASE_ADOPTION_REQUIRED'};
  if(handoff&&snapshot.repository.candidate?.prNumber!==handoff.prNumber)
    return {result:'UNKNOWN',inventoryComplete:false,reason:'HANDOFF_CANDIDATE_CHANGED'};
  const recovered=await recoverReleaseCaches(request,snapshot,{token,io,now});snapshot=recovered.snapshot;request={...request,directory:recovered.directory};assertRepositoryWrite(snapshot.repository);
  return withReleaseAdoption(request,snapshot.repository.releaseAdoption,io,async({defaultHead,reachable,verifySource})=>{
  const freshFiles=[];
  const fresh=completionReader?async cycle=>{
    const value=await completionReader(cycle);
    if(value.source.units.some(unit=>unit.authorId!==request.appBotId))fail('completion App author');
    const file=completionFile(value);freshFiles.push(file);
    return {cycleId:cycle.id,source:value.source,observation:value.observation,kind:'live',provenanceComplete:value.provenance.every(proof=>snapshot.domainRecords.some(record=>
      record.path===proof.path&&record.content!==undefined&&sha256(record.content)===proof.digest))};
  }:undefined;
  const originalState=async commit=>{
    if(!hash(commit))fail('original state commit');
    const profile=await mkdtemp(join(tmpdir(),'steward-original-state-'));
    try {
      const env=isolatedBuildEnvironment(process.env,profile);
      const git=async(...args)=>(await promisify(execFile)('git',['--no-replace-objects','-c','core.hooksPath=','-c','core.fsmonitor=false',...args],{cwd:request.directory,env,encoding:'buffer',windowsHide:true,maxBuffer:32*1024*1024})).stdout;
      await git('merge-base','--is-ancestor',commit,snapshot.head);
      const paths=(await git('ls-tree','-r','--name-only',commit)).toString().trim().split('\n');
      const cycles=[],completions=[];
      for(const path of paths.filter(path=>path.startsWith('cycles/')))cycles.push(decodeReleaseRecord('cycle',await git('show',`${commit}:${path}`)));
      for(const path of paths.filter(path=>path.startsWith('evidence/completion/'))) {
        const bytes=await git('show',`${commit}:${path}`),value=decodeCompletionArchive(bytes);
        if(!path.endsWith('/'+sha256(bytes)+'.json')||value.source.units.some(unit=>unit.authorId!==request.appBotId))fail('original completion provenance');
        for(const proof of value.provenance) {
          const raw=await git('show',`${commit}:${proof.path}`);
          if(sha256(raw)!==proof.digest)fail('original raw evidence');
          decodeStateFile('steward/release-state',proof.path,raw,request.repositoryId);
        }
        completions.push(value);
      }
      return {cycles,completions};
    }finally{await rm(profile,{recursive:true,force:true});}
  };
  const historySnapshot={...snapshot,repository:request.repository,defaultBranch:request.defaultBranch,appBotId:request.appBotId,
    defaultHead,releaseAdoption:snapshot.repository.releaseAdoption,reachable};
  const history=await inspectCycleHistory(historySnapshot,io,now(),fresh,originalState,verifySource,handoff);
  if(history.result!=='PASS'||!history.inventoryComplete)return history;
  // The adapter writes the complete cycle and merged-candidate archive together.
  // Do not retire the candidate or mutate the state between proof and handoff.
  if(handoff)return history;
  const files=[...freshFiles],changes=[];
  for(const file of files)changes.push({...file,previousSha256:snapshot.currentPaths.includes(file.path)?file.sha256:null});
  for(const {value:cycle} of snapshot.cycles) {
    const file=files.find(file=>JSON.parse(file.content).cycleId===cycle.id);if(!file)continue;
    const value=JSON.parse(file.content),next={...cycle,completedEvidencePath:file.path,completionObservations:[...cycle.completionObservations.filter(item=>item.evidencePath!==file.path),
      {inputSetDigest:sha256(JSON.stringify(value.source)),evidenceSetDigest:sha256(JSON.stringify(value.observation)),observedAt:value.observation.observedAt,evidencePath:file.path}]};
    const content=JSON.stringify(next,null,2)+'\n';
    // Recover exact current bytes, including formatting, from the protected tree.
    const prior=snapshot.history.find(record=>record.path===`cycles/${cycle.id}.json`&&record.status==='DECODED');
    const raw=await native(`git/blobs/${prior.blobSha}`);const bytes=Buffer.from(raw.content,'base64');
    changes.push({path:`cycles/${cycle.id}.json`,content,sha256:sha256(content),previousSha256:sha256(bytes)});
  }
  // Completion retires the candidate belonging to a proved merged cycle. An
  // already opened next candidate is not a completed obligation or a cache to clear.
  const completedCandidate=history.discovered.some(fact=>fact.prNumber===snapshot.repository.candidate?.prNumber);
  const next={...snapshot.repository,revision:snapshot.repository.revision+1,activeCycleId:null,
    candidate:completedCandidate?null:snapshot.repository.candidate,lastCompletedCycleId:history.lastCompletedCycleId,
    lastObservedDefaultSha:defaultHead,lastProgressAt:now(),lastErrorCode:null};
  const prior=snapshot.history.find(record=>record.path==='state.json'&&record.status==='DECODED');
  const raw=await native(`git/blobs/${prior.blobSha}`),content=JSON.stringify(next,null,2)+'\n';
  changes.push({path:'state.json',content,sha256:sha256(content),previousSha256:sha256(Buffer.from(raw.content,'base64'))});
  await assertReleaseWriterProtection(request.repository,'steward/release-state',io,{token});
  if((await native(`commits/${encodeURIComponent(request.defaultBranch)}`)).sha!==defaultHead||(await native('git/ref/heads/steward/release-state')).object?.sha!==snapshot.head)
    return {...history,result:'UNKNOWN',reason:'HISTORY_SOURCE_MOVED'};
  await mkdir(request.writeDirectory,{recursive:true});
  const written=await writeReleaseRecords({directory:join(request.writeDirectory,'history-'+sha256(JSON.stringify(changes))),remote:request.remote,repositoryId:request.repositoryId,
    defaultBranch:request.defaultBranch,targetRef:'steward/release-state',writer:'release',expectedHead:snapshot.head,allowedPaths:changes.map(file=>file.path),changes,identity:request.identity},{token,beforePush:beforeArchivePush});
  if(!['APPLIED','UNCHANGED'].includes(written.status)||(await native('git/ref/heads/steward/release-state')).object?.sha!==written.head
    ||(await native(`commits/${encodeURIComponent(request.defaultBranch)}`)).sha!==defaultHead)return {...history,result:'UNKNOWN',reason:'HISTORY_ADOPTION_UNCONFIRMED'};
  return {...history,archiveHead:written.head};
  }).catch(()=>({result:'UNKNOWN',inventoryComplete:false,reason:'RELEASE_ADOPTION_OR_HISTORY_UNPROVEN'}));
}

/** Fixed release entry points share the protected Git snapshot and canonical Run binding. */
export async function releaseCommand(command,request,{token,io=nativeEvidenceTransport(token),now=()=>new Date().toISOString(),centralIo,centralInvocation,publisher,completionReader,controllerDirectory,allowProbeDispatch=true,official,recoverDispatchOnly=false}={}) {
  if(!['dispatch-build','publish','reconcile-publication','dispatch-channel','observe-channel','rerun'].includes(command))fail('release command');
  exact(request,['directory','writeDirectory','remote','repository','repositoryId','defaultBranch','appBotId','cycleId','runId','identity']);
  if(!isAbsolute(request.directory)||!isAbsolute(request.writeDirectory)||!Number.isSafeInteger(request.appBotId)||request.appBotId<1
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository)||request.repository.split('/').some(part=>part==='.'||part==='..')
    || request.remote!==`https://github.com/${request.repository}.git` && !isAbsolute(request.remote))fail('release input');
  if(command==='rerun')return inspectReleaseEvidence(request,{token,io,centralIo,now});
  if(command==='observe-channel') {
    if(!controllerDirectory||!centralIo)return {status:'WAIT',reason:'CHANNEL_OBSERVATION_CONTEXT_REQUIRED'};
    return observeReleaseChannels(request,{token,io,centralIo,controllerDirectory,now,allowProbeDispatch});
  }
  if(request.runId!==null)fail('release command cannot select Run');
  let snapshot=await readReleaseRecords({directory:request.directory,targetRef:'steward/release-state',repositoryId:request.repositoryId,includeHistory:false}),directory=request.directory;
  const recovered=await recoverReleaseCaches(request,snapshot,{token,io,centralIo,now});snapshot=recovered.snapshot;directory=recovered.directory;request={...request,directory};assertRepositoryWrite(snapshot.repository);
  if(snapshot.repository?.defaultBranch!==request.defaultBranch)fail('release repository');
  const wait=reason=>({status:'WAIT',reason,nextCheckAt:null,publishInvoked:false});
  let cycle=snapshot.cycles.find(record=>record.value.id===request.cycleId)?.value;
  if(!cycle)fail('registered cycle required');
  if((cycle.freezeOnly||cycle.freezeCompletedAt) && !cycle.requiredChannels.length && !githubUnits(cycle).length)
    return confirmFrozenCycle(request,snapshot,cycle,{token,io,now});
  if(command==='dispatch-channel'&&cycle.workflowDelivery&&cycle.requiredChannels.length&&!githubUnits(cycle).length)
    return wait('FORMAL_RELEASE_REQUIRED');
  if(command==='reconcile-publication') {
    const context={repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle};
    const ready=cycle.officialRelease&&await observeReadyDraft(request,snapshot,context,{token,io,verifyPublic:false});
    if(ready?.status==='DRAFT_READY')return ready;
    const history=snapshot.domainRecords.filter(r=>r.path.startsWith('evidence/publication/') && r.value.cycleId===cycle.id);
    const facts=await inspectPublications(context,history,io,centralIo,now());
    if (!facts.native.complete || facts.missing.length || !facts.files.length
      || !facts.files.every(file=>JSON.parse(file.content).objects.every(object=>object.status==='MATCH')))
      return {status:'UNKNOWN',reason:'PUBLICATION_WRITE_UNRECONCILED'};
    await verifyFormalPublication(context,io,token);
    await adoptReleaseCycle(request,snapshot,cycle,{token,io},facts.files);
    return {status:'OBSERVED',reason:'FORMAL_RELEASES_VERIFIED'};
  }
  if(command==='publish') {
    if(cycle.officialRelease) {
      const ready=await observeReadyDraft(request,snapshot,{repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle},
        {token,io,verifyPublic:!official?.stage});
      if(ready) return ready;
    }
    if(!centralIo||!centralInvocation)return wait('CENTRAL_PUBLICATION_CONTEXT_REQUIRED');
    // Serialize central writes across registered versions. Channel Runs do not own this gate.
    for(const {value:other} of snapshot.cycles) {
      if(other.id===cycle.id)continue;
      if(other.officialRelease&&draftReadyResult(snapshot,other))continue;
      const records=snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/publication/')&&record.value.cycleId===other.id);
      if(!other.publications.length&&!records.length)continue;
      const facts=await inspectPublications({repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle:other},records,io,centralIo,now());
      if(!facts.native.complete||facts.missing.length)return {status:'UNKNOWN',reason:'PUBLICATION_WRITE_UNRECONCILED',publishInvoked:false};
      if(facts.native.attempts.some(item=>item.status!=='completed'&&item.invocations.some(inv=>inv.evidence.outcome!=='EFFECT_CONFIRMED')))
        return wait('PUBLICATION_IN_FLIGHT');
      const outcomes=[...facts.native.attempts,...(facts.archived??[]).map(item=>item.attempt)].flatMap(item=>item.invocations.map(inv=>inv.evidence.outcome));
      if(outcomes.some(value=>value===null||value==='UNKNOWN'||value==='FACT_CONFLICT'))
        return {status:'UNKNOWN',reason:'PUBLICATION_WRITE_UNRECONCILED',publishInvoked:false};

    }

    if(publisher)return inspectReleaseEvidence(request,{token,io,centralIo,centralInvocation,publisher,now});
    return publishNativeCycle(request,{token,io,centralIo,centralInvocation,controllerDirectory,now,official});
  }
  if(command==='dispatch-channel' && !cycle.workflowDelivery&&githubUnits(cycle).some(unit=>unit.releaseId===null||unit.manifestDigest===null))return wait('FROZEN_RELEASE_REQUIRED');
  let channelDelivery;
  if(command==='dispatch-channel'&&centralIo) {
    const normalized=await ensureCycleDelivery(request,snapshot,cycle,{token,io,centralIo,now});snapshot=normalized.snapshot;directory=normalized.directory;request={...request,directory};
    channelDelivery=normalized.delivery;
  }
  const native=async path=>{
    const response=await io.request('GET',`/repos/${request.repository}${path?'/'+path:''}`);
    if(response.status!==200)fail(`native read ${response.status}`);
    return JSON.parse(Buffer.from(response.bytes).toString('utf8'));
  };
  const verifyHead=async head=>{if((await native('git/ref/heads/steward/release-state')).object?.sha!==head)fail('state snapshot must match native ref');};
  await verifyHead(snapshot.head);
  const actual=await native('');
  if(actual.id!==request.repositoryId||actual.full_name!==request.repository||actual.default_branch!==request.defaultBranch||actual.archived||actual.disabled)fail('native repository identity');
  await assertReleaseWriterProtection(request.repository,'steward/release-state',io,{token});
  let dispatch=cycle.dispatches.filter(item=>command==='dispatch-build'?item.purpose==='build':item.purpose!=='build').at(-1);
  let rejectedDeliveries=[];
  if(command==='dispatch-channel') {
    const context={repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle};
    if(!cycle.requiredChannels.length)return wait('NO_REQUIRED_CHANNELS');
    let missing=[];
    if(cycle.workflowDelivery) {
      if(channelDelivery?.schemaVersion!==3)fail('workflow channel configuration unavailable');
      const root=await mkdtemp(join(tmpdir(),'steward-channel-deliveries-'));
      try {
        const prepared=await prepareWorkflowChannelReceipts(context,root,controllerDirectory,token,snapshot.domainRecords,io);
        const {receipts}=prepared;
        missing=prepared.missing;
        rejectedDeliveries=prepared.rejected;
        for(const {unitId,frozen} of receipts) {
          const unit=cycle.units.find(unit=>unit.id===unitId);
          (unit.channelDeliveries??=[]).push(frozen);
        }
        if(receipts.length) {
          const adopted=await adoptReleaseCycle({...request,directory},snapshot,cycle,{token,io});
          snapshot=adopted.snapshot;directory=adopted.directory;request={...request,directory};
        }
      } finally {await rm(root,{recursive:true,force:true});}
    } else await verifyContinuationReleases(context,io);
    const sourceFiles=await readChannelSourceRejections(context,snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/source-rejection/')),io,now(),
      snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/dispatch/')));
    if(sourceFiles.length) {const adopted=await adoptReleaseCycle({...request,directory},snapshot,cycle,{token,io},sourceFiles);snapshot=adopted.snapshot;directory=adopted.directory;}
    const reads=retainedChannelReads(context,snapshot,now()).reads,runs=[];
    for(const prior of cycle.dispatches.filter(value=>value.purpose!=='build'&&value.canonicalRunId!==null)) {
      try {runs.push(nativeRunFact(await native(`actions/runs/${prior.canonicalRunId}`)));}
      catch {const raw=snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/native/')&&record.value.run.id===prior.canonicalRunId).sort((a,b)=>b.value.run.runAttempt-a.value.run.runAttempt)[0];if(!raw)return wait('CHANNEL_NATIVE_RUN_UNKNOWN');runs.push(raw.value.run);}
    }
    const selected=selectChannelDispatch(context,reads,runs,snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/source-rejection/')));
    if(selected.kind==='wait'||selected.kind==='unknown') {
      if(rejectedDeliveries.length)return {status:'BLOCKED',reason:'WORKFLOW_CHANNEL_DELIVERY_INVALID',publishInvoked:false,rejected:rejectedDeliveries,missing};
      return missing.length?{...wait('WORKFLOW_CHANNEL_DELIVERY_REQUIRED'),missing}:wait(selected.kind==='wait'?'CHANNEL_INDEX_PENDING':'CHANNEL_PROBE_REQUIRED');
    }
    if(selected.kind==='existing')dispatch=selected.request;
    else if(selected.kind==='reselect') {
      const original=selected.request,executionSha=(await native(`commits/${encodeURIComponent(request.defaultBranch)}`)).sha;
      dispatch=prepareChannelDispatch(context,original.workflowId,request.defaultBranch,executionSha,original.inputs.mode,JSON.parse(original.inputs.targets_json),now());
      if(original.continuationOfRunId!==null)return {status:'BLOCKED',reason:'NATIVE_MAINTENANCE_REQUIRED',publishInvoked:false};
      cycle.dispatches.push(dispatch);
    }
    else {
      const workflow=await native('actions/workflows/steward-release-channels.yml'),executionSha=(await native(`commits/${encodeURIComponent(request.defaultBranch)}`)).sha;
      if(workflow.path!=='.github/workflows/steward-release-channels.yml'||workflow.state!=='active')fail('channel workflow identity');
      dispatch=prepareChannelDispatch(context,workflow.id,request.defaultBranch,executionSha,selected.mode,selected.targets,now());cycle.dispatches.push(dispatch);
    }
  }
  if(!dispatch) {
    if(recoverDispatchOnly)return wait('CANONICAL_RUN_UNCONFIRMED');
    if(command!=='dispatch-build')return wait('CHANNEL_PROBE_REQUIRED');
    if(cycle.units.some(unit=>unit.releaseId!==null||unit.manifestDigest!==null))return wait('FROZEN_BUILD_CANNOT_BE_RECREATED');
    const buildWorkflow=cycle.buildWorkflow??defaultBuildWorkflow;
    const workflow=await native('actions/workflows/'+encodeURIComponent(buildWorkflow.split('/').at(-1)));
    if(workflow.path!==buildWorkflow||workflow.state!=='active')fail('build workflow identity');
    dispatch=prepareBuildDispatch({repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle},workflow.id,now());
    cycle.dispatches.push(dispatch);
  }
  const deliveryDetails=rejectedDeliveries.length?{rejected:rejectedDeliveries}:{};
  if(dispatch.canonicalRunId!==null)return {status:'BOUND',canonicalRunId:dispatch.canonicalRunId,reason:'CANONICAL_RUN_IMMUTABLE',publishInvoked:false,...deliveryDetails};
  if(dispatch.purpose==='build')await assertReleaseWriterProtection(request.repository,dispatch.ref,io,{token});
  // The workflow must already exist at the current default branch and at the frozen execution source.
  const workflowPath=dispatchWorkflow(dispatch);
  for(const ref of [request.defaultBranch,dispatch.executionSha]) {
    const file=await native(`contents/${encodeRepositoryPath(workflowPath)}?ref=${encodeURIComponent(ref)}`);
    if(file.path!==workflowPath||file.type!=='file'||file.encoding!=='base64'||typeof file.content!=='string')fail('dispatch workflow source');
    const bytes=Buffer.from(file.content,'base64');
    if(bytes.length!==file.size||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==file.sha)fail('dispatch workflow bytes');
    verifyDispatchWorkflow(bytes,dispatch);
  }
  const original=await io.request('GET',`/repos/${request.repository}/git/ref/heads/${dispatch.ref}`);
  if(original.status===404 && dispatch.purpose==='build') {
    if(recoverDispatchOnly)return wait('CANONICAL_RUN_UNCONFIRMED');
    const refs=await native(`git/matching-refs/heads/${dispatch.ref}`);
    if(!Array.isArray(refs)||refs.some(ref=>ref.ref===`refs/heads/${dispatch.ref}`))fail('build ref inventory');
    try {await io.request('POST',`/repos/${request.repository}/git/refs`,512*1024,{ref:`refs/heads/${dispatch.ref}`,sha:dispatch.executionSha});}catch { /* Read back this exact ref before deciding. */ }
  } else if(original.status!==200)fail('build ref unavailable');
  const publicationRecords=snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/publication/')&&record.value.cycleId===cycle.id);
  if(publicationRecords.length&&!centralIo)return wait('CENTRAL_PUBLICATION_READ_REQUIRED');
  const publication=centralIo?await inspectPublications({repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle},publicationRecords,io,centralIo,now()):undefined;
  const store={save:async(nextCycle,files)=>{
    files=[...(publication?.files??[]),...files];
    const records=[{path:`cycles/${cycle.id}.json`,content:JSON.stringify(nextCycle,null,2)+'\n'},...files];
    const last=files.at(-1),observation=last?JSON.parse(last.content):null;
    const state={...snapshot.repository,revision:snapshot.repository.revision+1,nextCheckAt:observation?.nextCheckAt??null,
      lastProgressAt:nextCycle.dispatches.some(item=>item.canonicalRunId!==null&&!snapshot.cycles.find(value=>value.value.id===cycle.id)?.value.dispatches.some(prior=>prior.canonicalRunId===item.canonicalRunId))?now():snapshot.repository.lastProgressAt,
      lastErrorCode:observation?.errorCode?.toLowerCase().replaceAll('_','-')??null};
    records.push({path:'state.json',content:JSON.stringify(state,null,2)+'\n'});
    const profile=await mkdtemp(join(tmpdir(),'steward-dispatch-read-'));
    let changes;
    try {
      const env=isolatedBuildEnvironment(process.env,profile);
      const git=async(...args)=>(await promisify(execFile)('git',['--no-replace-objects','-c','core.hooksPath=','-c','core.fsmonitor=false',...args],{cwd:directory,env,encoding:'buffer',windowsHide:true,maxBuffer:32*1024*1024})).stdout;
      const entries=(await git('ls-tree','-r','-z',snapshot.head)).toString().split('\0').filter(Boolean).map(line=>{const [meta,path]=line.split('\t');return {path,oid:meta.split(' ')[2]};});
      changes=await Promise.all(records.map(async file=>{const entry=entries.find(value=>value.path===file.path);return {...file,sha256:sha256(file.content),previousSha256:entry?sha256(await git('cat-file','blob',entry.oid)):null};}));
    }finally{await rm(profile,{recursive:true,force:true});}
    await mkdir(request.writeDirectory,{recursive:true});
    const nextDirectory=join(request.writeDirectory,sha256(JSON.stringify(changes.map(file=>[file.path,file.sha256,snapshot.head]))));
    const written=await writeReleaseRecords({directory:nextDirectory,remote:request.remote,repositoryId:request.repositoryId,defaultBranch:request.defaultBranch,
      targetRef:'steward/release-state',writer:'release',expectedHead:snapshot.head,allowedPaths:changes.map(file=>file.path),changes,identity:request.identity},{token});
    if(!['APPLIED','UNCHANGED'].includes(written.status))return written;
    const readback=await readReleaseRecords({directory:nextDirectory,targetRef:'steward/release-state',repositoryId:request.repositoryId,includeHistory:false});
    if(readback.head!==written.head||JSON.stringify(readback.cycles.find(value=>value.value.id===cycle.id)?.value)!==JSON.stringify(nextCycle))return {status:'CONFLICT',head:readback.head};
    // Distinct callers must not both send when disjoint receipt files can be rebased.
    // A nonce distinguishes transport ownership, never a future Run or business attempt.
    if(observation?.kind==='PREPARED' && readback.domainRecords.some(record=>record.path.startsWith('evidence/dispatch/')
      &&record.value.kind==='PREPARED'&&record.value.requestKey===observation.requestKey
      &&!snapshot.domainRecords.some(prior=>prior.path===record.path)&&!files.some(file=>file.path===record.path)))return {status:'CONFLICT',head:readback.head};
    try {await verifyHead(readback.head);}catch{return {status:'UNKNOWN',head:readback.head};}
    snapshot=readback;directory=nextDirectory;cycle=nextCycle;return written;
  }};
  const dispatched=await dispatchNativeRun({repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle},dispatch.requestKey,store,
    {complete:true,observations:snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/dispatch/')).map(record=>record.value),
      channelEvidence:snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/channel/')||record.path.startsWith('evidence/channel-read/')),sourceRejections:snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/source-rejection/')),retryLimits:snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/retry-limit/')),
      archives:snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/native/')),publication},io,now(),{recoverOnly:recoverDispatchOnly});
  return {...dispatched,...deliveryDetails};
}

export async function main(argv=process.argv.slice(2)) {
  if(['dispatch-build','dispatch-channel','observe-channel','rerun'].includes(argv[0])) {
    if(argv.length!==5||argv[1]!=='--input'||argv[3]!=='--output')fail('release arguments');
    const input=decodeBuildJson(await readFile(argv[2])),output=await open(argv[4],'wx',0o600);
    try {const result=await releaseCommand(argv[0],input,{token:process.env.STEWARD_STATE_TOKEN});await output.writeFile(JSON.stringify(result,null,2)+'\n');return result;}
    finally {await output.close();}
  }
  if(argv[0]==='inspect'||argv[0]==='recover') {
    if(argv.length!==5||argv[1]!=='--input'||argv[3]!=='--output')fail('evidence arguments');
    const input=decodeBuildJson(await readFile(argv[2]));
    if((argv[0]==='inspect')!==(input.runId===null))fail('evidence operation');
    const output=await open(argv[4],'wx',0o600);
    try {
      const result=await inspectReleaseEvidence(input,{token:process.env.STEWARD_STATE_TOKEN});
      await output.writeFile(JSON.stringify(result,null,2)+'\n');return result;
    } finally {await output.close();}
  }
  if(argv[0]==='write') {
    if(argv.length!==5 || argv[1]!=='--input' || argv[3]!=='--output' || !argv[2] || !argv[4])fail('write arguments');
    const bytes=await readFile(argv[2]);if(bytes.length>512*1024)fail('write input bound');
    // Request transport is data only; domain files are decoded again above.
    // The existing JSON decoder's text policy permits embedded LF in file
    // content. Each path, identity and domain payload is validated separately.
    const request=validateWrite(decodeBuildJson(bytes,'oci'));
    const output=await open(argv[4],'wx',0o600);
    try {
      const result=await writeReleaseRecords(request,{token:process.env.STEWARD_STATE_TOKEN});
      await output.writeFile(JSON.stringify(result,null,2)+'\n');return result;
    } finally { await output.close(); }
  }
  if(!['read','check'].includes(argv[0])||argv.length!==9)throw new Error('RELEASE_RECORD: read/check arguments');
  const args={};for(let i=1;i<argv.length;i+=2){const key=argv[i];if(!['--directory','--target-ref','--repository-id','--output'].includes(key)||Object.hasOwn(args,key)||!argv[i+1])throw new Error('RELEASE_RECORD: arguments');args[key]=argv[i+1];}
  if(!/^[1-9][0-9]*$/.test(args['--repository-id']))throw new Error('RELEASE_RECORD: repository ID');
  const result=await readReleaseRecords({directory:args['--directory'],targetRef:args['--target-ref'],repositoryId:Number(args['--repository-id']),includeHistory:args['--target-ref']!=='steward/release-state'});
  await writeFile(args['--output'],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().then(result=>{
  if(result?.status==='UNKNOWN' || result?.status==='CONFLICT' || result?.status==='BLOCKED')process.exitCode=75;
}).catch(error=>{process.stderr.write(`${error instanceof Error && /^RELEASE_RECORD:/.test(error.message)?error.message:'RELEASE_RECORD: request or output unavailable'}\n`);process.exitCode=1;});

function retainedChannelReads(context,snapshot,now) {
  return retainedChannelObservations(context,snapshot.domainRecords,now);
}

/** Re-read formal bytes and native source before using retained consumption proofs to close a cycle. */
export async function readNativeCompletion(request,cycle,{io,centralIo,token,now=()=>new Date().toISOString()}) {
  const snapshot=await readReleaseRecords({directory:request.directory,targetRef:'steward/release-state',repositoryId:request.repositoryId,includeHistory:false});
  const context={repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle},observedAt=now();
  await verifyFormalPublication(context,io,token);
  const probe=retainedChannelReads(context,snapshot,observedAt);
  const publications=snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/publication/')&&record.value.cycleId===cycle.id);
  const publication=await inspectPublications(context,publications,io,centralIo,observedAt);
  const source={repositoryId:request.repositoryId,cycleId:cycle.id,sourceSha:cycle.sourceSha,deliveryConfigSha:cycle.deliveryConfigSha,
    units:githubUnits(cycle).map(unit=>({id:unit.id,version:unit.version,tag:unit.tag,releaseId:unit.releaseId,authorId:request.appBotId,manifestDigest:unit.manifestDigest,notesDigest:unit.notesDigest,
      assets:unit.assets.map(({path,size,sha256})=>({path,size,sha256}))})),requiredChannels:cycle.requiredChannels.map(channel=>{
      const unit=cycle.units.find(unit=>unit.id===channel.unitId),target={...channel,version:unit.version,releaseId:unit.releaseId,manifestDigest:unit.manifestDigest};
      return {...channel,version:unit.version,digest:unit.manifestDigest,inputDigest:channelTargetsDigest(context,[target]),private:false};
    })};
  const observation={source,sourceComplete:true,observedAt,releasesComplete:true,channelsComplete:true,releases:[],channels:[],consumptions:[],
    inFlightWaveKeys:publication.native.attempts.filter(item=>item.status!=='completed'&&item.invocations.some(inv=>inv.evidence.outcome!=='EFFECT_CONFIRMED')).map(item=>`run:${item.runId}:${item.runAttempt}`),unknownWriteKeys:publication.missing};
  if(!publication.native.complete||publication.missing.length)observation.releasesComplete=false;
  const provenance=new Map(),add=file=>{provenance.set(file.path,{path:file.path,digest:sha256(file.content),sourceUrl:`https://api.github.com/repos/${request.repository}/git/commits/${file.commit}`,observedAt:file.value.observedAt});return sha256(file.content);};
  for(const unit of source.units) {
    const raw=publications.filter(file=>file.value.objects.some(object=>object.unitId===unit.id&&object.releaseId===unit.releaseId&&object.status==='MATCH')).sort((a,b)=>b.value.observedAt.localeCompare(a.value.observedAt))[0];
    if(!raw)fail('native publication proof required');
    if(!publication.files.some(file=>JSON.parse(file.content).objects.some(object=>object.unitId===unit.id&&object.releaseId===unit.releaseId&&object.status==='MATCH')))observation.releasesComplete=false;
    const {id,...fields}=unit;observation.releases.push({...fields,unitId:id,sourceSha:cycle.sourceSha,draft:false,immutable:true,evidenceDigest:add(raw)});
  }
  for(const channel of source.requiredChannels) {
    const read=probe.reads.find(read=>read.unitId===channel.unitId&&read.channelId===channel.channelId);
    const readFile=probe.files.get(JSON.stringify([channel.unitId,channel.channelId]))?.file;
    if(!read||!readFile)continue;
    const files=snapshot.domainRecords.filter(file=>file.path.startsWith('evidence/channel/')&&file.value.kind==='RESULT'&&file.value.cycleId===cycle.id);
    const verified=[];
    for(const file of files) {
      const request=cycle.dispatches.find(request=>request.canonicalRunId===file.value.run.id);if(!request)fail('native result request');
      const item=verifyChannelResult(context,request,file.value.run,file.value.job,JSON.parse(file.value.payload));
      if(item.unitId===channel.unitId&&item.channelId===channel.channelId&&item.consumed)verified.push({file,item});
    }
    const last=verified.sort((a,b)=>b.item.observedAt.localeCompare(a.item.observedAt))[0];
    const conflicting=read.readStatus==='CONFLICT'||!!last&&(channel.channelId==='ghcr-assets'?read.digest!==last.item.nativeObjectId:
      read.evidenceKind!==`github-pr:${last.item.nativeObjectId}`);
    observation.channels.push({...channel,nativeObjectId:last?.item.nativeObjectId??'pending',accepted:read.accepted===true,indexed:read.indexed===true,
      rejected:conflicting,visible:read.exists===true,observedAt:read.observedAt,evidenceDigest:add(readFile)});
    delete observation.channels.at(-1).private;
    if(['AUTH_UNKNOWN','TRANSIENT'].includes(read.readStatus))observation.channelsComplete=false;
    for(const {file,item} of verified) {
      observation.consumptions.push({unitId:channel.unitId,channelId:channel.channelId,version:channel.version,digest:channel.digest,inputDigest:channel.inputDigest,
        repositoryId:request.repositoryId,sourceSha:cycle.sourceSha,runId:file.value.run.id,jobId:file.value.job.id,conclusion:'success',consumedDigest:item.digest,
        logDigest:sha256(file.value.payload),evidenceDigest:add(file)});
    }
  }
  const value={schemaVersion:1,repositoryId:request.repositoryId,cycleId:cycle.id,source,observation,provenance:[...provenance.values()]};
  decodeCompletionArchive(Buffer.from(JSON.stringify(value)));return value;
}

export function channelResultUrl(repository,delivery,item) {
  const channel=delivery.units.find(unit=>unit.id===item.unitId)?.channels.find(channel=>channel.id===item.channelId && channel.required);
  if(!channel)fail('unregistered channel result');
  if(channel.id==='winget' && /^[1-9][0-9]*$/.test(String(item.nativeObjectId)))
    return 'https://github.com/microsoft/winget-pkgs/pull/'+item.nativeObjectId;
  const ghcr=/^ghcr\.io\/([a-z0-9._-]+)\/([a-z0-9._/-]+)$/.exec(channel.location);
  if(channel.id!=='ghcr-assets' || !ghcr || ghcr[1]!==repository.split('/')[0].toLowerCase() ||
    ghcr[2].split('/').some(part=>!part || part==='.' || part==='..'))fail('channel result location');
  return 'https://github.com/'+repository+'/pkgs/container/'+encodeURIComponent(ghcr[2]);
}

export async function observeReleaseChannels(request,{token,io,centralIo,controllerDirectory,oras,allowProbeDispatch=true,now=()=>new Date().toISOString()}) {
  const root=await mkdtemp(join(tmpdir(),'steward-channel-read-'));
  try {
    let snapshot=await readReleaseRecords({directory:request.directory,targetRef:'steward/release-state',repositoryId:request.repositoryId,includeHistory:false});
  const recovered=await recoverReleaseCaches(request,snapshot,{token,io,centralIo,now});snapshot=recovered.snapshot;request={...request,directory:recovered.directory};assertRepositoryWrite(snapshot.repository);
    const cycle=structuredClone(snapshot.cycles.find(record=>record.value.id===request.cycleId)?.value);
    if((cycle?.freezeOnly||cycle?.freezeCompletedAt) && !cycle.requiredChannels.length && !githubUnits(cycle).length)
      return confirmFrozenCycle(request,snapshot,cycle,{token,io,now});
    if(cycle?.workflowDelivery&&!githubUnits(cycle).length)
      return {status:'WAIT',reason:cycle.requiredChannels.length?'FORMAL_RELEASE_REQUIRED':'BUILD_RUN_NOT_READY'};
    if(!cycle||!cycle.workflowDelivery&&githubUnits(cycle).some(unit=>unit.releaseId===null))return {status:'WAIT',reason:'FORMAL_RELEASE_REQUIRED'};
    const context={repository:request.repository,repositoryId:request.repositoryId,appBotId:request.appBotId,cycle};
    const normalized=await ensureCycleDelivery(request,snapshot,cycle,{token,io,centralIo,now});snapshot=normalized.snapshot;request={...request,directory:normalized.directory};
    const readyUnits=cycle.workflowDelivery?new Set(cycle.units.filter(unit=>unit.channelDeliveries?.length).map(unit=>unit.id)):undefined;
    if(!readyUnits||readyUnits.size)await verifyContinuationReleases(context,io,readyUnits);
    if(normalized.delivery.schemaVersion===3&&cycle.requiredChannels.length&&!cycle.units.some(unit=>unit.channelDeliveries?.length))
      return {status:'WAIT',reason:'WORKFLOW_CHANNEL_DELIVERY_REQUIRED'};
    const observed=cycle.requiredChannels.length?await observeNativeChannels(context,snapshot.domainRecords.filter(record=>record.path.startsWith('evidence/channel/')||record.path.startsWith('evidence/channel-read/')||record.path.startsWith('evidence/normalized-delivery/')),
      root,controllerDirectory,token,io,now(),oras,allowProbeDispatch).catch(()=>({files:[],results:[],reads:[],probe:'UNKNOWN'})):{files:[],results:[],reads:[],probe:'OBSERVED'};
    for(const {item,evidence,path} of observed.results) {
      let fact=cycle.channelFacts.find(fact=>fact.unitId===item.unitId&&fact.channelId===item.channelId);
      if(!fact) {fact={unitId:item.unitId,channelId:item.channelId,nativeObjectId:null,nativeUrl:null,inputDigest:channelTargetsDigest(context,[{unitId:item.unitId,channelId:item.channelId,version:item.version,releaseId:item.releaseId,manifestDigest:item.manifestDigest}]),
        submittedAt:null,acceptedAt:null,indexedAt:null,verificationRunId:null,verifiedEvidencePath:null,observedAt:item.observedAt,nextCheckAt:null};cycle.channelFacts.push(fact);}
      if(fact.nativeObjectId!==null&&fact.nativeObjectId!==item.nativeObjectId)fail('channel native object changed');
      Object.assign(fact,{nativeObjectId:item.nativeObjectId,nativeUrl:channelResultUrl(request.repository,normalized.delivery,item),
        submittedAt:fact.submittedAt??item.observedAt,acceptedAt:item.accepted?(fact.acceptedAt??item.observedAt):fact.acceptedAt,indexedAt:item.indexed?(fact.indexedAt??item.observedAt):fact.indexedAt,
        verificationRunId:item.consumed?evidence.run.id:fact.verificationRunId,verifiedEvidencePath:item.consumed?path:fact.verifiedEvidencePath,observedAt:item.observedAt});
    }
    const saved=await adoptReleaseCycle(request,snapshot,cycle,{token,io},observed.files);snapshot=saved.snapshot;request={...request,directory:saved.directory};
    let value;
    try {value=await readNativeCompletion(request,cycle,{io,centralIo,token,now});}catch{return {status:'UNKNOWN',reason:'COMPLETION_EVIDENCE_REQUIRED'};}
    const verdict=evaluateCompletion(value.source,value.observation,now());
    if(verdict.result!=='PASS')return {status:verdict.result,reason:'MAIN_RELEASE_OBLIGATIONS',completion:verdict};
    const file=completionFile(value);cycle.completedEvidencePath=file.path;
    if(!cycle.completionObservations.some(item=>item.evidencePath===file.path))cycle.completionObservations.push({inputSetDigest:sha256(JSON.stringify(value.source)),evidenceSetDigest:sha256(JSON.stringify(value.observation)),observedAt:value.observation.observedAt,evidencePath:file.path});
    const complete=await adoptReleaseCycle(request,snapshot,cycle,{token,io},[file]);
    return {status:'OBSERVED',reason:verdict.distributionResult==='PASS'?'DISTRIBUTION_VERIFIED':'MAIN_RELEASE_VERIFIED',archiveHead:complete.snapshot.head,completion:verdict};
  }finally{await rm(root,{recursive:true,force:true});}
}
