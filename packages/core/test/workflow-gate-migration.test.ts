import {it,expect} from 'vitest';
import {planWorkflowGateMigration} from '../src/workflow-gate-migration.js';
const current=()=>({enforcement:'active',bypass_actors:[],conditions:{ref_name:{include:['~DEFAULT_BRANCH']}},rules:[
 {type:'deletion'},{type:'non_fast_forward'},{type:'pull_request',parameters:{required_approving_review_count:1}},
 {type:'workflows',parameters:{workflows:[{repository_id:99,path:'.github/workflows/validate.yml',ref:'refs/heads/main'}]}},
 {type:'required_status_checks',parameters:{strict_required_status_checks_policy:true,required_status_checks:[{context:'Classification',integration_id:5}]}}
]});
const input={repositoryId:99,workflowPath:'.github/workflows/validate.yml',evaluatorSha:'a'.repeat(40),gateName:'Validation',appId:5};
it('pins the reviewed evaluator and adds the owned gate without disabling any existing requirement',()=>{
 const original=current(), proposal=planWorkflowGateMigration(original,input);
 expect(original).toEqual(current());
 expect(proposal.before).toEqual(original);
 expect(proposal.after.rules.slice(0,3)).toEqual(original.rules.slice(0,3));
 expect(proposal.after.conditions).toEqual(original.conditions);
 expect(proposal.after.rules[3].parameters.workflows[0]).toEqual({repository_id:99,path:input.workflowPath,sha:input.evaluatorSha});
 expect(proposal.after.rules[4].parameters.required_status_checks).toEqual([{context:'Classification',integration_id:5},{context:'Validation',integration_id:5}]);
 expect(planWorkflowGateMigration(proposal.after,input).after).toEqual(proposal.after);
});
it('rejects weakened sources and mutable evaluator identities',()=>{
 expect(()=>planWorkflowGateMigration({...current(),enforcement:'disabled'},input)).toThrow();
 expect(()=>planWorkflowGateMigration({...current(),bypass_actors:[{actor_id:1}]},input)).toThrow();
 expect(()=>planWorkflowGateMigration(current(),{...input,evaluatorSha:'main'})).toThrow();
 expect(()=>planWorkflowGateMigration(current(),{...input,repositoryId:100})).toThrow();
});
