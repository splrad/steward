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
it('does not treat action commit normalization as permission to change workflow semantics',async()=>{
  const {workflowDigest}=await script();
  const value='permissions: {contents: read}\njobs: {check: {steps: [{uses: actions/checkout@'+ 'a'.repeat(40)+'}]}}';
  expect(workflowDigest(value)).not.toBe(workflowDigest(value.replace('contents: read','contents: write')));
  expect(()=>workflowDigest(value.replace('a'.repeat(40),'main'))).toThrow();
});
