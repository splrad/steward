import { expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { decodeStateFile } from '../../core/src/release-observation.js';

const { failedDraftRun, failedDraftJob, unknownDraftResponse, recoverDraft } =
  await import(pathToFileURL(resolve('scripts/candidate-draft-recovery.mjs')).href);
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
  const options={run,reader,reserve,dispatch,admit:async()=>true};
  const missingLogs={...reader,response:async()=>{throw Object.assign(new Error('expired'),{status:410});}};
  await expect(recoverDraft({...options,reader:missingLogs})).resolves.toBe('LOG_UNAVAILABLE');
  await expect(recoverDraft({...options,admit:async()=>false})).resolves.toBe('SUPERSEDED');
  expect(reserve).not.toHaveBeenCalled();
  await expect(recoverDraft(options)).rejects.toThrow('lost response');
  await expect(recoverDraft(options)).resolves.toBe('ALREADY_RESERVED');
  expect(dispatch).toHaveBeenCalledTimes(1);
  const moved=vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(recoverDraft({...options,admit:moved,reserve:async()=>true})).resolves.toBe('SUPERSEDED');
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('decodes the durable claim in the central ledger only, bound to product, source and original run',()=>{
  const claim={schemaVersion:1,productId:17,sourceSha:sha,roundId:key,failedRunId:100,failedAttempt:1,
    coordinatorRunId:102,coordinatorAttempt:1,controllerSha:'b'.repeat(40)};
  const path='maintenance/candidate-draft-17-'+sha+'.json', bytes=Buffer.from(JSON.stringify(claim));
  expect(decodeStateFile('steward/release-state',path,bytes,central.id)).toEqual(claim);
  for(const invalid of [{...claim,productId:18},{...claim,sourceSha:'f'.repeat(40)},{...claim,failedRunId:0}])
    expect(()=>decodeStateFile('steward/release-state',path,Buffer.from(JSON.stringify(invalid)),central.id)).toThrow();
  expect(()=>decodeStateFile('steward/release-state',path,bytes,17)).toThrow();
});
