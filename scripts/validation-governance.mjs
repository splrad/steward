import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import YAML from 'yaml';
import {validationInput,git,regular} from './validation-input.mjs';
import {assertRepositoryInstructions,discoverWorkflowFiles,scanWorkflows} from '../packages/runner/dist/index.js';
const workspace=resolve(process.env.VALIDATION_WORKSPACE??'target');
try {
const {input,files}=await validationInput(workspace);
  git(workspace,['-c','core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol','diff','--check',input.base,input.head]);
  for(const path of files.filter(p=>/\.(?:json|ya?ml)$/.test(p))){
    const text=await readFile(await regular(workspace,path),'utf8');
    if(path.endsWith('.json'))JSON.parse(text);else YAML.parse(text);
  }
  const legacy=JSON.parse(await readFile(new URL('../config/review/legacy-instructions.json',import.meta.url),'utf8'));
  await assertRepositoryInstructions(workspace,await readFile(new URL('../templates/repository/AGENTS.md',import.meta.url)),
    {repositoryId:input.repositoryId,legacy,templateSource:process.env.GITHUB_REPOSITORY===process.env.WORKFLOW_REPOSITORY});
  console.log(JSON.stringify(await scanWorkflows(workspace,await discoverWorkflowFiles(workspace,true)),null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
