import { expect, it, vi } from 'vitest';
import { dispatchReleaseImpact, ReleaseImpactIntake } from '../src/pr-release-impact.js';

it('dispatches signed PR changes without disclosing private PR metadata and ignores label and release-candidate events', async () => {
  const env = {BOUNDED_RECHECK_ENABLED:'true',INSTALLATION_ID:'12',STEWARD_WEBHOOK_SECRET:'fixture'} as any;
  const guid = '12345678-abcd-4000-8000-123456789abc';
  const repo = {id:17,full_name:'splrad/private',owner:{id:302208797},default_branch:'main',private:true};
  const pr = {number:12,state:'open',title:'a title',body:'a private description',head:{sha:'e'.repeat(40),ref:'private-work'},base:{repo,ref:'main'},user:{id:12}};
  const event = {action:'opened',repository:repo,pull_request:pr,installation:{id:12}};
  const json = vi.fn(async () => null);
  const records = new Map();
  const storage = {get:(key:string)=>records.get(key),put:(key:string,value:unknown)=>records.set(key,value)} as any;
  const buildIntake = () => new ReleaseImpactIntake(storage,env,async()=>pr,()=>({json}) as any);
  let intake = buildIntake();
  env.BOUNDED_RECHECK = {idFromName:(name:string)=>name,get:()=>({fetch:async(request:Request)=>{
    await intake.accept(await request.json()); return Response.json({accepted:true});
  }})};
  const send = (payload:any, id=guid)=>dispatchReleaseImpact(env,'pull_request',payload,id);
  const next = (i:number)=>guid.slice(0,-2) + i.toString(16).padStart(2,'0');
  await Promise.all([send(event),send(event),send({...event,action:'edited'},next(1))]);
  expect(json).toHaveBeenCalledExactlyOnceWith(1296724484,'/repos/splrad/steward/actions/workflows/pr-release-impact.yml/dispatches',
    'POST',{ref:'main',inputs:{delivery:guid,group:expect.stringMatching(/^[0-9a-f]{64}$/)}});
  for(const payload of [{...event,action:'labeled'},{...event,installation:{id:100}},
    {...event,pull_request:{...pr,user:{id:301115370},head:{...pr.head,ref:'release-please--branches--main'}}}])
    await send(payload);
  expect(json).toHaveBeenCalledTimes(1);
  for (const sender of [301115370, 29]) {
    await send({...event,action:'unlabeled',label:{name:'Internal'},sender:{id:sender}},next(2));
  }
  expect(json).toHaveBeenCalledTimes(2);
  const old = structuredClone(event);
  pr.title = 'revised';
  json.mockRejectedValueOnce(Error('temporary dispatch failure'));
  await expect(send(event,next(3))).rejects.toThrow('temporary dispatch failure');
  await send(event,next(3));
  intake = buildIntake();
  await send({...event,action:'reopened'},next(4));
  await send(old,next(5));
  expect(json).toHaveBeenCalledTimes(4);
  pr.title = 'final change';
  const queued = structuredClone(event);
  Object.assign(pr, {state:'closed',merged:false});
  await send(queued,next(6));
  expect(json).toHaveBeenCalledTimes(4);
  Object.assign(pr, {merged:true});
  await send(queued,next(6));
  expect(json).toHaveBeenCalledTimes(5);
  expect(JSON.stringify([...records])).not.toContain('private');
});
