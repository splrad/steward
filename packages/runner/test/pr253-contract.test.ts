import { readFile } from 'node:fs/promises';
import {it,expect} from 'vitest';
import YAML from 'yaml';
import fixture from './fixtures/pr253-workflows.json' with {type:'json'};
import {assertWorkflowDocument} from '../src/workflow-policy.js';
import type {WorkflowContract} from '../../core/src/workflow-contract.js';
const approved:WorkflowContract={version:1,repositoryId:1296724484,fragments:'retired',sharedQueues:{}};
function document(name:string):any {
 return YAML.parse((fixture.workflows as Record<string,string>)[`.github/workflows/${name}`]!);
}
function isolateQueues(d:any) {
 if(d.concurrency)d.concurrency={group:'workflow-policy:${{ github.workflow_ref }}:build','cancel-in-progress':false};
 return d;
}
it('uses an immutable real PR snapshot, not current workspace assumptions',()=>{
 expect(fixture.head).toBe('ab3cddd7727917284084899397f161c3d31a0161');
 expect(Object.keys(fixture.workflows)).toHaveLength(11);
});
it('requires the catalog-based entry and allows retirement only with authority',async()=>{
 expect(()=>assertWorkflowDocument('.github/workflows/pr-validation.yml',document('pr-validation.yml'),approved)).toThrow('required trusted validation entry changed');
 const d=YAML.parse(await readFile('.github/workflows/pr-validation.yml','utf8'));
 expect(()=>assertWorkflowDocument('.github/workflows/pr-validation.yml',d)).toThrow('fragments');
 expect(()=>assertWorkflowDocument('.github/workflows/pr-validation.yml',d,approved)).not.toThrow();
});
it.each(['release-build.yml','product-build.yml'])('tests static job splitting for %s without granting arbitrary runner outputs',name=>{
 const d=isolateQueues(document(name));
 expect(()=>assertWorkflowDocument('.github/workflows/'+name,d,approved)).toThrow('runner');
 const build=d.jobs.build;
 delete d.jobs.build;
 for(const [key,runner] of [['windows','windows-2025'],['linux','ubuntu-24.04']]){
  d.jobs['build_'+key]={...structuredClone(build),'runs-on':runner,if:`needs.plan.outputs.runner == '${runner}'`};
 }
 expect(()=>assertWorkflowDocument('.github/workflows/'+name,d,approved)).not.toThrow();
 d.jobs.build_linux['runs-on']='self-hosted';
 expect(()=>assertWorkflowDocument('.github/workflows/'+name,d,approved)).toThrow('runner');
});
it('does not turn approval into permission to download build artifacts with application credentials',()=>{
 const d=isolateQueues(document('release-build-complete.yml'));
 expect(()=>assertWorkflowDocument('.github/workflows/release-build-complete.yml',d,approved)).toThrow('isolated artifact handoff');
});
it.each(['sync-managed-labels.yml','sync-review-instructions.yml'])('does not silently authorize changed deployed-code resolution: %s',name=>{
 const d=isolateQueues(document(name));
 expect(()=>assertWorkflowDocument('.github/workflows/'+name,d,approved)).toThrow('checkout must use own workflow SHA');
});
