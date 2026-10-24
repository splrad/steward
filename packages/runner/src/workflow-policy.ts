import { hasTrustedPolicyPrefix, assertArtifactHandoff } from './workflow-capabilities.js';
import { assertNativeWorkflow, assertProductReleaseCaller } from './native-workflow-contract.js';
import YAML from 'yaml';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const hostedRunners = new Set(['ubuntu-latest', 'ubuntu-24.04', 'windows-latest', 'windows-2025', 'macos-latest']);
const actions = new Set([
 'amannn/action-semantic-pull-request@48f256284bd46cdaab1048c3721360e808335d50',
 'renovatebot/github-action@a63d9a7bc606f7336fd20b47f2f32259a35e6213',
 'actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510',
 'googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
 'peter-evans/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1',
 'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6',
 'jdx/mise-action@8418fedb1110381a0d3ba51a7a415d7c1b884550',
 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
 'actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68', 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
 'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333',
]);
const secretEnvironments: Record<string, readonly string[]> = {
 'steward-automation': ['STEWARD_APP_PRIVATE_KEY', 'COPILOT_CLI_TOKEN'],
 'steward-release': ['STEWARD_APP_PRIVATE_KEY', 'GENERATION_TICKET_KEY'], 'steward-release-notes': ['COPILOT_GITHUB_TOKEN', 'GENERATION_TICKET_KEY'],
 'steward-deployment': ['CLOUDFLARE_API_TOKEN', 'STEWARD_APP_PRIVATE_KEY'],
};
const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (detail: string): never => { throw new Error(`WORKFLOW_POLICY: ${detail}`); };
// Shared business resources are selected by the trusted policy, never candidate files.
const sharedQueues: Record<string,string> = {
 '.github/workflows/native-review.yml': 'pr-body',
 '.github/workflows/onboard-repository.yml': 'pr-body',
 '.github/workflows/sync-review-instructions.yml:synchronize': 'pr-body',
};
export interface ReusableWorkflow { uses: string; inputs: readonly string[]; secrets: readonly string[] }
// Populated only when B4 adopts a reviewed central implementation.
const approvedReusableWorkflows: readonly ReusableWorkflow[] = [];
function concurrency(value:any, trustedQueue=false) {
 if(value===undefined)return;
 if(!object(value) || value['cancel-in-progress']!==false)fail('ordinary concurrency must explicitly disable cancellation');
 if(!trustedQueue && (typeof value.group!=='string' || !value.group.startsWith('workflow-policy:${{ github.workflow_ref }}:')))fail('ordinary concurrency requires isolated workflow-ref namespace');
}
function shell(value: any) {
 if(value!==undefined && !['bash','sh','pwsh','powershell','cmd','python'].includes(value)) fail('shell must be a static approved value');
}
function defaults(value: any) {
 if(value===undefined)return;
 if(!object(value) || !object(value.run))fail('invalid run defaults');
 shell(value.run.shell);
}
function permissions(p: any) {
 if (!object(p) || Object.entries(p).some(([key,v]) => !['contents','actions','checks','pull-requests','security-events','packages','statuses'].includes(key) || !['read','none'].includes(v))) fail('permissions must be explicit read/none');
}
function secrets(value: any): string[] {
 const text=JSON.stringify(value); const names: string[]=[];
 // Only literal secret references are allowed; indexing and passing the entire context are rejected.
 for (const expression of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
  const body=expression[1]!;
  if (/\bsecrets\b/i.test(body)) {
   const match=/^\s*secrets\.([A-Z_][A-Z_0-9]*)\s*$/.exec(body);
   if (!match) fail('dynamic secret reference'); names.push(match![1]!);
  }
 }
 return names;
}
export function assertWorkflowDocument(path: string, d: any, repositoryId = 1296724484, reusable: readonly ReusableWorkflow[] = approvedReusableWorkflows, releasePolicyShas: readonly string[] = []) {
 if (path === '.github/workflows/steward-release-publish.yml' && releasePolicyShas.length) {
  const trusted = releasePolicyShas.find(sha => d?.jobs?.publish?.uses === `splrad/steward/.github/workflows/product-release.yml@${sha}`);
  if (!trusted) fail('product caller contract: untrusted policy');
  assertProductReleaseCaller(d, trusted!);
  return;
 }
 const native = assertNativeWorkflow(path, d, repositoryId);
 if (!object(d) || !object(d.jobs) || !Object.keys(d.jobs).length) fail(`${path}: jobs missing`);
 assertArtifactHandoff(d);
 permissions(d.permissions);
 defaults(d.defaults);
 const resource = repositoryId === 1296724484 ? sharedQueues[path] : undefined;
 if (resource !== undefined) {
  if (!object(d.concurrency) || d.concurrency.group !== `workflow-resource:${repositoryId}:${resource}` || d.concurrency['cancel-in-progress'] !== false)
   fail('shared resource queue must match trusted namespace and disable cancellation');
 } else if (!native && path !== '.github/workflows/pr-validation.yml') concurrency(d.concurrency);
 const triggers=typeof d.on==='string'?[d.on]:Array.isArray(d.on)?d.on:object(d.on)?Object.keys(d.on):[];
 if (!triggers.length || triggers.some((v:any)=>![...(native ? ['workflow_call'] : []),'push','pull_request','workflow_dispatch','workflow_run','schedule'].includes(v))) fail(`${path}: trigger not permitted`);
 const global={...d};delete global.jobs;
 if (secrets(global).length) fail(`${path}: workflow-level secrets`);
 for (const [name,j] of Object.entries(d.jobs) as [string,any][]) {
  const deployedPolicyContract = hasTrustedPolicyPrefix(d,j);
  if (!object(j)) fail(`${path}:${name}: invalid job`);
  if (j.uses !== undefined) {
   const approved = reusable.find(value => value.uses === j.uses);
   if (!/^splrad\/steward\/\.github\/workflows\/[a-z0-9-]+\.ya?ml@[a-f0-9]{40}$/.test(j.uses) || !approved) fail('untrusted reusable workflow');
   if (!object(j.with ?? {}) || Object.keys(j.with ?? {}).some(key => !approved!.inputs.includes(key))) fail('unapproved reusable input');
   if (!object(j.secrets ?? {}) || Object.keys(j.secrets ?? {}).some(key => !approved!.secrets.includes(key))) fail('unapproved reusable secrets');
   if (secrets(j).length || Object.keys(j.secrets ?? {}).length) fail('reusable validation cannot receive secrets');
   if (j.permissions !== undefined) permissions(j.permissions);
   if (j.environment !== undefined || j.steps !== undefined) fail('reusable capability override');
   continue;
  }
  if (j.secrets || !Array.isArray(j.steps) || !j.steps.length) fail(`${path}:${name}: missing steps`);
  if (j.container!==undefined || j.services!==undefined) fail('job/service containers not permitted');
  defaults(j.defaults);
  const jobResource=repositoryId === 1296724484 ? sharedQueues[path+':'+name] : undefined;
  if(jobResource!==undefined && (!object(j.concurrency) || j.concurrency.group!==`workflow-resource:${repositoryId}:${jobResource}` || j.concurrency['cancel-in-progress']!==false))fail('job shared resource queue mismatch');
  if (!native) concurrency(j.concurrency,jobResource!==undefined);
  if (j.permissions!==undefined && !native) permissions(j.permissions);
  const used=secrets(j); const env=j.environment;
  if (env!==undefined && (!object(env) || !Object.hasOwn(secretEnvironments,env.name) || env.deployment!==(env.name==='steward-deployment'))) fail(`${path}:${name}: protected environment`);
  if ((used.length || env!==undefined) && triggers.includes('pull_request')) fail(`${path}:${name}: PR jobs cannot use protected environments/secrets`);
  if (used.some(s=>!secretEnvironments[env?.name]?.includes(s))) fail(`${path}:${name}: secret/environment mismatch`);
  if (typeof j['runs-on']!=='string' || !hostedRunners.has(j['runs-on'])) fail(`${path}:${name}: runner not permitted`);
  for(const step of j.steps) {
   shell(step?.shell);
   if (!object(step)) fail(`${path}: invalid step`);
   if (step.uses!==undefined && !actions.has(step.uses)) fail(`${path}: unapproved/unpinned action`);
   if (triggers.includes('workflow_run') && (used.length || env!==undefined) && step.uses?.startsWith('actions/checkout@')) {
    if(!deployedPolicyContract && (step.with?.ref!=='${{ github.workflow_sha }}' || (step.with?.repository!==undefined && step.with.repository!=='${{ github.repository }}')))fail('privileged workflow_run checkout must use own workflow SHA');
   }
   if (triggers.includes('workflow_run') && (used.length || env!==undefined) && step.uses?.startsWith('actions/download-artifact@')) fail('privileged workflow_run artifact download not permitted');
   if (step.uses?.startsWith('actions/checkout@') && step.with?.['persist-credentials']!==false) fail(`${path}: checkout credentials must not persist`);
   if (typeof step.run==='string') for (const expression of step.run.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    const body=expression[1]!.trim();
    // The gate uses this boolean only. Other event data must pass through env,
    // including indexed/case-insensitive access and serialization of the context.
    if (!/^(?:github\.(?:sha|repository_id|run_id|run_attempt|actor_id)|github\.event\.repository\.private|runner\.temp)$/i.test(body)
      && body!=="github.actor_id == '301115370' && 'app' || 'manual'") fail(`${path}: untrusted event or indirect context interpolated into shell`);
   }
  }
 }
}
/** All workflow documents are data. The executing verifier comes from the pinned central checkout. */
export async function verifyWorkflowPolicy(workspace:string, repositoryId:number, requiredPaths:readonly string[], releasePolicyShas:readonly string[] = []) {
 const directory=join(workspace,'.github/workflows'); let files:string[]=[];
 try { if(!(await lstat(join(workspace,'.github'))).isDirectory() || !(await lstat(directory)).isDirectory()) fail('workflow directory type'); files=await readdir(directory); }
 catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const paths=files.filter(f=>/\.ya?ml$/.test(f)).map(f=>`.github/workflows/${f}`).sort();
 for(const required of requiredPaths) if(!paths.includes(required)) fail(`missing required entry ${required}`);
 for(const path of paths) {
  const info=await lstat(join(workspace,path));
  if(!info.isFile() || info.isSymbolicLink()) fail('workflow must be regular file');
  const parsed=YAML.parseDocument(await readFile(join(workspace,path),'utf8'),{uniqueKeys:true});
  if(parsed.errors.length) fail('invalid YAML');
  assertWorkflowDocument(path,parsed.toJS({maxAliasCount:0}),repositoryId,approvedReusableWorkflows,releasePolicyShas);
 }
 return paths;
}
