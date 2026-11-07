import {test} from 'vitest';
import assert from 'node:assert/strict';
// @ts-expect-error fixed native entry script is exercised directly.
import {assertTemplateWake} from '../../../scripts/template-entry.mjs';
const env={GITHUB_EVENT_NAME:'repository_dispatch'};
test('push, schedule, workflow_run and pull requests cannot write templates',()=>{
 for(const event of ['push','schedule','workflow_run','pull_request'])assert.throws(()=>assertTemplateWake({...env,GITHUB_EVENT_NAME:event},{}));
});
test('fixed App event carries no private repository or ref selection',()=>{
 const e={action:'steward-template-event',sender:{id:353238212,login:'splrad-governance[bot]',type:'Bot'},client_payload:{schemaVersion:1}};
 const v={...env,GITHUB_EVENT_NAME:'repository_dispatch'};assertTemplateWake(v,e);
 for(const change of [{sender:{...e.sender,id:1}},{action:'other'},{client_payload:{schemaVersion:1,repository:'private/name'}},{client_payload:{schemaVersion:2}}])assert.throws(()=>assertTemplateWake(v,{...e,...change}));
});
test('manual recovery is separate from health-only wakes',()=>{
 const e={...env,GITHUB_EVENT_NAME:'workflow_dispatch'};assertTemplateWake(e,{});
 for(const value of [true,'true'])assert.throws(()=>assertTemplateWake(e,{inputs:{health_only:value}}));
});
