import { afterEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { assertRequiredValidation, assertWorkflowDocument, verifyWorkflowPolicy } from '../src/workflow-policy.js';
import { main } from '../src/index.js';
const ordinary=()=>({on:{pull_request:{}},permissions:{contents:'read'},jobs:{test:{'runs-on':'ubuntu-latest',steps:[{run:'npm test'}]}}});
afterEach(()=>vi.unstubAllEnvs());
describe('trusted workflow security policy',()=>{
 it('allows an ordinary workflow regardless of its name',()=>{expect(()=>assertWorkflowDocument('new-name.yml',ordinary())).not.toThrow();});
 it.each([
  "github.event['pull_request']['title']", "github['event'].pull_request.title", "github['event']['inputs']['value']",
  'github.event.inputs.value', 'github.event.commits[0].message', 'github.event.workflow_run.head_branch',
  'GITHUB.EVENT.PULL_REQUEST.TITLE', "github [ 'event' ]", 'toJSON(github.event)', 'toJSON(github)',
  'github.ref', 'github.actor', 'github.head_ref', "github.sha || github.ref", "format('{0}', github.ref)",
  "github.actor_id == '301115370' && github.ref || 'manual'",
 ])('rejects untrusted shell event expression: %s',expression=>{
  const d=ordinary();d.jobs.test.steps[0]!.run='echo "${{ '+expression+' }}"';
  expect(()=>assertWorkflowDocument('test.yml',d)).toThrow('untrusted event');
 });
 it('accepts event data through env and the gate boolean in shell',()=>{
  const d:any=ordinary();d.jobs.test.steps=[{env:{TITLE:"${{ github.event['pull_request']['title'] }}"},run:'echo "$TITLE"'},{run:'echo "${{ github.event.repository.private }}"'}];
  expect(()=>assertWorkflowDocument('test.yml',d)).not.toThrow();
 });
 it.each(['self-hosted','ubuntu-latest'])('rejects unverified dynamic runner output: %s',runner=>{
  const d:any=ordinary();d.on={workflow_dispatch:{}};
  d.jobs.plan={'runs-on':'ubuntu-latest',environment:{name:'steward-release',deployment:false},outputs:{runner:'${{ steps.select.outputs.runner }}'},steps:[{id:'select',run:`echo "runner=${runner}" >> "$GITHUB_OUTPUT"`}]};
  d.jobs.test.needs='plan';d.jobs.test['runs-on']='${{ needs.plan.outputs.runner }}';
  expect(()=>assertWorkflowDocument('test.yml',d)).toThrow('runner not permitted');
 });
 it.each(['ubuntu-latest','ubuntu-24.04','windows-latest','windows-2025','macos-latest'])('accepts static hosted runner: %s',runner=>{const d=ordinary();d.jobs.test['runs-on']=runner;expect(()=>assertWorkflowDocument('test.yml',d)).not.toThrow();});
 it.each(['ubuntu-999','windows-123','macos-999','ubuntu-24.04-custom','self-hosted'])('rejects unapproved static runner: %s',runner=>{const d=ordinary();d.jobs.test['runs-on']=runner;expect(()=>assertWorkflowDocument('test.yml',d)).toThrow('runner not permitted');});
 it.each(['missing','constant','cancel','extra'])('protects concurrency: %s',async kind=>{
 const d=YAML.parse(await readFile('.github/workflows/pr-validation.yml','utf8'));
 if(kind==='missing')delete d.concurrency;
 if(kind==='constant')d.concurrency.group='shared';
 if(kind==='cancel')d.concurrency['cancel-in-progress']=false;
 if(kind==='extra')d.concurrency.queue='max';
 expect(()=>assertRequiredValidation(d)).toThrow('required concurrency');
 });
 it.each(['write','implicit','trigger','action','local-action','checkout','secret','dynamic-secret','inherit','runner','shell','environment','global-secret','reusable','permission-alias'])('rejects unsafe capability: %s',kind=>{
  const d:any=ordinary(),j=d.jobs.test;
  if(kind==='write')j.permissions={contents:'write'};
  if(kind==='implicit')delete d.permissions;
  if(kind==='trigger')d.on={pull_request_target:{}};
  if(kind==='action')j.steps=[{uses:'actions/checkout@main'}];
  if(kind==='local-action')j.steps=[{uses:'./.github/actions/local'}];
  if(kind==='checkout')j.steps=[{uses:'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'}];
  if(kind==='secret')j.steps[0].env={KEY:'${{ secrets.STEWARD_APP_PRIVATE_KEY }}'};
  if(kind==='dynamic-secret')j.steps[0].env={KEY:"${{ secrets['STEWARD_APP_PRIVATE_KEY'] }}"};
  if(kind==='inherit')j.secrets='inherit';
  if(kind==='runner')j['runs-on']=['self-hosted'];
  if(kind==='shell')j.steps[0].run='echo "${{ github.event.pull_request.title }}"';
  if(kind==='environment')j.environment={name:'steward-release',deployment:false};
  if(kind==='global-secret')d.env={KEY:'${{ secrets.STEWARD_APP_PRIVATE_KEY }}'};
  if(kind==='reusable')j.uses='owner/repo/.github/workflows/test.yml@main';
  if(kind==='permission-alias')d.permissions='read-all';
  expect(()=>assertWorkflowDocument('test.yml',d)).toThrow('WORKFLOW_POLICY');
 });
 it('binds release-model and App secrets to distinct environments',()=>{const d:any=ordinary();d.on={workflow_dispatch:{}};d.jobs.test.environment={name:'steward-release-notes',deployment:false};d.jobs.test.steps[0].env={TOKEN:'${{ secrets.COPILOT_GITHUB_TOKEN }}'};expect(()=>assertWorkflowDocument('notes.yml',d)).not.toThrow();d.jobs.test.steps[0].env={TOKEN:'${{ secrets.STEWARD_APP_PRIVATE_KEY }}'};expect(()=>assertWorkflowDocument('notes.yml',d)).toThrow();});
 it.each(['workflow-name','missing-name','missing','skip','continue','source','command','checkout','extra-step','filter','global-env','defaults'])('protects required entry: %s',async kind=>{
  const d=YAML.parse(await readFile('.github/workflows/pr-validation.yml','utf8'));const j=d.jobs.validate;
  if(kind==='workflow-name')d.name='Renamed validation';
  if(kind==='missing-name')delete d.name;
  if(kind==='missing')delete d.jobs.validate;
  if(kind==='skip')j.if='false';
  if(kind==='continue')j['continue-on-error']=true;
  if(kind==='source')j.steps.find((s:any)=>s.id==='policy').run='echo sha=untrusted >> "$GITHUB_OUTPUT"';
  if(kind==='command')j.steps.find((s:any)=>s.run?.startsWith('node steward-policy')).run+=' || true';
  if(kind==='checkout')j.steps.find((s:any)=>s.with?.path==='steward-policy').with.ref='${{ github.event.pull_request.head.sha }}';
  if(kind==='extra-step')j.steps.push({run:'echo tamper'});
  if(kind==='filter')d.on.pull_request.paths=['src/**'];
  if(kind==='global-env')d.env={NODE_OPTIONS:'--import ./evil.mjs'};
  if(kind==='defaults')d.defaults={run:{'working-directory':'candidate'}};
  expect(()=>assertRequiredValidation(d)).toThrow();
 });
 it.each(['push','workflow_dispatch','workflow_run','schedule','pull_request_target'])('rejects additional required-entry trigger: %s',async trigger=>{
  const d=YAML.parse(await readFile('.github/workflows/pr-validation.yml','utf8'));d.on[trigger]={};
  expect(()=>assertRequiredValidation(d)).toThrow('required PR event coverage');
 });
 it('accepts the required entry with a changed step display name',async()=>{const d=YAML.parse(await readFile('.github/workflows/pr-validation.yml','utf8'));d.jobs.validate.steps.at(-1).name='policy SHA evidence';expect(()=>assertRequiredValidation(d)).not.toThrow();});
 it.each(['missing','skip','needs','permission','source','command','continue','env','extra-step'])('protects fragments entry: %s',async kind=>{
  const d=YAML.parse(await readFile('.github/workflows/pr-validation.yml','utf8'));const j=d.jobs.fragments;
  if(kind==='missing')delete d.jobs.fragments;
  if(kind==='skip')j.if='false';
  if(kind==='needs')delete j.needs;
  if(kind==='permission')j.permissions.checks='none';
  if(kind==='source')j.steps[0].with.ref='candidate';
  if(kind==='command')j.steps.at(-1).run='echo skipped';
  if(kind==='continue')j['continue-on-error']=true;
  if(kind==='env')j.env={NODE_OPTIONS:'--import ./evil.mjs'};
  if(kind==='extra-step')j.steps.push({run:'echo extra'});
  expect(()=>assertRequiredValidation(d)).toThrow('fragments');
 });
 it('allows inventory additions, renames and removals but never candidate self-authorization',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workflow-policy-'));try{
   await mkdir(join(dir,'.github/workflows'),{recursive:true});await mkdir(join(dir,'config'));
   const registry=(paths:string[])=>writeFile(join(dir,'config/repositories.json'),JSON.stringify({repositories:{'1296724484':{allowedWorkflowPaths:paths}}}));
   await registry(['.github/workflows/new.yml']);await writeFile(join(dir,'.github/workflows/new.yml'),YAML.stringify(ordinary()));
   await expect(verifyWorkflowPolicy(dir,1296724484,[])).resolves.toHaveLength(1);
   await registry([]);await expect(verifyWorkflowPolicy(dir,1296724484,[])).rejects.toThrow('inventory');
   await rm(join(dir,'.github/workflows/new.yml'));await registry([]);await expect(verifyWorkflowPolicy(dir,1296724484,[])).resolves.toHaveLength(0);
   await writeFile(join(dir,'.github/workflows/renamed.yml'),YAML.stringify(ordinary()));await registry(['.github/workflows/renamed.yml']);await expect(verifyWorkflowPolicy(dir,1296724484,[])).resolves.toHaveLength(1);
   await expect(verifyWorkflowPolicy(dir,1296724484,['.github/workflows/pr-validation.yml'])).rejects.toThrow('required');
   const bad:any=ordinary();bad.permissions={contents:'write'};await writeFile(join(dir,'.github/workflows/renamed.yml'),YAML.stringify(bad));await expect(verifyWorkflowPolicy(dir,1296724484,[])).rejects.toThrow('permissions');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it('rejects duplicate YAML keys and aliases',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workflow-yaml-'));try{await mkdir(join(dir,'.github/workflows'),{recursive:true});for(const text of ['on: push\non: pull_request\n','on: push\npermissions: &p {contents: read}\njobs: {a: {permissions: *p}}']){await writeFile(join(dir,'.github/workflows/a.yml'),text);await expect(verifyWorkflowPolicy(dir,1,[])).rejects.toThrow();}}finally{await rm(dir,{recursive:true,force:true});}
 });
 it('keeps downstream task failures after the trusted security check',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workflow-chain-'));try{
   const policy=join(dir,'policy'),workspace=join(dir,'target');await cp('config',policy,{recursive:true});await mkdir(join(workspace,'config'),{recursive:true});await mkdir(join(workspace,'.github/workflows'),{recursive:true});
   const registry=JSON.parse(await readFile(join(policy,'repositories.json'),'utf8'));registry.repositories['1296724484'].allowedWorkflowPaths=[];await writeFile(join(policy,'repositories.json'),JSON.stringify(registry));registry.repositories['1296724484'].allowedWorkflowPaths=['.github/workflows/test.yml'];await writeFile(join(workspace,'config/repositories.json'),JSON.stringify(registry));await writeFile(join(workspace,'.github/workflows/test.yml'),YAML.stringify(ordinary()));
   const profilePath=join(policy,'profiles/validation/steward.json');const profile=JSON.parse(await readFile(profilePath,'utf8'));profile.tasks=['parse-json'];await writeFile(profilePath,JSON.stringify(profile));vi.stubEnv('STEWARD_CONFIG_DIRECTORY',policy);vi.stubEnv('VALIDATION_BASE_SHA','');vi.stubEnv('VALIDATION_BASE_REF','');vi.stubEnv('GITHUB_STEP_SUMMARY',join(dir,'summary'));
   const run=()=>main(['validate','--workspace',workspace,'--repository-id','1296724484','--profile','steward']);await expect(run()).resolves.toBeUndefined();await writeFile(join(workspace,'broken.json'),'{');await expect(run()).rejects.toThrow('验证任务失败');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
