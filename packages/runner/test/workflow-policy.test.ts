import { spawnSync } from 'node:child_process';
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
 it.each(['container','services'])('rejects container capability: %s',key=>{
 const d:any=ordinary();d.jobs.test[key]=key==='container'?'attacker/image:latest':{db:{image:'attacker/image:latest'}};
 expect(()=>assertWorkflowDocument('test.yml',d)).toThrow('containers not permitted');
 });
 it.each(['workflow','job','step'])('checks shell at %s level',level=>{
 for(const value of ['bash','pwsh', 'bash -c evil', String.fromCharCode(36)+'{{ github.event.head_commit.message }}']){
 const d:any=ordinary();
 if(level==='workflow')d.defaults={run:{shell:value}};
 if(level==='job')d.jobs.test.defaults={run:{shell:value}};
 if(level==='step')d.jobs.test.steps[0].shell=value;
 if(['bash','pwsh'].includes(value))expect(()=>assertWorkflowDocument('test.yml',d)).not.toThrow();
 else expect(()=>assertWorkflowDocument('test.yml',d)).toThrow('shell must be');
 }
 });
 it('allows omitted concurrency without cancellation',()=>{expect(()=>assertWorkflowDocument('ordinary.yml',ordinary())).not.toThrow();});
 it.each(['protected','unprivileged'])('checks workflow_run artifact download: %s',kind=>{
 const d:any=ordinary();d.on={workflow_run:{workflows:['Build'],types:['completed']}};
 if(kind==='protected')d.jobs.test.environment={name:'steward-release',deployment:false};
 d.jobs.test.steps=[{uses:'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',with:{'run-id':'${{ github.event.workflow_run.id }}'}},{run:'bash downloaded.sh'}];
 if(kind==='protected')expect(()=>assertWorkflowDocument('test.yml',d)).toThrow('artifact download');else expect(()=>assertWorkflowDocument('test.yml',d)).not.toThrow();
 });
 it.each(['env.COMMAND',"env['COMMAND']",'steps.build.outputs.command','needs.build.outputs.command','inputs.command','matrix.command','toJSON(env)'])('rejects indirect shell expression %s',expr=>{
 const d:any=ordinary();d.env={COMMAND:'${{ github.event.head_commit.message }}'};d.jobs.test.steps=[{run:'npm '+ '${{ ' +expr+' }}'}];expect(()=>assertWorkflowDocument('test.yml',d)).toThrow('indirect context');
 });
 it.each(['workflow','job'])('isolates pending concurrency queues at %s scope',scope=>{
 for(const group of ['steward-release-1187527897','${{ github.workflow }}','workflow-policy:${{ github.workflow_ref }}:build']){const d:any=ordinary();const c={group,'cancel-in-progress':false};if(scope==='workflow')d.concurrency=c;else d.jobs.test.concurrency=c;
 if(group.startsWith('workflow-policy:'))expect(()=>assertWorkflowDocument('test.yml',d)).not.toThrow();else expect(()=>assertWorkflowDocument('test.yml',d)).toThrow('namespace');}
 });
 it('binds legacy shared queues to their whole trusted workflow',async()=>{
 const path='.github/workflows/issue-sync.yml';const d=YAML.parse(await readFile(path,'utf8'));expect(()=>assertWorkflowDocument(path,d)).not.toThrow();d.on={pull_request:{}};expect(()=>assertWorkflowDocument(path,d)).toThrow('namespace');expect(()=>assertWorkflowDocument('copy.yml',d)).toThrow('namespace');
 });
 it.each(['workflow','job'])('rejects cancellation at %s scope',level=>{
 for(const cancel of [true,'true',undefined,false]){const d:any=ordinary();const c={group:'workflow-policy:${{ github.workflow_ref }}:test','cancel-in-progress':cancel};if(level==='workflow')d.concurrency=c;else d.jobs.test.concurrency=c;
 if(cancel===false)expect(()=>assertWorkflowDocument('ordinary.yml',d)).not.toThrow();else expect(()=>assertWorkflowDocument('ordinary.yml',d)).toThrow('cancellation');}
 });
 it.each(['untrusted','missing','other-repo','trusted'])('binds privileged workflow_run checkout: %s',kind=>{
 const d:any=ordinary();d.on={workflow_run:{workflows:['Build'],types:['completed']}};d.jobs.test.environment={name:'steward-release',deployment:false};
 const ref=String.fromCharCode(36)+'{{ github.workflow_sha }}';
 const step:any={uses:'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',with:{ref,'persist-credentials':false}};
 if(kind==='untrusted')step.with.ref=String.fromCharCode(36)+'{{ github.event.workflow_run.head_sha }}';if(kind==='missing')delete step.with.ref;if(kind==='other-repo')step.with.repository='attacker/repo';
 d.jobs.test.steps=[step,{run:'npm test',env:{KEY:String.fromCharCode(36)+'{{ secrets.STEWARD_APP_PRIVATE_KEY }}'}}];
 if(kind==='trusted')expect(()=>assertWorkflowDocument('test.yml',d)).not.toThrow();else expect(()=>assertWorkflowDocument('test.yml',d)).toThrow('workflow_run checkout');
 });
 it.each(['sync-review-instructions.yml','sync-managed-labels.yml'])('protects deployed policy exception %s',async name=>{
 const path='.github/workflows/'+name;const d=YAML.parse(await readFile(path,'utf8'));expect(()=>assertWorkflowDocument(path,d)).not.toThrow();
 for(const kind of ['checkout','resolver','condition']){const changed=structuredClone(d);const j=Object.values(changed.jobs)[0] as any;
 if(kind==='checkout')j.steps.find((s:any)=>s.uses?.startsWith('actions/checkout')).with.ref='attacker';
 if(kind==='resolver')j.steps.find((s:any)=>s.id==='policy').run='echo policy_sha=attacker';
 if(kind==='condition')j.if='true';
 expect(()=>assertWorkflowDocument(path,changed)).toThrow('WORKFLOW_POLICY');}
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

describe('workflow argument boundaries',()=>{
 it.skipIf(process.platform==='win32')('passes dispatch and output values as literal Bash arguments',async()=>{
 const release=YAML.parse(await readFile('.github/workflows/release.yml','utf8'));
 const classification=YAML.parse(await readFile('.github/workflows/pr-classification.yml','utf8'));
 const payload='value"; printf INJECTED; # $(printf SUBSTITUTED)';
 for(const [step,scan] of [[classification.jobs.classify.steps.at(-1),'false'],[classification.jobs.classify.steps.at(-1),'true'],[release.jobs.preflight.steps.at(-1),'false'],[release.jobs.notes.steps.find((s:any)=>s.run?.includes('release-notes --')),'false']] as any[]){
 const run=step.run.replace(/\$\{\{[\s\S]*?\}\}/g,'safe');
 const env={...process.env};for(const k of Object.keys(step.env||{}))env[k]=payload;env.SCAN_ALL=scan;
 const result=spawnSync('bash',['-c','node(){ printf "%s\\0" "$@"; };\n'+run],{env,encoding:'utf8'});
 expect(result.status,result.stderr).toBe(0);const args=result.stdout.split('\0').filter(Boolean);expect(args).toContain(payload);expect(args).not.toContain('INJECTED');
 if(run.includes('pr-classification')){expect(args[args.indexOf('--scan-all')+1]).toBe(scan);expect(args.includes('--pull-request-number')).toBe(scan==='false');}
 }
 });
 it.skipIf(process.platform!=='win32')('passes build inputs as literal PowerShell arguments',async()=>{
 const d=YAML.parse(await readFile('.github/workflows/release.yml','utf8'));const step=d.jobs.build.steps.find((s:any)=>s.run?.includes('release-preflight'));
 const payload='value"; Write-Output INJECTED; # $(Write-Output SUBSTITUTED)';
 const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command','function node { ConvertTo-Json -InputObject @($args) -Compress }; '+step.run.replace(/\$\{\{[\s\S]*?\}\}/g,'safe')],{env:{...process.env,ARG_REPOSITORY_ID:payload,ARG_TARGET_SHA:payload},encoding:'utf8'});
 expect(result.status,result.stderr).toBe(0);const args=JSON.parse(result.stdout);expect(args[args.indexOf('--repository-id')+1]).toBe(payload);expect(args[args.indexOf('--target-sha')+1]).toBe(payload);
 });
});
