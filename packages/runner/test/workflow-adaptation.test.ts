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
  for(const job of Object.values(d.jobs) as any[])for(const step of job.steps){
    if(step.with?.path==='policy'){expect(step.with.repository).toBe('${{ job.workflow_repository }}');expect(step.with.ref).toBe('${{ job.workflow_sha }}');}
    if(step.with?.path==='target'){expect(step.with.ref).toBe('${{ github.event.pull_request.head.sha || github.sha }}');expect(step.with['fetch-depth']).toBe(0);}
    if(step.run)expect(step.run).not.toContain('${{');
  }
  expect(d.permissions).toEqual({contents:'read','pull-requests':'read'});
  expect(d.jobs.summary.if).toBe('${{ always() }}');
});
it('executes product commands from native YAML',async()=>{
  const d=YAML.parse(await readFile('templates/release/steward-release-publish.yml','utf8')),step=d.jobs.build.steps.find((s:any)=>s.id==='build');
  expect(step.run).toContain('dotnet restore CADFontAutoReplace.slnx --locked-mode');
  expect(step.run).toContain('pwsh -NoProfile -File ./tools/Publish-ReleaseAssets.ps1');
  expect(step.run).not.toMatch(/\$\{\{|SkipPluginBuild|release-pipeline build/);expect(step.env).toBeUndefined();
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
