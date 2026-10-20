import {describe,it,expect,vi} from 'vitest';
import {SerialTaskQueue} from '../src/serial-task-queue.js';
import worker,{refreshWorkflowContractChecks,type Env} from '../src/index.js';
describe('durable validation coordination',()=>{
 it.each([false,true])('reads the new approval after the old write settles (reject=%s)',async reject=>{
  const queue=new SerialTaskQueue();let release!:()=>void;const blocked=new Promise<void>(r=>{release=r;});
  let approved=true;let gate=false;const seen:boolean[]=[];
  const first=queue.run(async()=>{const snapshot=approved;await blocked;gate=snapshot;if(reject)throw Error('lost response');});
  const caught=first.catch(()=>undefined);await Promise.resolve();approved=false;
  const second=queue.run(async()=>{seen.push(approved);gate=approved;});
  await Promise.resolve();expect(seen).toEqual([]);release();await caught;await second;
  expect(seen).toEqual([false]);expect(gate).toBe(false);
 });
 it('routes review and sweep refreshes to the same object without stale snapshots',async()=>{
  const calls:any[]=[];const fetch=vi.fn(async(_url,init)=>{calls.push(JSON.parse(init.body));return new Response('{"changed":true}');});
  const idFromName=vi.fn(value=>value);const get=vi.fn(()=>({fetch}));
  const env={VALIDATION_COORDINATOR:{idFromName,get}} as unknown as Env;
  await refreshWorkflowContractChecks(env,1296724484,7,{error:Error('old')});
  await refreshWorkflowContractChecks(env,1296724484);
  expect(idFromName.mock.calls).toEqual([['1296724484'],['1296724484']]);
  expect(calls).toEqual([{operation:'refresh',repositoryId:1296724484,pullNumber:7},{operation:'refresh',repositoryId:1296724484}]);
 });
 it('fails closed without the deployed binding',async()=>{
  expect((await worker.fetch(new Request('https://example.test/github/webhook',{method:'POST',body:'{}'}),{} as Env)).status).toBe(503);
 });
});
