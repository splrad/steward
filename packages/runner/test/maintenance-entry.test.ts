import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import YAML from 'yaml';

it('retires only later maintenance validation and keeps legacy recovery dispatch entrypoints',async()=>{
  const value=YAML.parse(await readFile('.github/workflows/pr-validation.yml','utf8'));
  expect(value.jobs.validate.if).toBe("github.event.pull_request.base.ref != 'maintenance/legacy-runtime-e990eda' || github.event.pull_request.number == 307");
  const step=value.jobs.validate.steps.at(-1);
  expect(step.run).not.toContain('${{');
  expect(step.env.VALIDATION_PROFILE).toBe('${{ steps.profile.outputs.name }}');
  for(const name of ['release-build-complete.yml','sync-managed-labels.yml','sync-review-instructions.yml']){
    const d=YAML.parse(await readFile('.github/workflows/'+name,'utf8'));
    expect(d.on.workflow_run).toBeUndefined();expect(d.on.workflow_dispatch).toBeDefined();
  }
});
