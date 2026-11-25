import { expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { decodeStateFile } from '../../core/src/release-observation.js';

const { failedDraftRun, failedDraftJob, unknownDraftResponse, recoverDraft, recoverProduct, nextClaim } =
  await import(pathToFileURL(resolve('scripts/candidate-draft-recovery.mjs')).href);
const { officialCandidateRoundId, bodyDigest } = await import(pathToFileURL(resolve('scripts/official-release-candidate.mjs')).href);
const key='c'.repeat(64), sha='a'.repeat(40), central={id:1296724484};
const run={id:100,run_attempt:1,repository:central,head_repository:central,workflow_id:421504821,
  path:'.github/workflows/release-candidate-event.yml',event:'workflow_dispatch',head_branch:'main',
  actor:{id:301115370},head_sha:sha,display_title:'Candidate event '+key,status:'completed',conclusion:'failure'};
const steps=[
  ['Compute or restore the official candidate','success'],['Draft the release notes with Copilot','failure'],
  ['Record the draft and check body, version and source','skipped'],['Issue the product candidate token','skipped'],
  ['Create or refresh the candidate with validated inputs','skipped'],
].map(([name,conclusion])=>({name,conclusion}));
const job={id:99,run_id:100,head_sha:sha,run_attempt:1,name:'event',conclusion:'failure',status:'completed',steps};
const diagnostic='2026-11-24T19:07:29.6826840Z RESPONSE_UNKNOWN stage=generate';

it('binds a unique App push on the central workflow and a source-only drafting failure',()=>{
  expect(failedDraftRun([run],key)).toEqual(run);
  for(const changes of [{actor:{id:1}},{head_repository:{id:1}},{conclusion:'success'},{status:'in_progress'},
    {event:'pull_request'},{head_branch:'branch'},{workflow_id:1},{run_attempt:2}])
    expect(failedDraftRun([{...run,...changes}],key)).toBeNull();
  expect(failedDraftRun([run,{...run,id:101,status:'queued'}],key)).toBeNull();
  expect(failedDraftJob(run,[job])).toEqual(job);
  for (const step of steps) expect(failedDraftJob(run,[{...job,steps:steps.filter(item=>item!==step)}])).toBeNull();
  expect(failedDraftJob(run,[{...job,steps:steps.map(item=>({...item,conclusion:'success'}))}])).toBeNull();
  expect(unknownDraftResponse(diagnostic)).toBe(true);
  expect(unknownDraftResponse(diagnostic+' sdk_stage=send status=503')).toBe(true);
  expect(unknownDraftResponse(diagnostic+' sdk_stage=send sdk_error=policy status=403')).toBe(false);
  expect(unknownDraftResponse(diagnostic.replace('RESPONSE_UNKNOWN','WAIT_QUOTA'))).toBe(false);
  expect(unknownDraftResponse(diagnostic+'\n'+diagnostic)).toBe(false);
});

it('persists one claim before dispatch and preserves it across an ambiguous POST and a restart',async()=>{
  let reserved=false;
  const reserve=vi.fn(async()=>{if(reserved)return false;reserved=true;return true;});
  const dispatch=vi.fn(async()=>{throw Error('lost response');});
  const reader={json:async()=>run,pages:async()=>[job],response:async()=>({bytes:Buffer.from(diagnostic)})};
  const options={run,reader,reserve,dispatch,admit:async()=>true,settle:vi.fn()};
  const missingLogs={...reader,response:async()=>{throw Object.assign(new Error('expired'),{status:410});}};
  await expect(recoverDraft({...options,reader:missingLogs})).resolves.toBe('LOG_UNAVAILABLE');
  await expect(recoverDraft({...options,admit:async()=>false})).resolves.toBe('SUPERSEDED');
  expect(reserve).not.toHaveBeenCalled();
  await expect(recoverDraft(options)).rejects.toThrow('lost response');
  await expect(recoverDraft(options)).resolves.toBe('ALREADY_RESERVED');
  expect(dispatch).toHaveBeenCalledTimes(1);
  const moved=vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(recoverDraft({...options,admit:moved,reserve:async()=>true})).resolves.toBe('SUPERSEDED');
  expect(options.settle).toHaveBeenCalledWith(true,'not-sent');
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('decodes the durable claim in the central ledger only, bound to product, source and original run',()=>{
  const claim={schemaVersion:1,productId:17,sourceSha:sha,roundId:key,failedRunId:100,failedAttempt:1,
    coordinatorRunId:102,coordinatorAttempt:1,controllerSha:'b'.repeat(40),dispatchAttempt:1};
  const path='maintenance/candidate-draft-17-'+sha+'-1.json', bytes=Buffer.from(JSON.stringify(claim));
  expect(decodeStateFile('steward/release-state',path,bytes,central.id)).toEqual(claim);
  for(const invalid of [{...claim,productId:18},{...claim,sourceSha:'f'.repeat(40)},{...claim,failedRunId:0}])
    expect(()=>decodeStateFile('steward/release-state',path,Buffer.from(JSON.stringify(invalid)),central.id)).toThrow();
  expect(()=>decodeStateFile('steward/release-state',path,bytes,17)).toThrow();
});

it('permits another coordinator after a recorded refusal and preserves an ambiguous or accepted POST',async()=>{
  const value={schemaVersion:1,productId:17,sourceSha:sha,roundId:key,failedRunId:100,failedAttempt:1,
    coordinatorRunId:102,coordinatorAttempt:1,controllerSha:'b'.repeat(40)};
  const records=new Map(), first=nextClaim(records,value), another={...value,coordinatorRunId:103};
  const rejection=first.path.replace('.json','-rejected.json');
  const reader={json:async()=>run,pages:async()=>[job],response:async()=>({bytes:Buffer.from(diagnostic)})};
  const options={run,reader,admit:async()=>true,reserve:async()=>{records.set(first.path,first.value);return first.value;},
    settle:vi.fn(async(claim:object,outcome:string,status:number)=>{expect(outcome).toBe('rejected');records.set(rejection,{...claim,responseStatus:status});})};
  await expect(recoverDraft({...options,dispatch:async()=>503})).rejects.toThrow('DISPATCH_UNCONFIRMED');
  expect(nextClaim(records,another)).toBeNull();
  expect(options.settle).not.toHaveBeenCalled();
  await expect(recoverDraft({...options,dispatch:async()=>403})).resolves.toBe('DISPATCH_REJECTED');
  expect(nextClaim(records,value)).toBeNull();
  const next=nextClaim(records,another);
  expect(next.value.dispatchAttempt).toBe(2);
  expect(decodeStateFile('steward/release-state',rejection,Buffer.from(JSON.stringify(records.get(rejection))),central.id)).toEqual(records.get(rejection));
  await expect(recoverDraft({...options,reserve:async()=>{records.set(next.path,next.value);return next.value;},dispatch:async()=>204})).resolves.toBe('DISPATCHED');
  expect(nextClaim(records,{...value,coordinatorRunId:104})).toBeNull();
  records.set(rejection,{...first.value,responseStatus:500});
  expect(()=>nextClaim(records,another)).toThrow('REJECTION_IDENTITY');
});

it.each(['accepted','moved','closed','paused','paused after claim','refused then paused','lost response'] as const)('reconciles a product through the App and both repositories: %s',async scenario=>{
  const repo={id:17,full_name:'splrad/test-project',default_branch:'main'};
  const event={kind:'push',repositoryId:repo.id,sourceSha:sha};
  const requestKey=bodyDigest(JSON.stringify([repo.id,'push',sha]));
  const original={...run,display_title:'Candidate event '+requestKey};
  const stateSha='b'.repeat(40), priorHead='d'.repeat(40), controller='e'.repeat(40);
  const source={sourceSha:sha,baseline:{tag:'v1.0.0',sha:stateSha},prior:{number:9,head:priorHead},
    candidate:{base:'main',title:'release 1.0.1',head:'release-please--branches--main',version:'1.0.1',body:'notes',labels:[],files:[]}};
  const round={source,head:stateSha,roundId:officialCandidateRoundId(repo,source)};
  const records=new Map();
  const post=vi.fn(async(body:object)=>{
    expect(body).toEqual({ref:'main',inputs:{request_key:requestKey,source_sha:sha,policy_sha:controller,event_json:JSON.stringify(event)}});
    if(scenario==='lost response') throw new Error('response lost');
    if(scenario==='refused then paused' && coordinatorId===102) {paused=true;return {status:403};}
    return {status:204};
  });
  let defaultReads=0;
  let paused=scenario==='paused', coordinatorId=102;
  const transport=(token:string)=>({request:async(method:string,path:string,_limit:number,body:object)=>{
    if(method==='POST'){
      expect(token).toBe('actions'); expect(path).toBe('/repos/splrad/steward/actions/workflows/421504821/dispatches');
      return post(body);
    }
    expect(token).toBe('read'); expect(path.startsWith('/repos/'+repo.full_name+'/')).toBe(true);
    const ref=decodeURIComponent(path.split('/heads/')[1]??'');
    const data=ref?{ref:'refs/heads/'+ref,object:{type:'commit',sha:ref==='main'?(++defaultReads>1 && scenario==='moved'?controller:sha):stateSha}}:
      {number:9,title:'release 1.0.1',state:scenario==='closed'?'closed':'open',merged:false,user:{id:301115370},labels:[{name:'autorelease: pending'}],
        base:{repo,ref:'main'},head:{repo,ref:source.candidate.head,sha:priorHead}};
    return {status:200,bytes:Buffer.from(JSON.stringify(data))};
  }});
  let reading = false;
  const app={forCandidateReadRepository:async(id:number,fn:Function)=>{
    expect(id).toBe(17);expect(reading).toBe(false);reading=true;
    try {return await fn('read');} finally {reading=false;}
  },forCandidateRepository:async(id:number,fn:Function)=>{
    expect(id).toBe(17);expect(reading).toBe(false);return fn('state','read');
  },
    forRepository:async(id:number,fn:Function,purpose:string)=>{expect([id,purpose]).toEqual([central.id,'configuration-actions']);return fn('actions');}};
  const reader={json:async()=>original,pages:async()=>[job],response:async()=>({bytes:Buffer.from(diagnostic)})};
  const call=()=>recoverProduct({app,root:'fixture',repo,reader,history:async()=>[original],runs:[original],promoted:async()=>true,
    coordinator:{runId:coordinatorId,runAttempt:1},controller},{transport,isPaused:async()=>paused,loadRound:async()=>round,
    writeRecord:async(_app:unknown,_root:string,admit:Function|null,plan:Function)=>{
      if(admit) expect(await admit()).toBe(true);
      const proposal=plan(records);if(!proposal)return null;
      records.set(proposal.path,proposal.value);
      if (scenario==='paused after claim' && coordinatorId===102 && admit) paused=true;
      return proposal.value;
    }});
  if(scenario==='paused') expect(await call()).toBeUndefined();
  else if(scenario==='moved' || scenario==='closed') expect((await call()).result).toBe('SUPERSEDED');
  else {
    if (scenario==='paused after claim') {
      expect((await call()).result).toBe('SUPERSEDED');
      expect(post).not.toHaveBeenCalled();
      expect([...records.keys()]).toContain(`maintenance/candidate-draft-17-${sha}-1-not-sent.json`);
      paused=false;coordinatorId++;
    }
    if (scenario==='refused then paused') {
      expect((await call()).result).toBe('DISPATCH_REJECTED');
      expect([...records.keys()]).toContain(`maintenance/candidate-draft-17-${sha}-1-rejected.json`);
      expect(await call()).toBeUndefined();
      paused=false;coordinatorId++;
    }
    if(scenario==='lost response') await expect(call()).rejects.toMatchObject({message:'CANDIDATE_RECOVERY_FAILED',stage:'dispatch'});
    else expect((await call()).result).toBe('DISPATCHED');
    expect((await call()).result).toBe('ALREADY_RESERVED');
  }
  expect(post).toHaveBeenCalledTimes(scenario==='refused then paused'?2:['accepted','lost response','paused after claim'].includes(scenario)?1:0);
});
