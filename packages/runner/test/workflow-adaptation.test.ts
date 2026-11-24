import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import YAML from 'yaml';
import {discoverWorkflowFiles} from '../src/workflow-tools.js';
it('discovers current native workflows and actual product templates without a workflow mirror',async()=>{
  const files=await discoverWorkflowFiles(process.cwd(),true);
  expect(files).toContain('.github/workflows/pr-validation-native.yml');
  expect(files).toContain('.github/workflows/governance-promotion.yml');
  expect(files).toContain('templates/release/steward-release-publish.yml');
  expect(files).not.toContain('.github/workflows/pr-validation.yml');
});
it('uses platform workflow provenance and readonly validation jobs',async()=>{
  const d=YAML.parse(await readFile('.github/workflows/pr-validation-native.yml','utf8'));
  for(const [id,job] of Object.entries(d.jobs) as [string,any][])for(const step of job.steps){
    if(step.with?.path==='policy'){expect(step.with.repository).toBe('${{ job.workflow_repository }}');expect(step.with.ref).toBe('${{ job.workflow_sha }}');}
    if(step.with?.path==='target'){expect(step.with.ref).toBe(id==='scope'
      ? '${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha || github.sha }}'
      : '${{ needs.scope.outputs.head }}');expect(step.with['fetch-depth']).toBe(0);}
    if(step.run)expect(step.run).not.toContain('${{');
  }
  expect(d.permissions).toEqual({contents:'read','pull-requests':'read'});
  expect(d.on.merge_group).toEqual({types:['checks_requested']});
  expect(d.jobs.summary.if).toBe('${{ always() && ('+d.jobs.scope.if+') }}');
});
it('requires product selections before building or claiming signing is inapplicable',async()=>{
  const workflow=YAML.parse(await readFile('templates/release/steward-release-publish.yml','utf8'));
  expect(workflow.jobs.build.strategy.matrix).toEqual({unit:"${{ fromJSON('[]') }}",target:"${{ fromJSON('[]') }}"});
  expect(workflow.jobs.build.steps.find((step:any)=>step.id==='build').run).toMatch(/^throw /);
  expect(workflow.jobs.sign.steps.find((step:any)=>step.id==='signing').run).toBe('exit 1');
});
it('activates the trusted policy tool paths before validation outside its checkout',async()=>{
  const d=YAML.parse(await readFile('.github/workflows/pr-validation-native.yml','utf8'));
  for(const job of Object.values(d.jobs) as any[]){
    const installed=job.steps.findIndex((s:any)=>s.uses?.startsWith('jdx/mise-action@'));
    if(installed<0)continue;
    const activated=job.steps.findIndex((s:any)=>s.run==='mise bin-paths | tac >> "$GITHUB_PATH"');
    expect(activated).toBeGreaterThan(installed);
    expect(job.steps[activated]).toMatchObject({'working-directory':'policy',shell:'bash',env:{MISE_SAFE:'1',MISE_LOCKED:'1',MISE_NODE_COMPILE:'false'}});
    expect(job.steps[installed].with.env).toBe(false);
    const execution=job.steps.findIndex((s:any)=>/^(?:npm|node)\b/m.test(s.run??''));
    expect(activated).toBeLessThan(execution);
  }
});

it('binds WinGet execution to the controller tool before channel credentials are present',async()=>{
  const d=YAML.parse(await readFile('templates/release/steward-release-channels.yml','utf8'));
  for(const name of ['winget-submit','winget-verify']) {
    const steps=d.jobs[name].steps;
    const install=steps.findIndex((s:any)=>s.uses?.startsWith('jdx/mise-action@'));
    const resolve=steps.findIndex((s:any)=>s.id==='winget-tool');
    const business=steps.findIndex((s:any)=>s.name==='business-'+name);
    expect(steps[install].with).toMatchObject({working_directory:'controller',install_args:'--locked',env:false,persist_github_token:false});
    expect(resolve).toBeGreaterThan(install);expect(business).toBeGreaterThan(resolve);
    expect(steps[resolve].env).toBeUndefined();
    expect(steps[resolve].run).toContain('mise -C controller which wingetcreate');
    expect(steps[resolve].run).toContain('"exe=$exe" >> $env:GITHUB_OUTPUT');
    expect(steps[business].env.WINGETCREATE_EXE).toBe('${{ steps.winget-tool.outputs.exe }}');
    expect(steps[business].run).toContain('& $env:WINGETCREATE_EXE update SPLRAD.LayerScape.Deployer --version $version --urls "$url|x64" --out generated --format yaml');
    expect(steps[business].run).not.toMatch(/\bmise\b/);
    expect(steps.filter((s:any)=>s.run).map((s:any)=>s.run).join('\n')).not.toMatch(/mise -C product/);
  }
});
it('verifies exact and default WinGet downloads without executing the installer',async()=>{
  const workflow=YAML.parse(await readFile('templates/release/steward-release-channels.yml','utf8'));
  for(const job of ['winget-submit','winget-verify']){
    const script=workflow.jobs[job].steps.find((s:any)=>s.name==='business-'+job).run;
    expect(script).toContain('Invoke-WebRequest -Uri $urls[0] -OutFile');
    expect(script).toContain("foreach ($selection in @('exact','default'))");
    expect(script).toContain('WINGET_DOWNLOAD_BYTES');
    expect(script).not.toMatch(/winget uninstall|@\('install'|WINGET_INSTALLED_BYTES/);
  }
});
