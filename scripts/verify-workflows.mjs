import {discoverWorkflowFiles,scanWorkflows} from '../packages/runner/dist/index.js';
try { console.log(JSON.stringify(await scanWorkflows(process.cwd(),await discoverWorkflowFiles(process.cwd(),true)),null,2)); }
catch(error){console.error(error.message);process.exitCode=1;}
