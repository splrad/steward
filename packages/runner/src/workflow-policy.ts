import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const hostedRunners = new Set(['ubuntu-latest', 'ubuntu-24.04', 'windows-latest', 'windows-2025', 'macos-latest']);
// Existing deployed-policy resolvers are allowed only as complete trusted documents.
const deployedPolicyWorkflows: Record<string,string> = {
  ".github/workflows/sync-review-instructions.yml": "50652cb445e0abf37d0e1adb3e95e35a8d6b4cd4f96ff6a774e8cf2da97a7ed7",
  ".github/workflows/sync-managed-labels.yml": "7be23eb192bb3dee4d1c4ca6205778ec1ae346758f4edaecca7c78d843c9dc64"
};
const actions = new Set([
 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
 'actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68', 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
]);
const secretEnvironments: Record<string, readonly string[]> = {
 'steward-automation': ['STEWARD_APP_PRIVATE_KEY', 'COPILOT_CLI_TOKEN'],
 'steward-release': ['STEWARD_APP_PRIVATE_KEY'], 'steward-release-notes': ['COPILOT_GITHUB_TOKEN'],
 'steward-deployment': ['CLOUDFLARE_API_TOKEN', 'STEWARD_APP_PRIVATE_KEY'],
};
const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (detail: string): never => { throw new Error(`WORKFLOW_POLICY: ${detail}`); };
function concurrency(value:any) {
 if(value===undefined)return;
 if(!object(value) || value['cancel-in-progress']!==false)fail('ordinary concurrency must explicitly disable cancellation');
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
export function assertWorkflowDocument(path: string, d: any) {
 if (!object(d) || !object(d.jobs) || !Object.keys(d.jobs).length) fail(`${path}: jobs missing`);
 permissions(d.permissions);
 defaults(d.defaults);
 if(path==='.github/workflows/pr-validation.yml')assertRequiredValidation(d);
 else concurrency(d.concurrency);
 const triggers=typeof d.on==='string'?[d.on]:Array.isArray(d.on)?d.on:object(d.on)?Object.keys(d.on):[];
 if (!triggers.length || triggers.some((v:any)=>!['push','pull_request','workflow_dispatch','workflow_run','schedule'].includes(v))) fail(`${path}: trigger not permitted`);
 const deployedPolicyContract = Object.hasOwn(deployedPolicyWorkflows,path) && createHash('sha256').update(canonical(d)).digest('hex')===deployedPolicyWorkflows[path];
 const global={...d};delete global.jobs;
 if (secrets(global).length) fail(`${path}: workflow-level secrets`);
 for (const [name,j] of Object.entries(d.jobs) as [string,any][]) {
  if (!object(j) || j.uses || j.secrets || !Array.isArray(j.steps) || !j.steps.length) fail(`${path}:${name}: reusable jobs or missing steps`);
  if (j.container!==undefined || j.services!==undefined) fail('job/service containers not permitted');
  defaults(j.defaults);
  concurrency(j.concurrency);
  if (j.permissions!==undefined) permissions(j.permissions);
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
    if (/\bgithub\b/i.test(body) && !/^(?:github\.(?:sha|repository_id|run_id|run_attempt|actor_id)|github\.event\.repository\.private)$/i.test(body)
      && body!=="github.actor_id == '301115370' && 'app' || 'manual'") fail(`${path}: untrusted event interpolated into shell`);
   }
  }
 }
}
// This contract protects only the trusted gate entry, not the ordinary workflow inventory.
const requiredValidationJob = {
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 20,
  "outputs": {
    "policy": "${{ steps.policy.outputs.sha }}",
    "profile": "${{ steps.profile.outputs.name }}"
  },
  "steps": [
    {
      "id": "policy",
      "shell": "bash",
      "run": "value=\"${GITHUB_WORKFLOW_SHA}\"\n[[ \"$value\" =~ ^[0-9a-fA-F]{40}$ ]] || { echo \"工作流来源不是完整提交编号\" >&2; exit 1; }\necho \"sha=${value,,}\" >> \"$GITHUB_OUTPUT\"\n"
    },
    {
      "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "with": {
        "path": "target",
        "fetch-depth": 0,
        "persist-credentials": false
      }
    },
    {
      "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "with": {
        "repository": "splrad/steward",
        "ref": "${{ steps.policy.outputs.sha }}",
        "path": "steward-policy",
        "persist-credentials": false
      }
    },
    {
      "uses": "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "with": {
        "node-version-file": "steward-policy/.node-version",
        "cache": "npm",
        "cache-dependency-path": "steward-policy/package-lock.json"
      }
    },
    {
      "run": "npm ci --ignore-scripts",
      "working-directory": "steward-policy"
    },
    {
      "id": "profile",
      "shell": "bash",
      "run": "case \"${{ github.repository_id }}\" in\n  1187527897) echo \"name=layerscape\" >> \"$GITHUB_OUTPUT\" ;;\n  1296724484) echo \"name=steward\" >> \"$GITHUB_OUTPUT\" ;;\n  *)\n    if [[ \"${{ github.event.repository.private }}\" == \"true\" ]]; then\n      echo \"私有仓库尚未纳管\" >&2\n      exit 1\n    fi\n    echo \"name=public-basic\" >> \"$GITHUB_OUTPUT\"\n    ;;\nesac\n"
    },
    {
      "env": {
        "VALIDATION_BASE_SHA": "${{ github.event.pull_request.base.sha }}",
        "VALIDATION_BASE_REF": "${{ github.event.pull_request.base.ref }}"
      },
      "run": "node steward-policy/packages/runner/dist/index.js validate --workspace target --repository-id \"${{ github.repository_id }}\" --profile \"${{ steps.profile.outputs.name }}\""
    }
  ]
};
const requiredFragmentsJob = {
  "needs": "validate",
  "if": "github.event.pull_request.base.ref == github.event.repository.default_branch",
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 5,
  "permissions": {
    "contents": "read",
    "pull-requests": "read",
    "checks": "read"
  },
  "steps": [
    {
      "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "with": {
        "repository": "splrad/steward",
        "ref": "${{ needs.validate.outputs.policy }}",
        "persist-credentials": false
      }
    },
    {
      "uses": "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "with": {
        "node-version-file": ".node-version"
      }
    },
    {
      "env": {
        "VALIDATION_BASE_SHA": "${{ github.event.pull_request.base.sha }}",
        "VALIDATION_HEAD_SHA": "${{ github.event.pull_request.head.sha }}",
        "VALIDATION_PR_NUMBER": "${{ github.event.pull_request.number }}",
        "VALIDATION_POLICY_SHA": "${{ needs.validate.outputs.policy }}",
        "VALIDATION_READ_TOKEN": "${{ github.token }}"
      },
      "run": "node packages/runner/dist/index.js validate --workspace . --repository-id \"${{ github.repository_id }}\" --profile \"${{ needs.validate.outputs.profile }}\" --fragments-only true"
    }
  ]
};
function canonical(value:any):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(object(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
export function assertRequiredValidation(d:any) {
 if(d?.name!=="SPLRAD Steward / PR Validation") fail("required workflow name changed");
 if(canonical(d.concurrency)!==canonical({"group":"steward-pr-validation-${{ github.repository_id }}-${{ github.event.pull_request.number }}","cancel-in-progress":true})) fail('required concurrency changed');
 const j=structuredClone(d?.jobs?.validate);
 if(!object(j) || !Array.isArray(j.steps))fail('required validate job missing');
 for(const step of j.steps)delete step.name;
 if(canonical(j)!==canonical(requiredValidationJob))fail('required trusted validation entry changed');
 const f=structuredClone(d?.jobs?.fragments);
 if(!object(f) || !Array.isArray(f.steps))fail('required fragments job missing');
 for(const step of f.steps)delete step.name;
 if(canonical(f)!==canonical(requiredFragmentsJob))fail('required fragments entry changed');
 if(!object(d.on) || Object.keys(d.on).length!==1 || !object(d.on.pull_request) || JSON.stringify(d.on.pull_request.types)!==JSON.stringify(['opened','synchronize','reopened','edited','labeled','unlabeled']) || Object.keys(d.on.pull_request).some(k=>k!=='types')) fail('required PR event coverage');
 if(d.env!==undefined || d.defaults!==undefined) fail('required entry environment/default overrides');
}
export async function verifyWorkflowPolicy(workspace:string, repositoryId:number, requiredPaths:readonly string[]) {
 const directory=join(workspace,'.github/workflows'); let files:string[]=[];
 try { if(!(await lstat(join(workspace,'.github'))).isDirectory() || !(await lstat(directory)).isDirectory()) fail('workflow directory type'); files=await readdir(directory); }
 catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const paths=files.filter(f=>/\.ya?ml$/.test(f)).map(f=>`.github/workflows/${f}`).sort();
 for(const required of requiredPaths) if(!paths.includes(required)) fail(`missing required entry ${required}`);
 if(repositoryId===1296724484) {
  const registry=JSON.parse(await readFile(join(workspace,'config/repositories.json'),'utf8'));
  const declared=registry.repositories?.[String(repositoryId)]?.allowedWorkflowPaths;
  if(!Array.isArray(declared) || JSON.stringify([...declared].sort())!==JSON.stringify(paths)) fail('candidate inventory does not match workflow files');
 }
 for(const path of paths) {
  if(!(await lstat(join(workspace,path))).isFile() || (await lstat(join(workspace,path))).isSymbolicLink()) fail('workflow must be regular file');
  const parsed=YAML.parseDocument(await readFile(join(workspace,path),'utf8'),{uniqueKeys:true});
  if(parsed.errors.length) fail('invalid YAML');const d=parsed.toJS({maxAliasCount:0});assertWorkflowDocument(path,d);
  if(requiredPaths.includes(path) && path==='.github/workflows/pr-validation.yml') assertRequiredValidation(d);
 }
 return paths;
}
