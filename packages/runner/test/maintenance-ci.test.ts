import {expect,it} from 'vitest';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import YAML from 'yaml';

const script=()=>import(pathToFileURL(resolve('scripts/maintenance-ci.mjs')).href);
it('keeps the trusted maintenance workflow separate from candidate execution',async()=>{
  const workflow=YAML.parse(await readFile('.github/workflows/maintenance-validation.yml','utf8'));
  expect(workflow.permissions).toEqual({contents:'read','pull-requests':'read'});
  expect(Object.keys(workflow.on)).toEqual(['pull_request']);
  expect(workflow.jobs.final.needs).toEqual(['source','test','dependency']);
  for(const job of Object.values(workflow.jobs) as any[])expect(job.environment).toBeUndefined();
  expect(JSON.stringify(workflow.jobs.test)).not.toMatch(/MAINTENANCE_READ_TOKEN|GH_TOKEN|GITHUB_TOKEN|policy\/scripts/);
  const {verifyResults}=await script();
  for(const result of ['failure','skipped','cancelled',undefined])expect(()=>verifyResults({source:{result:'success'},test:{result},dependency:{result:'success'}})).toThrow();
});
it('scans ordinary maintenance workflow changes with policy tools and ignores candidate bypass configuration',async()=>{
  const {mkdtemp,mkdir,writeFile,rename,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=await mkdtemp(join(tmpdir(),'maintenance-native-'));
  const policy=resolve(process.env.STEWARD_TEST_TOOLCHAIN_ROOT??'.');
  const {scanMaintenanceWorkflows}=await script();
  const clean='name: Test\non: pull_request\npermissions: {contents: read}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy: {matrix: {part: [a, b]}}\n    steps:\n      - run: echo safe\n';
  try {
    await mkdir(join(root,'.github/workflows'),{recursive:true});
    await writeFile(join(root,'.npmrc'),'script-shell=/bin/true\n');
    await writeFile(join(root,'mise.toml'),'[env]\nTOKEN="candidate"\n');
    await writeFile(join(root,'.github/workflows/old.yml'),clean);
    await scanMaintenanceWorkflows(root,policy);
    await rename(join(root,'.github/workflows/old.yml'),join(root,'.github/workflows/renamed.yml'));
    await writeFile(join(root,'.github/workflows/additional.yml'),clean.replace('echo safe','echo updated'));
    const action=clean.replace('      - run: echo safe','      - uses: actions/checkout@'+'a'.repeat(40)+'\n        with: {persist-credentials: false}\n      - run: echo safe');
    await writeFile(join(root,'.github/workflows/additional.yml'),action);
    await scanMaintenanceWorkflows(root,policy);
    await writeFile(join(root,'.github/workflows/additional.yml'),action.replace('a'.repeat(40),'b'.repeat(40)));
    const changed=await scanMaintenanceWorkflows(root,policy);
    expect(changed.files).toEqual(['.github/workflows/additional.yml','.github/workflows/renamed.yml']);
    await writeFile(join(root,'.github/workflows/additional.yml'),clean.replace('runs-on: ubuntu-latest','needs: absent\n    runs-on: ubuntu-latest'));
    await expect(scanMaintenanceWorkflows(root,policy)).rejects.toThrow();
    await writeFile(join(root,'.github/workflows/additional.yml'),clean.replace('echo safe','echo "${{ github.event.pull_request.title }}" # zizmor: ignore[template-injection]'));
    await expect(scanMaintenanceWorkflows(root,policy)).rejects.toThrow();
  } finally {await rm(root,{recursive:true,force:true});}
},120000);
