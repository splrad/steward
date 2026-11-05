import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { decodeStateFile } from '../../core/src/release-observation.js';

const report = () => ({ schemaVersion: 1, repositoryId: 12, repository: 'splrad/fixture', runId: 21, runAttempt: 2,
  controllerSha: 'a'.repeat(40), upstreamSha: 'b'.repeat(40), observedAt: '2026-10-28T00:00:00.000Z', mode: 'NOP', status: 'success',
  entries: [{kind:'result',value:JSON.stringify({repo:'fixture',plugin:'Labels',action:{additions:[{name:'auto/docs'}]}})}] });
const decode = (value:unknown,path='settings/21-2.json',id=12) => decodeStateFile('steward/governance-state',path,Buffer.from(JSON.stringify(value)+'\n'),id);
it('settings evidence binds native repository/run/attempt and rejects another repository detail', () => {
  expect(decode(report())).toEqual(report());
  for (const value of [{...report(),repositoryId:13},{...report(),extra:true},{...report(),entries:[{kind:'error',value:'{}'}]},
    {...report(),entries:[{kind:'error',value:JSON.stringify({repo:'private-other',owner:'splrad'})}]}, {...report(),observedAt:'yesterday'}]) expect(()=>decode(value)).toThrow();
  expect(()=>decode(report(),'settings/21-3.json')).toThrow();
  expect(()=>decode(report(),'quality/21.json')).toThrow();
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
