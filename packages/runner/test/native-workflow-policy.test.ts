import {it,expect} from 'vitest';
import {assertWorkflowDocument} from '../src/workflow-policy.js';
import {verifyWorkflowPolicy} from '../src/workflow-policy.js';
import {readFile, mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import YAML from 'yaml';
const sha='a'.repeat(40), uses=`splrad/steward/.github/workflows/product-build.yml@${sha}`;
const policy=[{uses,inputs:['targetSha'],secrets:[]}];
const document=()=>({on:{pull_request:{}},permissions:{contents:'read'},jobs:{build:{uses,with:{targetSha:'${{ github.sha }}'}}}});
it('accepts only explicitly adopted central reusable implementations',()=>{expect(()=>assertWorkflowDocument('build.yml',document(),1,policy)).not.toThrow();expect(()=>assertWorkflowDocument('build.yml',document(),1)).toThrow('untrusted reusable');});
it.each(['owner','sha','input','inherit','secret','permissions'])('rejects reusable capability escalation %s',kind=>{const d:any=document();const j=d.jobs.build;if(kind==='owner')j.uses=j.uses.replace('splrad','attacker');if(kind==='sha')j.uses=j.uses.replace(sha,'main');if(kind==='input')j.with.command='evil';if(kind==='inherit')j.secrets='inherit';if(kind==='secret')j.secrets={TOKEN:'${{ secrets.TOKEN }}'};if(kind==='permissions')j.permissions={contents:'write'};expect(()=>assertWorkflowDocument('build.yml',d,1,policy)).toThrow();});
it('validates both delivered product workflows through the target directory verifier', async () => {
 const root=await mkdtemp(join(tmpdir(),'product-workflows-'));
 try {
  await mkdir(join(root,'.github/workflows'),{recursive:true});
  for(const name of ['steward-release-publish.yml','steward-pr-title.yml']) {
   const text=await readFile('templates/release/'+name,'utf8');
   await writeFile(join(root,'.github/workflows',name),text.replace(/product-release\.yml@[a-f0-9]{40}/,`product-release.yml@${sha}`));
  }
  expect(await verifyWorkflowPolicy(root,1187527897,[],[sha])).toHaveLength(2);
  expect(await verifyWorkflowPolicy(root,1187527897,[],['b'.repeat(40),sha])).toHaveLength(2);
  await expect(verifyWorkflowPolicy(root,1187527897,[])).rejects.toThrow();
  await expect(verifyWorkflowPolicy(root,1187527897,[],['b'.repeat(40)])).rejects.toThrow('caller contract');
 } finally {await rm(root,{recursive:true,force:true});}
});
it.each(['sha','owner','input','mapping','secret','permission','job-permission','extra-job','steps','trigger','path'])('rejects product caller escalation: %s',async kind=>{
 const d=YAML.parse((await readFile('templates/release/steward-release-publish.yml','utf8')).replace(/product-release\.yml@[a-f0-9]{40}/,`product-release.yml@${sha}`));
 const j=d.jobs.publish;
 if(kind==='sha')j.uses=j.uses.replace(sha,'b'.repeat(40));
 if(kind==='owner')j.uses=j.uses.replace('splrad','attacker');
 if(kind==='input')d.on.workflow_dispatch.inputs.command={type:'string',required:true};
 if(kind==='mapping')j.with.tag='${{ github.ref }}';
 if(kind==='secret')j.secrets='inherit';
 if(kind==='permission')d.permissions.packages='write';
 if(kind==='job-permission')j.permissions={'id-token':'write'};
 if(kind==='extra-job')d.jobs.extra={...j};
 if(kind==='steps')j.steps=[{run:'echo unexpected'}];
 if(kind==='trigger')d.on.pull_request={};
 expect(()=>assertWorkflowDocument(kind==='path'?'other.yml':'.github/workflows/steward-release-publish.yml',d,1187527897,[],[sha])).toThrow();
});
