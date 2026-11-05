import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, open, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { parse } from 'yaml';
import { isolatedBuildEnvironment } from '../packages/runner/dist/index.js';
import { readReleaseRecords, writeReleaseRecords } from './release-record.mjs';
import { assertQualityProtection, qualityNativeIO } from './quality-language-summary.mjs';
import { settingsGovernanceIdentity } from '../tools/settings-sync/governance-identity.mjs';

const branch = 'steward/governance-state';
const check = (value, code) => { if (!value) throw new Error(code); };
const hash = value => createHash('sha256').update(value).digest('hex');

export async function archiveSettingsDetails({ root, repository, token, governanceAppId, identity, report }, transport = fetch) {
  const io = qualityNativeIO(repository.full_name, token, transport);
  const { value: current } = await io.get(`/repos/${repository.full_name}`);
  check(current.id === repository.id && current.full_name === repository.full_name && current.default_branch === repository.default_branch
    && !current.archived && !current.disabled, 'SETTINGS_REPOSITORY_CHANGED');
  await assertQualityProtection(io, repository.full_name, governanceAppId);
  const { value: ref } = await io.get(`/repos/${repository.full_name}/git/ref/heads/${branch}`);
  check(ref.ref === `refs/heads/${branch}` && ref.object?.type === 'commit' && /^[a-f0-9]{40}$/.test(ref.object.sha), 'SETTINGS_STATE_REF');
  const directory = await mkdtemp(join(root, 'settings-read-')), profile = await mkdtemp(join(root, 'settings-profile-'));
  const remote = `https://github.com/${repository.full_name}.git`, env = isolatedBuildEnvironment(process.env, profile);
  Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${remote}.extraheader`, GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64') });
  const git = async (...args) => (await promisify(execFile)('git', ['--no-replace-objects','-c','core.hooksPath=','-c','core.fsmonitor=false','-c','credential.helper=',...args],
    { cwd: directory, env, windowsHide: true, timeout: 90_000, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
  await git('init','--initial-branch=settings-read');
  await git('fetch','--no-tags','--no-recurse-submodules',remote,`refs/heads/${branch}`);
  check(await git('rev-parse','FETCH_HEAD') === ref.object.sha, 'SETTINGS_STATE_MOVED');
  await git('update-ref', `refs/heads/${branch}`, ref.object.sha);
  const snapshot = await readReleaseRecords({ directory, targetRef: branch, repositoryId: repository.id });
  const path = `settings/${report.runId}-${report.runAttempt}.json`, previous = snapshot.domainRecords.find(r => r.path === path);
  if (previous) {
    const comparable = { ...report, observedAt: previous.value.observedAt };
    check(JSON.stringify(previous.value) === JSON.stringify(comparable), 'SETTINGS_ATTEMPT_CONFLICT');
    return snapshot.head;
  }
  const content = JSON.stringify(report, null, 2) + '\n';
  const writeRoot = await mkdtemp(join(root, 'settings-write-'));
  const result = await writeReleaseRecords({ directory: join(writeRoot, 'checkout'), remote, repositoryId: repository.id, defaultBranch: repository.default_branch,
    targetRef: branch, writer: 'settings', expectedHead: snapshot.head, allowedPaths: [path],
    changes: [{ path, content, sha256: hash(content), previousSha256: null }], identity }, { token });
  check(['APPLIED','UNCHANGED'].includes(result.status), 'SETTINGS_WRITE_UNCONFIRMED');
  await git('fetch','--no-tags','--no-recurse-submodules',remote,`refs/heads/${branch}`);
  const head = await git('rev-parse','FETCH_HEAD'); await git('update-ref',`refs/heads/${branch}`,head);
  const observed = await readReleaseRecords({ directory, targetRef: branch, repositoryId: repository.id });
  check(observed.domainRecords.find(r => r.path === path)?.content === content, 'SETTINGS_WRITE_READBACK');
  return head;
}

/** No inherited credentials or repository-controlled runtime configuration in the child. */
export function settingsEnvironment(source, profile, output, deployment) {
  const env = isolatedBuildEnvironment(source, profile);
  for (const key of ['APP_ID','PRIVATE_KEY','GITHUB_REPOSITORY','GITHUB_REPOSITORY_ID','GITHUB_REF','GITHUB_RUN_ID','STEWARD_DEFAULT_BRANCH','STEWARD_CONTROLLER_SHA','FULL_SYNC_NOP']) {
    check(typeof source[key] === 'string' && source[key].length > 0, 'SETTINGS_ENVIRONMENT'); env[key] = source[key];
  }
  return { ...env, GH_ORG: 'splrad', ADMIN_REPO: 'steward', CONFIG_PATH: 'safe-settings', SETTINGS_FILE_PATH: 'settings.yml',
    DEPLOYMENT_CONFIG_FILE: deployment, CREATE_DEFAULT_BRANCH: 'false', CREATE_PR_COMMENT: 'false', CREATE_ERROR_ISSUE: 'false', LOG_LEVEL: 'error', STEWARD_SETTINGS_RESULT: output };
}

export async function main() {
  const env = process.env, runId = Number(env.GITHUB_RUN_ID), runAttempt = Number(env.GITHUB_RUN_ATTEMPT), governanceAppId = Number(env.APP_ID);
  check(env.GITHUB_REPOSITORY === 'splrad/steward' && env.GITHUB_REPOSITORY_ID === '1296724484' && env.GITHUB_REF === `refs/heads/${env.STEWARD_DEFAULT_BRANCH}`
    && [runId,runAttempt,governanceAppId].every(n => Number.isSafeInteger(n) && n > 0) && governanceAppId !== 4243096
    && /^[a-f0-9]{40}$/.test(env.STEWARD_CONTROLLER_SHA ?? '') && ['true','false'].includes(env.FULL_SYNC_NOP), 'SETTINGS_IDENTITY');
  const workflow = parse(await readFile('.github/workflows/settings-sync.yml','utf8'));
  const upstreamSha = workflow.jobs['settings-sync'].steps.find(step => step.with?.repository === 'github-community-projects/safe-settings')?.with?.ref;
  check(/^[a-f0-9]{40}$/.test(upstreamSha), 'SETTINGS_UPSTREAM_PIN');
  const upstream = resolve('tools/upstream/safe-settings');
  const git = async (...args) => (await promisify(execFile)('git',['--no-replace-objects','-C',upstream,...args],{windowsHide:true})).stdout.trim();
  check(await git('rev-parse','HEAD') === upstreamSha && await git('status','--porcelain','--untracked-files=no') === '', 'SETTINGS_UPSTREAM_CHANGED');
  const log = {debug(){},info(){},warn(){},error(){}};
  const {app,installation,identity}=await settingsGovernanceIdentity(governanceAppId,env.PRIVATE_KEY);
  const root=await mkdtemp(join(tmpdir(),'steward-settings-')),profile=await mkdtemp(join(root,'profile-')),output=join(root,'result.json');
  const raw=await open(join(root,'upstream.log'),'wx',0o600);
  let code;
  try { code=await new Promise((done,reject)=>{
    const child=spawn(process.execPath,['tools/settings-sync/entry.cjs'],{cwd:process.cwd(),windowsHide:true,timeout:18*60_000,
      env:settingsEnvironment(env,profile,output,resolve('safe-settings/deployment-settings.yml')),stdio:['ignore',raw.fd,raw.fd]});
    child.on('error',reject);child.on('close',value=>done(value ?? 1));
  }); } finally {await raw.close();}
  const result=JSON.parse(await readFile(output,'utf8'));
  check(result.summary && Object.values(result.summary).every(v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0||['NOP','APPLY'].includes(v)),'SETTINGS_RESULT');
  const counts={...result.summary,archived:0,archiveFailures:0};
  for(const detail of result.details) {
    try {
      const repository=detail.repository;
      check(repository.full_name===`splrad/${repository.name}` && Number.isSafeInteger(repository.id),'SETTINGS_ARCHIVE_TARGET');
      const credential=await app.auth({type:'installation',installationId:installation.id,repositoryIds:[repository.id],permissions:{metadata:'read',contents:'write',administration:'read'},refresh:true});
      const client=new Octokit({auth:credential.token,log});
      try {
        const scope=(await client.request('GET /installation/repositories')).data;
        check(scope.total_count===1 && scope.repositories[0]?.id===repository.id,'SETTINGS_ARCHIVE_SCOPE');
        const report={schemaVersion:1,repositoryId:repository.id,repository:repository.full_name,runId,runAttempt,controllerSha:env.STEWARD_CONTROLLER_SHA,upstreamSha,
          observedAt:new Date().toISOString(),mode:result.summary.mode,status:detail.entries.some(e=>e.kind==='error'||e.entry.type==='ERROR')?'failure':'success',
          entries:detail.entries.map(({kind,entry})=>({kind,value:JSON.stringify(entry)}))};
        await archiveSettingsDetails({root,repository,token:credential.token,governanceAppId,identity,report});counts.archived++;
      } finally {await client.request('DELETE /installation/token');}
    } catch {counts.archiveFailures++;}
  }
  const summary=JSON.stringify(counts)+'\n';process.stdout.write(summary);
  if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,summary);
  if(code!==0 || result.exitCode!==0 || counts.archiveFailures>0)process.exitCode=1;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{process.stderr.write('SETTINGS_UNAVAILABLE\n');process.exitCode=1;});
