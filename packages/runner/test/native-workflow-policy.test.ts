import {it,expect} from 'vitest';
import {assertWorkflowDocument} from '../src/workflow-policy.js';
const sha='a'.repeat(40), uses=`splrad/steward/.github/workflows/product-build.yml@${sha}`;
const policy=[{uses,inputs:['targetSha'],secrets:[]}];
const document=()=>({on:{pull_request:{}},permissions:{contents:'read'},jobs:{build:{uses,with:{targetSha:'${{ github.sha }}'}}}});
it('accepts only explicitly adopted central reusable implementations',()=>{expect(()=>assertWorkflowDocument('build.yml',document(),1,policy)).not.toThrow();expect(()=>assertWorkflowDocument('build.yml',document(),1)).toThrow('untrusted reusable');});
it.each(['owner','sha','input','inherit','secret','permissions'])('rejects reusable capability escalation %s',kind=>{const d:any=document();const j=d.jobs.build;if(kind==='owner')j.uses=j.uses.replace('splrad','attacker');if(kind==='sha')j.uses=j.uses.replace(sha,'main');if(kind==='input')j.with.command='evil';if(kind==='inherit')j.secrets='inherit';if(kind==='secret')j.secrets={TOKEN:'${{ secrets.TOKEN }}'};if(kind==='permissions')j.permissions={contents:'write'};expect(()=>assertWorkflowDocument('build.yml',d,1,policy)).toThrow();});
