import {expect,it} from 'vitest';
import {decodeMaintenanceRecord,maintenanceDisposition,assertMaintenanceProgress} from '../../core/src/maintenance.js';
import {decodeStateFile} from '../../core/src/release-observation.js';

function historical(kind='matrix') {
  const job=(id:number,key:string,conclusion:string,matrixIndex:number|null=null)=>({id,key,matrixIndex,attempt:1,conclusion,empty:null as string|null,found:null as string|null});
  const targets={...job(1,'targets','success'),empty:kind==='empty'?'success':'skipped',found:kind==='empty'?'skipped':'success'};
  return {schemaVersion:1,repositoryId:1296724484,workflowFile:'update-dependencies.yml',workflowId:8,runId:12,
    headSha:'a'.repeat(40),headBranch:'main',event:'schedule',createdAt:'2026-10-30T00:00:00.000Z',runAttempt:1,conclusion:'failure',
    jobs:[targets,job(2,'update',kind==='empty'?'skipped':'success',kind==='empty'?null:0),job(3,'automation-health','failure')],
    observedAt:'2026-10-31T00:00:00.000Z',requests:[] as any[]};
}
const decode=(value:unknown)=>decodeMaintenanceRecord(Buffer.from(JSON.stringify(value)),1296724484,'maintenance/12.json');
it.each(['empty','matrix'])('keeps retired Renovate %s and health-only history readable',kind=>{
  const value=historical(kind),record=decode(value);
  expect(decodeStateFile('steward/release-state','maintenance/12.json',Buffer.from(JSON.stringify(value)),1296724484)).toEqual(record);
  expect(maintenanceDisposition(record)).toBe('SATISFIED');
  const after=structuredClone(value);after.runAttempt=2;after.jobs.push({...after.jobs[2]!,id:4,attempt:2});
  expect(maintenanceDisposition(decode(after))).toBe('SATISFIED');
  expect(()=>assertMaintenanceProgress(record,decode(after))).not.toThrow();
});
it.each(['gap','ambiguous','missing'])('preserves unknown retired matrix evidence: %s',kind=>{
  const value=historical();
  if(kind==='gap')value.jobs[1]!.matrixIndex=1;
  if(kind==='ambiguous')value.jobs[0]!.empty='success';
  if(kind==='missing')value.jobs.splice(1,1);
  expect(maintenanceDisposition(decode(value))).toBe('UNKNOWN');
});
it('retains historical failed updates and recovery requests without resetting their budget',()=>{
  const value=historical();value.jobs[1]!.conclusion='failure';
  value.requests=[{fromAttempt:1,requestedAt:value.observedAt,coordinatorRunId:900,coordinatorRunAttempt:1,responseStatus:null}];
  const record=decode(value);expect(maintenanceDisposition(record)).toBe('FAILED');
  const reset=structuredClone(value);reset.requests=[];
  expect(()=>assertMaintenanceProgress(record,decode(reset))).toThrow('REQUEST_REMOVED');
});
