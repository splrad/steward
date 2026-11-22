import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import YAML from 'yaml';
import {verify as verifySecurityPolicy, securityPolicyController} from './security-policy.mjs';
import {validationController,validationFileInputs,git,regular} from './validation-input.mjs';
import {verifyLayerScapeControllerPins} from './controller-pin-policy.mjs';
import {assertRepositoryInstructions,discoverWorkflowFiles,scanWorkflows} from '../packages/runner/dist/index.js';
export async function main(env=process.env,resolveController=validationController) {
  const workspace=resolve(env.VALIDATION_WORKSPACE??'target');
  const {input,files}=await validationFileInputs(workspace,env);
  git(workspace,['-c','core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol','diff','--check',input.base,input.head]);
  for(const path of files.filter(p=>/\.(?:json|ya?ml)$/.test(p))){
    const text=await readFile(await regular(workspace,path),'utf8');
    if(path.endsWith('.json'))JSON.parse(text);else YAML.parse(text);
  }
  const legacy=JSON.parse(await readFile(new URL('../config/review/legacy-instructions.json',import.meta.url),'utf8'));
  await assertRepositoryInstructions(workspace,await readFile(new URL('../templates/repository/AGENTS.md',import.meta.url)),
    {repositoryId:input.repositoryId,legacy,templateSource:env.GITHUB_REPOSITORY===env.WORKFLOW_REPOSITORY,head:input.head});
  const promotedController=resolveController(securityPolicyController,input.workflowSha);
  verifyLayerScapeControllerPins(workspace,input,securityPolicyController,promotedController);
  verifySecurityPolicy(workspace,input.base,input.head,securityPolicyController,promotedController,
    env.GITHUB_HEAD_REF === 'steward/managed-sync',env.GITHUB_REPOSITORY === env.WORKFLOW_REPOSITORY);
  console.log(JSON.stringify(await scanWorkflows(workspace,await discoverWorkflowFiles(workspace,true),undefined,input.repositoryId),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
