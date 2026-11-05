import { expect, it } from 'vitest';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash,generateKeyPairSync } from 'node:crypto';
import YAML from 'yaml';
import { reconcileQualitySources } from '../../core/src/quality-language-summary.js';
import { decodeStateFile } from '../../core/src/release-observation.js';
import { isolatedBuildEnvironment } from '../src/build-environment.js';
import { registerOfflineFixtureRoot } from './offline-fixtures.js';

const report = () => ({ schemaVersion: 1, repositoryId: 12, repository: 'splrad/fixture', runId: 21, runAttempt: 2,
  controllerSha: 'a'.repeat(40), upstreamSha: 'b'.repeat(40), observedAt: '2026-10-28T00:00:00.000Z', mode: 'NOP', status: 'success',
  entries: [{kind:'result',value:JSON.stringify({repo:'fixture',plugin:'Labels',action:{additions:[{name:'auto/docs'}]}})}] });
const decode = (value:unknown,path='settings/21-2.json',id=12) => decodeStateFile('steward/governance-state',path,Buffer.from(JSON.stringify(value)+'\n'),id);
it('actual settings identity keeps App queries authenticated and public bot lookup anonymous',async()=>{
  const {settingsGovernanceIdentity}=await import(pathToFileURL(resolve('tools/settings-sync/governance-identity.mjs')).href);
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),calls:string[]=[];
  const transport=async(input:any,init:any)=>{
    const path=decodeURIComponent(new URL(String(input)).pathname),headers=new Headers(init.headers);calls.push(path);
    expect(headers.get('x-github-api-version')).toBe('2026-03-10');let value:any;
    if(path==='/app'){expect(headers.get('authorization')).toMatch(/^bearer /i);value={id:88,slug:'fixture-governance'};}
    else if(path==='/orgs/splrad/installation'){expect(headers.get('authorization')).toMatch(/^bearer /i);value={id:8,app_id:88,account:{id:302208797},suspended_at:null};}
    else if(path==='/users/fixture-governance[bot]'){expect(headers.has('authorization')).toBe(false);value={type:'Bot',id:33,login:'fixture-governance[bot]'};}
    else throw Error('UNEXPECTED_IDENTITY_ENDPOINT');
    return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
  };
  const result=await settingsGovernanceIdentity(88,privateKey.export({type:'pkcs8',format:'pem'}).toString(),transport);
  expect(result.identity).toEqual({name:'fixture-governance[bot]',email:'33+fixture-governance[bot]@users.noreply.github.com'});
  expect(calls).toEqual(['/app','/orgs/splrad/installation','/users/fixture-governance[bot]']);
});
it('settings evidence binds native repository/run/attempt and rejects another repository detail', () => {
  expect(decode(report())).toEqual(report());
  for (const value of [{...report(),repositoryId:13},{...report(),extra:true},{...report(),entries:[{kind:'error',value:'{}'}]},
    {...report(),entries:[{kind:'error',value:JSON.stringify({repo:'private-other',owner:'splrad'})}]}, {...report(),observedAt:'yesterday'}]) expect(()=>decode(value)).toThrow();
  expect(()=>decode(report(),'settings/21-3.json')).toThrow();
  expect(()=>decode(report(),'quality/21.json')).toThrow();
});
it('settings workflow isolates installation, main-only credentials, NOP default and report sinks',async()=>{
  const raw=await readFile('.github/workflows/settings-sync.yml','utf8'), workflow=YAML.parse(raw),job=workflow.jobs['settings-sync'];
  expect(workflow.on.schedule).toEqual([{cron:'17 * * * *'}]);
  expect(workflow.concurrency).toEqual({group:'steward-settings-sync','cancel-in-progress':false});
  expect(job['timeout-minutes']).toBe(20);expect(job.environment.name).toBe('steward-automation');
  expect(job.steps[0].with.ref).toBe('${{ github.workflow_sha }}');
  expect(job.steps[1].with.repository).toBe('github-community-projects/safe-settings');
  expect(job.steps[1].with.ref).toMatch(/^[a-f0-9]{40}$/);
  expect(job.steps[3].env).toBeUndefined();
  expect(job.steps[4].env.PRIVATE_KEY).toBe('${{ secrets.GOVERNANCE_APP_PRIVATE_KEY }}');
  expect(job.steps[4].env.FULL_SYNC_NOP).toBe("${{ vars.STEWARD_SETTINGS_APPLY == 'true' && 'false' || 'true' }}");
  expect(raw).not.toMatch(/upload-artifact|matrix:|GITHUB_OUTPUT/);
  expect(workflow.on.push.paths).not.toContain('config/governance/actions-policies.json');
  const runner=await readFile('scripts/settings-sync.mjs','utf8');
  expect(runner).not.toMatch(/actions-policies|reconcileActionsPolicies|actionsPolicyObservations|policyFailure/);
  const {settingsEnvironment}=await import(pathToFileURL(resolve('scripts/settings-sync.mjs')).href);
  const source={...process.env,APP_ID:'123',PRIVATE_KEY:'fixture-key',GH_TOKEN:'private-canary',COPILOT_GITHUB_TOKEN:'private-canary',NODE_OPTIONS:'private-canary',
    GITHUB_REPOSITORY:'splrad/steward',GITHUB_REPOSITORY_ID:'1296724484',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ID:'21',STEWARD_DEFAULT_BRANCH:'main',
    STEWARD_CONTROLLER_SHA:'a'.repeat(40),FULL_SYNC_NOP:'true',CRON:'private-canary',REDIS_URL:'private-canary'};
  const env=settingsEnvironment(source,resolve('.steward-build/profile'),resolve('.steward-build/result'),resolve('safe-settings/deployment-settings.yml'));
  expect(env.PRIVATE_KEY).toBe('fixture-key');expect(JSON.stringify(env)).not.toContain('private-canary');
  expect(env.CREATE_DEFAULT_BRANCH).toBe('false');expect(env.CREATE_PR_COMMENT).toBe('false');
});
it('settings own metadata matches previous labels while only the native upstream writes it',async()=>{
  const config=YAML.parse(await readFile('safe-settings/settings.yml','utf8')),deployment=YAML.parse(await readFile('safe-settings/deployment-settings.yml','utf8'));
  expect(config.additive_plugins).toEqual(['labels']);expect(deployment.restrictedRepos).toEqual([]);
  expect(Object.keys(config.repository).sort()).toEqual(['allow_auto_merge','allow_merge_commit','allow_rebase_merge','allow_squash_merge','squash_merge_commit_message','squash_merge_commit_title'].sort());
  const old=JSON.parse(await readFile('packages/core/test/fixtures/legacy-pr-semantics.json','utf8'));
  for(const role of Object.values(old.roles) as any[])for(const d of role.definitions)if(d.githubLabel)expect(config.labels).toContainEqual({...d.githubLabel,description:d.description});
  expect(config.labels.map((l:any)=>l.name)).toContain('release:editing');
  expect(new Set(config.labels.map((l:any)=>l.name)).size).toBe(config.labels.length);
  const sync=await readFile('.github/workflows/sync-managed.yml','utf8');expect(sync).not.toMatch(/managed-sync labels|steps.labels/);
  const cli=await readFile('packages/runner/src/native-release-cli.ts','utf8');expect(cli).not.toContain('NativeLabelSync');
});
it('actual Git settings evidence preserves quality, detects replay and rejects cross-repository writes',async()=>{
  const {writeReleaseRecords,readReleaseRecords}=await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
  const root=await mkdtemp(join(tmpdir(),'settings-git-fixture-'));registerOfflineFixtureRoot(root);
  try {
    const remote=join(root,'remote'),profile=join(root,'profile');await mkdir(remote);await mkdir(profile);
    const env=isolatedBuildEnvironment(process.env,profile),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
    const git=async(...args:string[])=>(await promisify(execFile)('git',args,{cwd:remote,env,windowsHide:true})).stdout.trim();
    await git('init','--initial-branch=main');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
    await writeFile(join(remote,'README.md'),'fixture\n');await git('add','README.md');await git('commit','--signoff','-m','Fixture');
    const source=await git('rev-parse','HEAD');
    const quality=await reconcileQualitySources(null,{repositoryId:12,pullRequestNumber:2,head:source,configVersion:'v1',observedAt:'2026-10-28T00:00:00.000Z'},[]);
    const qualityText=JSON.stringify(quality,null,2)+'\n';
    const qualityWrite=await writeReleaseRecords({directory:join(root,'quality'),remote,repositoryId:12,defaultBranch:'main',targetRef:'steward/governance-state',writer:'quality',expectedHead:null,
      allowedPaths:['quality/2.json'],changes:[{path:'quality/2.json',content:qualityText,sha256:hash(qualityText),previousSha256:null}],identity:{name:'Fixture',email:'fixture@example.invalid'}});
    const text=JSON.stringify(report(),null,2)+'\n';
    const request=(dir:string,value:string,path='settings/21-2.json')=>({directory:join(root,dir),remote,repositoryId:12,defaultBranch:'main',targetRef:'steward/governance-state',
      writer:'settings',expectedHead:qualityWrite.head,allowedPaths:[path],changes:[{path,content:value,sha256:hash(value),previousSha256:null}],identity:{name:'Fixture',email:'fixture@example.invalid'}});
    expect((await writeReleaseRecords(request('one',text))).status).toBe('APPLIED');
    expect((await writeReleaseRecords(request('replay',text))).status).toBe('UNCHANGED');
    expect((await readReleaseRecords({directory:remote,targetRef:'steward/governance-state',repositoryId:12})).domainRecords.find((r:any)=>r.path==='settings/21-2.json').value).toEqual(report());
    expect((await readReleaseRecords({directory:remote,targetRef:'steward/governance-state',repositoryId:12})).domainRecords.find((r:any)=>r.path==='quality/2.json').content).toBe(qualityText);
    await expect(writeReleaseRecords(request('foreign',JSON.stringify({...report(),repositoryId:13})+'\n'))).rejects.toThrow();
    await expect(writeReleaseRecords(request('wrong-owner',text,'quality/21.json'))).rejects.toThrow();
  }finally{await rm(root,{recursive:true,force:true});}
},120000);
