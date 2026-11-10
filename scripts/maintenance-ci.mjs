import {execFileSync} from 'node:child_process';
import {readFile, appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import YAML from 'yaml';
import {githubHeaders} from '../packages/github/src/api-version.ts';

const check = (ok, reason) => { if (!ok) throw Error(`MAINTENANCE_CI: ${reason}`); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const branch = 'maintenance/legacy-runtime-e990eda';
export const workflow = '.github/workflows/maintenance-validation.yml';
export const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

// Action commit updates are allowed; all other workflow semantics remain centrally approved.
export function workflowDigest(text, allowedActions) {
  const document = YAML.parseDocument(text, {uniqueKeys:true});
  check(!document.errors.length, 'workflow YAML');
  const value = document.toJS({maxAliasCount:0});
  function normalize(object) {
    if (!object || typeof object !== 'object') return;
    for (const [key, item] of Object.entries(object)) {
      if (key === 'uses') {
        check(typeof item === 'string' && /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(item), 'unpinned action');
        if (allowedActions) check(allowedActions.includes(item), 'unapproved action reference');
        object[key] = item.replace(/@[a-f0-9]{40}$/, '@PIN');
      } else normalize(item);
    }
  }
  normalize(value);
  return digest(JSON.stringify(canonical(value)));
}

export function eventIdentity(event, env) {
  const p = event.pull_request;
  check(env.GITHUB_EVENT_NAME === 'pull_request', 'event');
  check(env.GITHUB_REPOSITORY === 'splrad/steward' && env.GITHUB_REPOSITORY_ID === '1296724484'
    && event.repository?.id === 1296724484 && event.repository.full_name === 'splrad/steward', 'repository');
  check(env.WORKFLOW_REPOSITORY === 'splrad/steward' && env.WORKFLOW_PATH === workflow
    && sha(env.WORKFLOW_SHA), 'workflow provenance');
  check(p?.state === 'open' && Number.isSafeInteger(p.number) && p.number > 0 && event.number === p.number
    && p.base?.repo?.id === 1296724484 && p.base.ref === branch
    && p.head?.repo?.id === 1296724484 && p.head.repo.full_name === 'splrad/steward'
    && typeof p.head.ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(p.head.ref)
    && !p.head.ref.includes('..') && p.head.ref !== branch
    && sha(p.base.sha) && sha(p.head.sha), 'pull identity');
  check(env.GITHUB_REF === `refs/pull/${p.number}/merge` && sha(env.GITHUB_SHA), 'merge identity');
  return {repositoryId:1296724484, pullNumber:p.number, base:p.base.sha, head:p.head.sha,
    headRef:p.head.ref, merge:env.GITHUB_SHA, policy:env.WORKFLOW_SHA};
}

export async function liveIdentity(identity, get) {
  const root = '/repos/splrad/steward';
  const read = async () => {
    const p = await get(`${root}/pulls/${identity.pullNumber}`);
    check(p.state === 'open' && p.number === identity.pullNumber && p.base?.repo?.id === identity.repositoryId
      && p.base.ref === branch && p.base.sha === identity.base && p.head?.repo?.id === identity.repositoryId
      && p.head.ref === identity.headRef && p.head.sha === identity.head, 'pull moved');
    const base = await get(`${root}/git/ref/heads/${branch}`);
    const head = await get(`${root}/git/ref/heads/${identity.headRef}`);
    const merge = await get(`${root}/git/ref/pull/${identity.pullNumber}/merge`);
    check(base.object?.sha === identity.base && head.object?.sha === identity.head
      && merge.object?.sha === identity.merge, 'refs moved');
  };
  await read();
  const head = await get(`${root}/commits/${identity.head}`);
  check(head.sha === identity.head && head.commit?.verification?.verified === true
    && head.commit.verification.reason === 'valid', 'unsigned head');
  const merge = await get(`${root}/commits/${identity.merge}`);
  check(merge.sha === identity.merge && merge.parents?.length === 2
    && merge.parents[0].sha === identity.base && merge.parents[1].sha === identity.head, 'merge parents');
  const source = await get(`${root}/compare/${identity.policy}...main`);
  check(['ahead','identical'].includes(source.status) && source.merge_base_commit?.sha === identity.policy,
    'policy not adopted on main');
  await read();
  return identity;
}

function git(workspace, args) {
  return execFileSync('git', ['--no-replace-objects','-c','core.hooksPath=','-c','credential.helper=',...args],
    {cwd:workspace, encoding:'utf8', maxBuffer:32*1024*1024, timeout:60000, windowsHide:true});
}
export function verifyTree(workspace, identity, policy) {
  check(git(workspace,['rev-parse','HEAD']).trim() === identity.merge, 'checkout');
  check(git(workspace,['rev-list','--parents','-n','1',identity.merge]).trim()
    === `${identity.merge} ${identity.base} ${identity.head}`, 'local merge parents');
  check(sha(policy.toolchainSource), 'approved toolchain source');
  const toolchainAt = ref => {
    for (const path of ['.node-version','package.json'])
      check(git(workspace,['ls-tree',ref,'--',path]).startsWith('100644 blob '), 'toolchain file mode');
    const node = git(workspace,['show',`${ref}:.node-version`]).trim();
    const manifest = JSON.parse(git(workspace,['show',`${ref}:package.json`]));
    check(/^\d+\.\d+\.\d+$/.test(node) && manifest.engines?.node === node
      && /^npm@\d+\.\d+\.\d+$/.test(manifest.packageManager), 'toolchain contract');
    return JSON.stringify([node,manifest.packageManager]);
  };
  const approvedToolchain = toolchainAt(policy.toolchainSource);
  check(sha(policy.validationSource), 'approved validation source');
  const readManifest = ref => JSON.parse(git(workspace,['show',`${ref}:package.json`]));
  const approvedScripts = JSON.stringify(canonical(readManifest(policy.validationSource).scripts));
  const validationFiles = git(workspace,['ls-tree','-r','--name-only',policy.validationSource,'--','scripts']).trim().split('\n').filter(Boolean);
  check(validationFiles.length > 0, 'validation script inventory');
  // Compare absence too: newly added npm/Vite configuration can replace the fixed checks.
  validationFiles.push('.npmrc','tsconfig.json','tsconfig.runtime.json');
  for (const prefix of ['vitest.config','vitest.workspace','vite.config'])
    for (const extension of ['js','ts','mjs','mts','cjs','cts','json'])
      validationFiles.push(`${prefix}.${extension}`);
  // Read Git objects, never import or execute candidate modules in the trusted identity process.
  for (const ref of [identity.head, identity.merge]) {
    check(toolchainAt(ref) === approvedToolchain, 'toolchain upgrade requires central adoption');
    check(JSON.stringify(canonical(readManifest(ref).scripts)) === approvedScripts, 'validation commands changed');
    for (const path of validationFiles) {
      check(git(workspace,['ls-tree',ref,'--',path]) === git(workspace,['ls-tree',policy.validationSource,'--',path]), `validation implementation changed: ${path}`);
    }
    const entries = git(workspace,['ls-tree','-r','-z',ref]).split('\0').filter(Boolean).map(row => {
      const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(row);
      check(match, 'tree entry'); return {mode:match[1],path:match[4]};
    });
    const workflows = entries.filter(row => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(row.path));
    check(JSON.stringify(workflows.map(row => row.path).sort()) === JSON.stringify(Object.keys(policy.workflows).sort()), 'workflow inventory');
    for (const row of workflows) {
      check(row.mode === '100644', 'workflow mode');
      check(policy.workflows[row.path].includes(workflowDigest(git(workspace,['show',`${ref}:${row.path}`]),policy.allowedActions)), `workflow semantics: ${row.path}`);
    }
    for (const [path, expected] of Object.entries(policy.immutable)) {
      check(entries.find(row => row.path === path)?.mode === '100644', 'protected file mode');
      check(digest(git(workspace,['show',`${ref}:${path}`])) === expected, `historical contract: ${path}`);
    }
  }
  git(workspace,['-c','core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol','diff','--check',identity.base,identity.head]);
}

export function verifyResults(needs) {
  for (const name of ['source','test','dependency']) check(needs?.[name]?.result === 'success', `job ${name}`);
}

export async function main(env = process.env) {
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
  const identity = eventIdentity(event,env);
  const token = env.MAINTENANCE_READ_TOKEN;
  check(token, 'read token');
  delete process.env.MAINTENANCE_READ_TOKEN;
  const get = async path => {
    const response = await fetch(`https://api.github.com${path}`, {headers:githubHeaders(token), signal:AbortSignal.timeout(30000)});
    check(response.ok, `API ${response.status}`); return response.json();
  };
  await liveIdentity(identity,get);
  if (env.MAINTENANCE_PHASE === 'source') {
    const policy = JSON.parse(await readFile(new URL('../config/maintenance-ci.json',import.meta.url),'utf8'));
    verifyTree(resolve(env.VALIDATION_WORKSPACE ?? 'target'),identity,policy);
  } else {
    check(env.MAINTENANCE_PHASE === 'final', 'phase');
    verifyResults(JSON.parse(env.MAINTENANCE_NEEDS));
  }
  const record = {...identity, phase:env.MAINTENANCE_PHASE, runId:env.GITHUB_RUN_ID, attempt:env.GITHUB_RUN_ATTEMPT,
    checkedAt:new Date().toISOString(), aiReview:'REQUIRED_SEPARATELY_BEFORE_ADOPTION', deployment:'NOT_AUTHORIZED'};
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,'```json\n'+JSON.stringify(record,null,2)+'\n```\n');
  console.log(JSON.stringify(record));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => {console.error(error.message); process.exitCode=1;});
