// Local convenience entry. The required workflow invokes the trusted policy directly.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.STEWARD_WORKFLOW_POLICY_ROOT;
if (!root) throw new Error('Set STEWARD_WORKFLOW_POLICY_ROOT to the adopted central policy checkout with its locked tools installed');
const policy=resolve(root);
const {discoverWorkflowFiles,scanWorkflows}=await import(pathToFileURL(resolve(policy,'packages/runner/dist/index.js')).href);
const workspace=process.cwd();
try {console.log(JSON.stringify(await scanWorkflows(workspace,await discoverWorkflowFiles(workspace,true),policy),null,2));}
catch(error){console.error(error.message);process.exitCode=1;}
