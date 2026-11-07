import { nextLink } from '../../github/src/pagination.js';
import { qualityCanonical, qualityDigest, qualitySegmentKey, qualityBatchInput, reconcileQualitySources, renderQualitySummary, validateQualityOutput,
  QUALITY_CHECK_NAME, qualityGenerationAttempts, type QualityCache, type QualitySource, type QualityEntry } from '../../core/src/quality-language-summary.js';
import type { QualityModelClient } from './copilot-quality-client.js';

export interface QualityIdentity { kind:'review-comment'|'review'|'annotation'; id:number; login:string }
export interface QualityContext { repository:string; repositoryId:number; pullRequestNumber:number; head:string; appId:number; configVersion:string }
export interface QualityIO {
  get(path:string):Promise<{value:any;headers:Headers}>;
  writeCheck(body:Record<string,unknown>,checkId:number|null):Promise<unknown>;
}
export interface QualityStore {
  save(cache:QualityCache, markdown?:{path:string;content:string}):Promise<{commit:string}>;
}
const ensure = (value:unknown,code:string):void => { if(!value)throw new Error(`QUALITY_${code}`); };
const same = (a:unknown,b:unknown) => qualityCanonical(a)===qualityCanonical(b);
const positive = (n:unknown):n is number => Number.isSafeInteger(n)&&Number(n)>0;
const safeCode = (error:unknown) => error instanceof Error && /^(?:QUALITY_[A-Z_]+|WAIT_AUTH|WAIT_QUOTA|RESPONSE_UNKNOWN)$/.test(error.message)?error.message:'RESPONSE_UNKNOWN';

/** Each page stays on the same native endpoint and query. Interrupted reads never become empty sets. */
export async function qualityPages(io:QualityIO,path:string,field?:string):Promise<any[]> {
  const first=new URL(path,'https://api.github.com');first.searchParams.set('per_page','100');
  const result:any[]=[],seen=new Set<string>();let next:string|null=first.pathname+first.search,total:number|null=null;
  while(next) {
    const url=new URL(next,'https://api.github.com');
    ensure(url.origin===first.origin&&url.pathname===first.pathname&&!url.username&&!url.password&&!url.hash,'PAGINATION');
    for(const [key,value] of first.searchParams)ensure(url.searchParams.get(key)===value,'PAGINATION');
    ensure([...url.searchParams.keys()].every(k=>first.searchParams.has(k)||k==='page')&&!seen.has(url.href)&&seen.size<10000,'PAGINATION');seen.add(url.href);
    const page=await io.get(url.pathname+url.search),items=field?page.value[field]:page.value;
    ensure(Array.isArray(items),'PAGINATION');
    if(field){ensure(Number.isSafeInteger(page.value.total_count)&&page.value.total_count>=0&&(total===null||total===page.value.total_count),'PAGINATION');total=page.value.total_count;}
    result.push(...items);next=nextLink(page.headers)??null;
  }
  ensure(total===null||result.length===total,'PAGINATION');return result;
}
function contextValid(c:QualityContext) {
  ensure(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(c.repository)&&positive(c.repositoryId)&&positive(c.pullRequestNumber)&&positive(c.appId)
    &&/^[a-f0-9]{40}$/.test(c.head)&&/^[A-Za-z0-9._-]{1,100}$/.test(c.configVersion),'CONTEXT');
}
export async function collectQualitySources(context:QualityContext,identities:QualityIdentity[],io:QualityIO):Promise<QualitySource[]> {
  contextValid(context);ensure(identities.length>0,'SOURCE_CONFIG_PENDING');
  ensure(identities.every(x=>positive(x.id)&&['review-comment','review','annotation'].includes(x.kind)&&typeof x.login==='string'&&!!x.login)
    &&new Set(identities.map(x=>`${x.kind}:${x.id}`)).size===identities.length,'SOURCE_CONFIG');
  const root=`/repos/${context.repository}`,prPath=`${root}/pulls/${context.pullRequestNumber}`;
  const assertPr=async()=>{const {value:pr}=await io.get(prPath);ensure(pr.number===context.pullRequestNumber&&pr.base?.repo?.id===context.repositoryId
    &&pr.head?.sha===context.head&&pr.state==='open','PR_CHANGED');};
  const trusted=(kind:QualityIdentity['kind'],id:unknown,login:unknown)=>{
    if(identities.some(x=>x.kind===kind&&x.id===id))return true;
    ensure(!identities.some(x=>x.kind===kind&&x.login===login),'SOURCE_ID_CHANGED');return false;
  };
  const sourceUrl=(raw:unknown)=>{ensure(typeof raw==='string','SOURCE_URL');const url=new URL(raw as string);
    ensure(url.origin==='https://github.com'&&url.pathname.startsWith('/'+context.repository+'/')&&!url.username&&!url.password&&!url.port,'SOURCE_URL');return raw as string;};
  async function read() {
    await assertPr();const sources:QualitySource[]=[];
    for(const [kind,endpoint] of [['review-comment','comments'],['review','reviews']] as const) {
      const records=await qualityPages(io,`${prPath}/${endpoint}`);
      ensure(records.every(x=>positive(x.id))&&new Set(records.map(x=>x.id)).size===records.length,'SOURCE_DUPLICATE');
      for(const raw of records) {
        if(!trusted(kind,raw.user?.id,raw.user?.login))continue;
        if(kind==='review-comment')ensure(raw.pull_request_url===`https://api.github.com${prPath}`,'SOURCE_PR');
        ensure(typeof raw.body==='string','SOURCE_BODY');if(!raw.body.trim())continue;
        const commit=raw.original_commit_id??raw.commit_id??'unknown';
        ensure(/^(?:[a-f0-9]{40}|unknown)$/.test(commit),'SOURCE_COMMIT');
        sources.push({sourceCommentId:`${kind}:${raw.id}`,sourceCommit:commit,sourceUrl:sourceUrl(raw.html_url),
          severity:/\[(P[0-3])\]/.exec(raw.body)?.[1]??'原文未说明',bodyMarkdown:raw.body,updatedAt:raw.updated_at??raw.submitted_at});
      }
    }
    const checks=await qualityPages(io,`${root}/commits/${context.head}/check-runs?filter=all`,'check_runs');
    ensure(checks.every(x=>positive(x.id))&&new Set(checks.map(x=>x.id)).size===checks.length,'SOURCE_DUPLICATE');
    for(const run of checks) {
      if(!trusted('annotation',run.app?.id,run.app?.slug))continue;
      ensure(run.head_sha===context.head&&Array.isArray(run.pull_requests),'SOURCE_CHECK');
      // GitHub may omit PR association for a fork. Such a run is not attributed by inference.
      if(!run.pull_requests.some((pr:any)=>pr.number===context.pullRequestNumber&&pr.base?.repo?.id===context.repositoryId))continue;
      const annotations=await qualityPages(io,`${root}/check-runs/${run.id}/annotations`);
      ensure(annotations.length===run.output?.annotations_count,'ANNOTATION_COUNT');
      for(const [index,raw] of annotations.entries()) {
        ensure(typeof raw.message==='string'&&raw.message.trim()&&typeof raw.path==='string'&&positive(raw.start_line)
          &&positive(raw.end_line)&&['notice','warning','failure'].includes(raw.annotation_level),'ANNOTATION_SCHEMA');
        // REST annotations expose no independent ID. Bind their native Check ID,
        // position and canonical payload, rather than treating a model ID as native.
        const id=`annotation:${run.id}:${index}:${await qualityDigest(raw)}`;
        const fence='~'.repeat(Math.max(3,...(String(raw.raw_details??'').match(/~+/g)??[]).map(x=>x.length+1)));
        const body=[raw.title,`${raw.path}:${raw.start_line}-${raw.end_line}`,raw.message,
          raw.raw_details?`\n\n${fence}text\n${raw.raw_details}\n${fence}`:null].filter(Boolean).join('\n\n');
        sources.push({sourceCommentId:id,sourceCommit:run.head_sha,sourceUrl:sourceUrl(run.html_url),severity:raw.annotation_level,
          bodyMarkdown:body,updatedAt:run.completed_at??run.started_at});
      }
    }
    await assertPr();return sources.sort((a,b)=>a.sourceCommentId.localeCompare(b.sourceCommentId));
  }
  const first=await read(),second=await read();ensure(same(first,second),'SOURCE_SET_CHANGED');return second;
}

/** A process crash after the durable intent consumes an attempt. No claim of exactly-once model billing. */
export async function translateQualitySources(cache:QualityCache,client:QualityModelClient,store:QualityStore,
  budget:{remaining:number;deadline:number},clock:()=>number=Date.now) {
  const keys=cache.heads[cache.currentHead]!.keys;
  const claimedSources=new Set<string>();
  for(const key of keys)ensure(await qualitySegmentKey(cache.entries[key]!.segment,cache.entries[key]!.configVersion)===key,'CACHE_KEY');
  // Legacy snapshots can contain three already-durable refusals. Preserve them once more
  // before compacting, so the next generation intent cannot exceed the closed snapshot bound.
  const legacy=Object.values(cache.entries).filter(entry=>entry.attempts.filter(a=>a.status==='WAIT_AUTH'||a.status==='WAIT_QUOTA').length>1);
  if(legacy.length) {
    await store.save(cache);
    for(const entry of legacy) {
      const latest=entry.attempts.findLast(a=>a.status==='WAIT_AUTH'||a.status==='WAIT_QUOTA');
      entry.attempts=entry.attempts.filter(a=>a===latest||a.status!=='WAIT_AUTH'&&a.status!=='WAIT_QUOTA');
    }
    await store.save(cache);
  }
  while(budget.remaining>0&&clock()<budget.deadline) {
    const entries:QualityEntry[]=[];const start=keys.length?cache.cursor%keys.length:0;
    for(let i=0;i<keys.length;i++) {
      const entry=cache.entries[keys[(start+i)%keys.length]!]!;
      if(entry.result||qualityGenerationAttempts(entry.attempts)>=3||entry.nextCheckAt&&Date.parse(entry.nextCheckAt)>clock())continue;
      if(!claimedSources.has(entry.segment.sourceCommentId)&&claimedSources.size>=10)continue;
      try{qualityBatchInput([...entries.map(e=>e.segment),entry.segment]);}catch{if(!entries.length)throw new Error('QUALITY_INPUT_LIMIT');break;}
      entries.push(entry);claimedSources.add(entry.segment.sourceCommentId);if(entries.length===10)break;
    }
    if(!entries.length)break;
    let readiness:Awaited<ReturnType<QualityModelClient['preflight']>>;
    try{readiness=await client.preflight();}catch(error){
      for(const entry of entries){entry.errorCode=safeCode(error);entry.nextCheckAt=new Date(clock()+60_000).toISOString();}
      await store.save(cache);break;
    }
    if(readiness.status!=='READY') {
      for(const entry of entries){entry.errorCode=readiness.status;entry.nextCheckAt=new Date(clock()+60_000).toISOString();}
      await store.save(cache);break;
    }
    if(clock()>=budget.deadline)break;
    const now=clock();budget.remaining--;
    for(const entry of entries) {
      entry.attempts.push({startedAt:new Date(now).toISOString(),status:'UNKNOWN',model:null,usage:null});
      entry.nextCheckAt=qualityGenerationAttempts(entry.attempts)>=3?null:new Date(now+(qualityGenerationAttempts(entry.attempts)<=1?60_000:300_000)).toISOString();entry.errorCode='RESPONSE_UNKNOWN';
    }
    cache.cursor=(keys.indexOf(entries.at(-1)!.key)+1)%keys.length;
    await store.save(cache); // Must succeed before any model call.
    try {
      const reply=await client.call(entries.map(e=>e.segment));
      const translated=validateQualityOutput({items:reply.items},entries.map(e=>e.segment));
      for(const [index,entry] of entries.entries()) {entry.result=translated[index]!;entry.nextCheckAt=null;entry.errorCode=null;
        Object.assign(entry.attempts.at(-1)!,{status:'COMPLETE',model:reply.model,usage:reply.usage});}
    } catch(error) {
      const code=safeCode(error),retry=Number((error as any)?.retryAfterMs);
      for(const entry of entries) {entry.errorCode=code;entry.attempts.at(-1)!.status=code==='WAIT_AUTH'||code==='WAIT_QUOTA'?code:'FAILED';
        if(qualityGenerationAttempts(entry.attempts)<3)entry.nextCheckAt=new Date(Math.max(clock()+(qualityGenerationAttempts(entry.attempts)<=1?60_000:300_000),clock()+(Number.isFinite(retry)&&retry>0?retry:0))).toISOString();}
    }
    await store.save(cache);
    // Stop this wake after a definite refusal; the next observation checks identity again.
    if(entries.some(entry=>entry.errorCode==='WAIT_AUTH'||entry.errorCode==='WAIT_QUOTA')) {
      // The preceding save durably retains every refusal in protected fast-forward Git history.
      // Keep only the latest definite refusal in the active snapshot; possible generations remain intact.
      for(const entry of entries) {
        const latest=entry.attempts.findLast(a=>a.status==='WAIT_AUTH'||a.status==='WAIT_QUOTA');
        entry.attempts=entry.attempts.filter(a=>a===latest||a.status!=='WAIT_AUTH'&&a.status!=='WAIT_QUOTA');
      }
      await store.save(cache);break;
    }
  }
  return cache;
}

/** Only our own exact PR/head Check is writable, always neutral. Lost responses are read back before retry. */
export async function publishQualityCheck(context:QualityContext,cache:QualityCache,io:QualityIO,store:QualityStore) {
  contextValid(context);const head=cache.heads[context.head]!;
  ensure(cache.currentHead===context.head&&cache.repositoryId===context.repositoryId&&cache.pullRequestNumber===context.pullRequestNumber&&head,'CACHE_IDENTITY');
  const rendered=renderQualitySummary(cache),path=`quality/${context.pullRequestNumber}/${context.head}.md`;
  const saved=await store.save(cache,Buffer.byteLength(rendered.markdown)>48*1024?{path,content:rendered.markdown}:undefined);
  ensure(/^[a-f0-9]{40}$/.test(saved.commit),'STORE_COMMIT');
  const summary=Buffer.byteLength(rendered.markdown)<=48*1024?rendered.markdown:
    `已读取 ${rendered.total} 项，中文完成 ${rendered.complete} 项，待完成 ${rendered.pending} 项。\n\n[完整中文说明](https://github.com/${context.repository}/blob/${saved.commit}/${path})`;
  const output={title:QUALITY_CHECK_NAME,summary},root=`/repos/${context.repository}`;
  async function lookup() {
    const matches=(await qualityPages(io,`${root}/commits/${context.head}/check-runs?filter=all`,'check_runs'))
      .filter(run=>run.app?.id===context.appId&&run.name===QUALITY_CHECK_NAME&&run.head_sha===context.head&&run.external_id===head.externalId);
    ensure(matches.length<=1,'CHECK_AMBIGUOUS');
    const value=matches[0]??null;
    if(value)ensure(positive(value.id)&&value.app?.id===context.appId&&value.head_sha===context.head,'CHECK_IDENTITY');
    if(head.checkId!==null)ensure(value?.id===head.checkId,'CHECK_IDENTITY');return value;
  }
  let check=await lookup();
  if(!check||check.status!=='completed'||check.conclusion!=='neutral'||!same(check.output?.summary,summary)||check.output?.title!==QUALITY_CHECK_NAME) {
    try{await io.writeCheck({name:QUALITY_CHECK_NAME,head_sha:context.head,external_id:head.externalId,status:'completed',conclusion:'neutral',output},check?.id??null);}catch{/* Read back the exact native object after a lost response. */}
    check=await lookup();
  }
  ensure(check&&check.status==='completed'&&check.conclusion==='neutral'&&check.output?.summary===summary&&check.output?.title===QUALITY_CHECK_NAME,'CHECK_UNCONFIRMED');
  head.checkId=check.id;await store.save(cache);return rendered;
}

export async function serviceQualityPullRequest(context:QualityContext,identities:QualityIdentity[],cache:QualityCache|null,
  io:QualityIO,store:QualityStore,client:QualityModelClient,budget:{remaining:number;deadline:number},clock:()=>number=Date.now) {
  const sources=await collectQualitySources(context,identities,io);
  const next=await reconcileQualitySources(cache,{...context,observedAt:new Date(clock()).toISOString()},sources);
  await store.save(next);
  await translateQualitySources(next,client,store,budget,clock);
  // Head changes after processing do not attach old findings to a new head.
  const {value:pr}=await io.get(`/repos/${context.repository}/pulls/${context.pullRequestNumber}`);
  ensure(pr.head?.sha===context.head&&pr.base?.repo?.id===context.repositoryId&&pr.state==='open','PR_CHANGED');
  return publishQualityCheck(context,next,io,store);
}
