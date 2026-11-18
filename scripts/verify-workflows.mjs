import {discoverWorkflowFiles,scanWorkflows} from '../packages/runner/dist/index.js';
// Ordinary local scans have no native target identity. The shared enforcement entry binds its own verified event.
const repositoryId=process.env.GITHUB_ACTIONS==='true' && process.env.GITHUB_REPOSITORY==='splrad/steward'
  ?Number(process.env.GITHUB_REPOSITORY_ID):undefined;
try { console.log(JSON.stringify(await scanWorkflows(process.cwd(),await discoverWorkflowFiles(process.cwd(),true),undefined,repositoryId),null,2)); }
catch(error){console.error(error.message);process.exitCode=1;}
