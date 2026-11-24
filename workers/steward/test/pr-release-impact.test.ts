import { expect, it, vi } from 'vitest';
import { dispatchReleaseImpact } from '../src/pr-release-impact.js';

it('dispatches signed PR changes without disclosing private PR metadata and ignores label and release-candidate events', async () => {
  const env = {BOUNDED_RECHECK_ENABLED:'true',INSTALLATION_ID:'12',STEWARD_WEBHOOK_SECRET:'fixture'} as any;
  const guid = '12345678-abcd-4000-8000-123456789abc';
  const repo = {id:17,owner:{id:302208797},default_branch:'main',private:true};
  const pr = {number:12,state:'open',head:{sha:'e'.repeat(40),ref:'private-work'},base:{repo,ref:'main'},user:{id:12}};
  const event = {action:'opened',repository:repo,pull_request:pr,installation:{id:12}};
  const json = vi.fn(async () => null);
  const reader = () => ({json}) as any;
  await dispatchReleaseImpact(env,'pull_request',event,guid,reader);
  expect(json).toHaveBeenCalledExactlyOnceWith(1296724484,'/repos/splrad/steward/actions/workflows/pr-release-impact.yml/dispatches',
    'POST',{ref:'main',inputs:{delivery:guid,group:expect.stringMatching(/^[0-9a-f]{64}$/)}});
  for(const payload of [{...event,action:'labeled'},{...event,installation:{id:100}},
    {...event,pull_request:{...pr,user:{id:301115370},head:{...pr.head,ref:'release-please--branches--main'}}}])
    await dispatchReleaseImpact(env,'pull_request',payload,guid,reader);
  expect(json).toHaveBeenCalledTimes(1);
});
