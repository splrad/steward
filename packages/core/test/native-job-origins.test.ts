import { expect, it } from 'vitest';
import { nativeJobOrigins, originalJobExecutions, withinNativeJobWindow } from '../src/native-job-origins.js';
import type { NativeJob } from '../src/native-evidence.js';
const job: NativeJob = {id:11,runId:42,runAttempt:1,headSha:'a'.repeat(40),name:'producer',status:'completed',conclusion:'success',
  startedAt:'2026-10-31T09:48:26.000Z',completedAt:'2026-10-31T09:48:30.000Z',steps:[{number:1,name:'business-build',
    startedAt:'2026-10-31T09:48:27.000Z',completedAt:'2026-10-31T09:48:29.000Z',conclusion:'success'}]};
const copied = () => ({...structuredClone(job),id:21,runAttempt:2});
it('accepts subsecond log receipts inside the native final second and rejects the next second',()=>{
  expect(withinNativeJobWindow('2026-10-31T09:48:30.233Z',job.startedAt!,job.completedAt)).toBe(true);
  expect(withinNativeJobWindow('2026-10-31T09:48:31.000Z',job.startedAt!,job.completedAt)).toBe(false);
  expect(withinNativeJobWindow('2026-10-31T09:48:30.234Z',job.startedAt!,'2026-10-31T09:48:30.233Z')).toBe(false);
  expect(withinNativeJobWindow('2026-10-31T09:48:25.999Z',job.startedAt!,job.completedAt)).toBe(false);
});
it('preserves original job and attempt through multiple new-ID projections without changing raw rows',()=>{
  const second=copied(),third={...copied(),id:31,runAttempt:3},attempts=[{attempt:1,jobs:[job]},{attempt:2,jobs:[second]},{attempt:3,jobs:[third]}];
  const before=JSON.stringify(attempts),origins=nativeJobOrigins(attempts);
  expect(origins.map(value=>value.origin.id)).toEqual([11,11,11]);expect(originalJobExecutions(attempts)).toEqual([job]);
  expect(JSON.stringify(attempts)).toBe(before);
});
it('counts a real rerun with a new time window even when the name and conclusion match',()=>{
  const actual={...copied(),startedAt:'2026-10-31T10:00:00.000Z',completedAt:'2026-10-31T10:00:05.000Z',steps:[]};
  expect(originalJobExecutions([{attempt:1,jobs:[job]},{attempt:2,jobs:[actual]}])).toEqual([job,actual]);
});
it.each(['steps','conclusion','source','missing-attempt','duplicate','ambiguous','changed-id'])('rejects %s instead of guessing original evidence',kind=>{
  const first=structuredClone(job),second=copied(),attempts=[{attempt:1,jobs:[first]},{attempt:2,jobs:[second]}];
  if(kind==='steps')second.steps[0]!.name='business-other';
  if(kind==='conclusion')second.conclusion='failure';
  if(kind==='source')second.headSha='b'.repeat(40);
  if(kind==='missing-attempt')attempts.shift();
  if(kind==='duplicate')attempts[1]!.jobs.push(second);
  if(kind==='ambiguous')attempts[0]!.jobs.push({...first,id:12});
  if(kind==='changed-id'){second.id=first.id;second.completedAt='2026-10-31T10:00:00.000Z';}
  expect(()=>nativeJobOrigins(attempts)).toThrow('job origin');
});
it('does not infer a retained execution from an unfinished job or absent timestamps',()=>{
  const first={...job,status:'in_progress',completedAt:null},second={...copied(),status:'in_progress',completedAt:null};
  expect(originalJobExecutions([{attempt:1,jobs:[first]},{attempt:2,jobs:[second]}])).toHaveLength(2);
});
