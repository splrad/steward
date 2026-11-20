import {generateKeyPairSync} from 'node:crypto';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {SerialTaskQueue} from '../src/serial-task-queue.js';
import worker,{refreshWorkflowContractChecks,type Env} from '../src/index.js';
afterEach(()=>vi.unstubAllGlobals());
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
 it.each([false,true])('gives sweep PRs separate budgets in the same writer queue and continues after failure (%s)',async fail=>{
  const calls:any[]=[];const fetch=vi.fn(async(_url,init)=>{calls.push(JSON.parse(init.body));return new Response('{"changed":true}');});
  const idFromName=vi.fn(value=>value);const get=vi.fn(()=>({fetch}));
  const env={APP_ID:'4243096',INSTALLATION_ID:'145952003',POLICY_SHA:'a'.repeat(40),WORKFLOW_EVALUATOR_SHA:'a'.repeat(40),
   STEWARD_APP_PRIVATE_KEY:generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{format:'pem',type:'pkcs8'},publicKeyEncoding:{format:'pem',type:'spki'}}).privateKey,
   VALIDATION_COORDINATOR:{idFromName,get}} as unknown as Env;
  vi.stubGlobal('fetch',async(url:string)=>{
   const path=new URL(String(url)).pathname;
   if(path.endsWith('/access_tokens'))return new Response('{"token":"test"}');
   if(path==='/repositories/1296724484')return new Response(JSON.stringify({id:1296724484,full_name:'splrad/steward',default_branch:'main',owner:{id:302208797}}));
   if(path==='/repos/splrad/steward/pulls')return new Response('[{"number":7},{"number":8},{"number":9}]');
   throw Error('Unexpected request '+path);
  });
  await refreshWorkflowContractChecks(env,1296724484,7,{error:Error('old')});
  if(fail)fetch.mockImplementationOnce(async(_url,init)=>{calls.push(JSON.parse(init.body));throw Error('budget exhausted');});
  const sweep=refreshWorkflowContractChecks(env,1296724484);
  if(fail)await expect(sweep).rejects.toThrow('budget exhausted');else await sweep;
  expect(idFromName.mock.calls).toEqual(Array.from({length:4},()=>['1296724484']));
  expect(calls).toEqual([7,7,8,9].map(pullNumber=>({operation:'refresh',repositoryId:1296724484,pullNumber})));
 });
 it('fails closed without the deployed binding',async()=>{
  expect((await worker.fetch(new Request('https://example.test/github/webhook',{method:'POST',body:'{}'}),{} as Env)).status).toBe(503);
 });
});
