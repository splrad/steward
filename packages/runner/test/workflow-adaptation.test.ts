import {it,expect} from 'vitest';
import {readdir} from 'node:fs/promises';
import {verifyWorkflowPolicy} from '../src/workflow-policy.js';
it('validates all current workflows under trusted capability contracts',async()=>{
  expect(await verifyWorkflowPolicy(process.cwd(),1296724484,['.github/workflows/pr-validation.yml'])).toHaveLength((await readdir('.github/workflows')).filter(file=>/\.ya?ml$/.test(file)).length);
});
it('keeps all three retired completion callbacks absent',async()=>{
  const files=await readdir('.github/workflows');
  for(const file of ['release-build-complete.yml','sync-review-instructions.yml','sync-managed-labels.yml'])expect(files).not.toContain(file);
});
