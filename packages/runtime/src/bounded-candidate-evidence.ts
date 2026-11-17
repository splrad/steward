import {isDeepStrictEqual} from 'node:util';
import {manualIdentity,verifyManualHead} from './bounded-manual-evidence.js';
import {APP_BOT_ID} from './bounded-winget-evidence.js';
import {createHash} from 'node:crypto';
import {TARGET,CENTRAL,digest,ensure,type GitReader,type BoundedEnv,type RunLocator} from './bounded-recheck-github.js';
import {identityKey,validateRegistration,type Identity,type Registration} from './bounded-recheck.js';
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
export async function candidateFacts<T extends boolean=false>(g:GitReader,requireCurrentMain=true,allowPending:T=false as T){
 const read=(p:string)=>g.json(TARGET.id,`/repos/${TARGET.name}/${p}`);
 const ref=await read('git/ref/heads/steward/release-state');ensure(ref.ref==='refs/heads/steward/release-state'&&ref.object?.type==='commit'&&sha(ref.object.sha),'STATE_REF');const commit=ref.object.sha;
 const file=async(path:string)=>{const f=await read(`contents/${path}?ref=${commit}`);ensure(f.path===path&&f.type==='file'&&f.encoding==='base64'&&sha(f.sha)&&f.size<=512*1024,'STATE_FILE');const b=Buffer.from(f.content,'base64');ensure(b.length===f.size&&createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')===f.sha,'STATE_BLOB');return JSON.parse(b.toString('utf8'));};
 const state=await file('state.json');const c=state.candidate;ensure(state.schemaVersion===3&&state.repositoryId===TARGET.id&&!state.activeCycleId&&c&&/^[a-f0-9]{64}$/.test(c.id)&&sha(c.baseSha)&&sha(c.publishedHead)&&c.generatedSnapshotPath&&Number.isSafeInteger(c.prNumber),'CANDIDATE_NOT_READY');
 const path=`generated/${c.id}/session.json`,first=await file(path),parts=[first];ensure(Number.isSafeInteger(first.count)&&first.count>0&&first.count<=128,'CHUNK_COUNT');
 for(let n=1;n<first.count;n++)parts.push(await file(`generated/${c.id}/session-${n}.json`));
 ensure(parts.every((x,n)=>x.schemaVersion===1&&x.repositoryId===TARGET.id&&x.candidateId===c.id&&x.documentKind==='session'&&x.index===n&&x.count===first.count&&x.documentDigest===first.documentDigest&&typeof x.content==='string'&&Buffer.byteLength(x.content)<=256*1024),'CHUNK_BINDING');
 const text=parts.map(x=>x.content).join('');ensure(digest(text)==='sha256:'+first.documentDigest,'SESSION_DIGEST');const session=JSON.parse(text),generated=session.generated;
 if(generated){const gp=c.generatedSnapshotPath;ensure(typeof gp==='string'&&new RegExp(`^generated/${c.id}/[a-f0-9]{64}\\.json$`).test(gp),'GENERATED_PATH');const firstGenerated=await file(gp),chunks=[firstGenerated];ensure(Number.isSafeInteger(firstGenerated.count)&&firstGenerated.count>0&&firstGenerated.count<=128,'GENERATED_COUNT');for(let n=1;n<firstGenerated.count;n++)chunks.push(await file(gp.replace('.json',`-${n}.json`)));ensure(chunks.every((x,n)=>x.schemaVersion===1&&x.repositoryId===TARGET.id&&x.candidateId===c.id&&x.documentKind==='generated'&&x.index===n&&x.count===firstGenerated.count&&x.documentDigest===firstGenerated.documentDigest&&typeof x.content==='string'&&Buffer.byteLength(x.content)<=256*1024),'GENERATED_BINDING');const raw=chunks.map(x=>x.content).join('');ensure(digest(raw)==='sha256:'+firstGenerated.documentDigest&&isDeepStrictEqual(JSON.parse(raw),generated),'GENERATED_MISMATCH');}

 const ready=!c.pendingWrite&&generated?.baseSha===c.baseSha&&generated.units?.length===1&&generated.units[0].id==='layerscape'&&!session.pending&&session.identity;
 const manual=session.manualValidation??null;const manualId=manual?manualIdentity(manual,state,session):null;
 if(!allowPending)ensure(manualId?(!c.pendingWrite&&!session.pending):ready,'SESSION_NOT_READY');
 if(requireCurrentMain)ensure((await read('git/ref/heads/main')).object?.sha===(manualId?.sourceSha??c.baseSha),'SOURCE_CHANGED');
 const identity=(manualId?(!c.pendingWrite&&!session.pending?manualId:null):ready?{repositoryId:TARGET.id,cycleId:c.id,channel:'candidate',version:generated.units[0].version,artifactDigest:digest(JSON.stringify(generated)),sourceSha:c.baseSha,stage:'candidate',epoch:createHash('sha256').update(JSON.stringify([TARGET.id,c.id,c.baseSha,c.generatedSnapshotPath,c.publishedHead])).digest('hex'),upstreamPR:null}:null) as (T extends true?Identity|null:Identity);
 let pull=await read(`pulls/${c.prNumber}`);ensure(pull.number===c.prNumber&&pull.head?.repo?.id===TARGET.id&&pull.base?.repo?.id===TARGET.id&&pull.head.ref===c.branch&&pull.base.ref==='main'&&sha(pull.head.sha),'CANDIDATE_PULL');
 if(manual&&!allowPending)pull=await verifyManualHead(g,manual,pull);
 ensure((await read('git/ref/heads/steward/release-state')).object?.sha===commit,'STATE_MOVED');
 return {identity,state,pull,session,manual,evidence:{stateCommit:commit,path,documentDigest:first.documentDigest,prNumber:c.prNumber,head:pull.head.sha}};
}
export async function verifiedProducer(g:GitReader,env:BoundedEnv,input:{registration?:Registration;producer:RunLocator}){
 const p=input.producer;
 ensure(p&&Object.keys(p).sort().join(',')==='attempt,repositoryId,requestKey,runId'&&p.repositoryId===CENTRAL.id&&Number.isSafeInteger(p.runId)&&p.runId>0&&Number.isSafeInteger(p.attempt)&&p.attempt>0&&/^[a-f0-9]{64}$/.test(p.requestKey),'PRODUCER_LOCATOR');
 const run=await g.json(CENTRAL.id,`/repos/${CENTRAL.name}/actions/runs/${p.runId}/attempts/${p.attempt}`);
 ensure(run.id===p.runId&&run.run_attempt===p.attempt&&run.repository?.id===CENTRAL.id&&run.head_repository?.id===CENTRAL.id&&run.path==='.github/workflows/bounded-release-event.yml'&&run.head_sha===env.BOUNDED_CONTROLLER_SHA&&run.head_branch==='main'&&run.event==='workflow_dispatch'&&run.actor?.id===APP_BOT_ID&&run.status==='completed'&&run.conclusion==='success'&&run.display_title===`Bounded release event ${p.requestKey}`,'PRODUCER_RUN');
 const artifact=await g.artifact(CENTRAL.id,p.runId,`bounded-recheck-registration-${p.requestKey}`,'registration.json');const v=artifact.value;
 ensure(v&&Object.keys(v).sort().join(',')==='producer,registration,requestKey,schemaVersion,sourceEvidence'&&v.schemaVersion===1&&v.requestKey===p.requestKey,'PRODUCER_PAYLOAD');
 const producer=v.producer;ensure(producer&&Object.keys(producer).sort().join(',')==='attempt,controllerSha,repositoryId,runId'&&producer.repositoryId===CENTRAL.id&&producer.runId===p.runId&&producer.attempt===p.attempt&&producer.controllerSha===run.head_sha,'PRODUCER_ATTEMPT');
 const created=Date.parse(artifact.createdAt??''),start=Date.parse(run.run_started_at),end=Date.parse(run.updated_at);ensure([created,start,end].every(Number.isFinite)&&created>=start&&created<=end,'PRODUCER_ARTIFACT_WINDOW');
 const r=v.registration as Registration;validateRegistration(r,Date.now());
 ensure(sha(env.BOUNDED_CONTROLLER_SHA)&&r.policySha===env.BOUNDED_CONTROLLER_SHA&&r.deploymentSha===env.BOUNDED_DEPLOYMENT_SHA,'DEPLOYED_PROTOCOL');
 if(input.registration){const expected=input.registration;validateRegistration(expected,Date.now());ensure(identityKey(expected.identity)===identityKey(r.identity)&&expected.t0===r.t0&&expected.policySha===r.policySha&&expected.deploymentSha===r.deploymentSha,'PRODUCER_PAYLOAD');}
 ensure(r.identity.stage==='candidate','PRODUCER_STAGE');const facts=await candidateFacts(g);ensure(identityKey(facts.identity)===identityKey(r.identity),'PRODUCER_GIT_IDENTITY');
 const s=v.sourceEvidence;ensure(s&&Object.keys(s).sort().join(',')==='documentDigest,eventCreatedAt,eventId,head,path,prNumber,stateCommit'&&Object.entries(facts.evidence).every(([k,x])=>s[k]===x),'PRODUCER_GIT_EVIDENCE');
 const event=await g.json(TARGET.id,`/repos/${TARGET.name}/issues/events/${s.eventId}`);
 ensure(event.id===s.eventId&&event.issue?.number===facts.pull.number&&event.issue?.repository_url===`https://api.github.com/repos/${TARGET.name}`&&['labeled','unlabeled','reopened'].includes(event.event)&&(['labeled','unlabeled'].includes(event.event)?event.label?.name==='release:editing':true)&&event.created_at===s.eventCreatedAt&&Date.parse(event.created_at)===r.t0,'PRODUCER_EVENT');
 ensure(Array.isArray(facts.pull.labels)&&facts.pull.state==='open'&&!facts.pull.merged,'PRODUCER_PULL_STATE');const editing=facts.pull.labels.some((l:any)=>l.name==='release:editing');
 ensure(!(event.event==='labeled'&&!editing)&&!(event.event==='unlabeled'&&editing),'PRODUCER_EVENT_SUPERSEDED');
 return {registration:r,editing,event,artifactId:artifact.artifactId,artifactDigest:artifact.digest};
}
