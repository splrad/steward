import {expect,it} from 'vitest';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {verifyCompletion}=await import(pathToFileURL(resolve('scripts/maintenance-event.mjs')).href);
const rid=1296724484, repo={id:rid,default_branch:'main'}, sha='a'.repeat(40);
const receiver='.github/workflows/maintenance-event.yml', producer='.github/workflows/sync-managed.yml';
const make=()=>{
  const env={GITHUB_EVENT_NAME:'workflow_run',GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:String(rid),
    GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:'splrad/steward/'+receiver+'@refs/heads/main',
    GITHUB_SHA:sha,STEWARD_CONTROLLER_SHA:sha,GITHUB_RUN_ID:'31',GITHUB_RUN_ATTEMPT:'2'};
  const run={id:30,run_attempt:1,event:'repository_dispatch',status:'completed',head_sha:sha,path:producer,workflow_id:408662213,
    repository:repo,head_repository:repo,head_branch:'main'};
  const event={action:'completed',repository:repo,workflow_run:run};
  const origin={...run,id:31,run_attempt:2,path:receiver,workflow_id:33,event:'workflow_run'};
  const own={id:33,path:receiver,state:'active'};
  const workflow={id:408662213,path:producer,state:'active'};
  const responses:Record<string,unknown>={'git/ref/heads/main':{ref:'refs/heads/main',object:{type:'commit',sha}},'actions/runs/31':origin,'actions/workflows/maintenance-event.yml':own,
    'actions/workflows/408662213':workflow};
  const reader={json:async(path:string)=>{if(!responses[path])throw Error('unexpected read '+path);return responses[path];}};
  return {env,run,origin,own,workflow,event,reader};
};
it('binds the completed source and checks receiver pause again before the POST',async()=>{
  const f=make(),target=await verifyCompletion(f.env,f.event,f.reader);
  expect(target.definition.file).toBe('sync-managed.yml');
  f.own.state='disabled_manually';
  await expect(target.beforePost()).rejects.toThrow('RECEIVER_STATE');
});
it.each(['fork','branch','path','event','action','not-completed','other-workflow','origin-attempt','origin-ref','disabled'])('refuses wrong %s',async kind=>{
  const f=make();
  if(kind==='fork')f.run.head_repository={...repo,id:1};
  if(kind==='branch')f.run.head_branch='feature';
  if(kind==='path')f.run.path=receiver;
  if(kind==='event')f.run.event='pull_request';
  if(kind==='action')f.event.action='requested';
  if(kind==='not-completed')f.run.status='in_progress';
  if(kind==='other-workflow')f.workflow.id=77;
  if(kind==='origin-attempt')f.origin.run_attempt++;
  if(kind==='origin-ref')f.env.GITHUB_WORKFLOW_REF+='-other';
  if(kind==='disabled')f.own.state='disabled_manually';
  await expect(verifyCompletion(f.env,f.event,f.reader)).rejects.toThrow('MAINTENANCE_EVENT_');
});

it('withdraws a queued receiver when its policy SHA is superseded',async()=>{
  const f=make(),target=await verifyCompletion(f.env,f.event,f.reader);
  f.env.GITHUB_SHA='b'.repeat(40);
  await expect(target.beforePost()).rejects.toThrow('POLICY_MOVED');
});
