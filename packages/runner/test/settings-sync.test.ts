import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
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
it('central file delivery does not restore retired label synchronization',async()=>{
  const sync=await readFile('.github/workflows/sync-managed.yml','utf8');expect(sync).not.toMatch(/managed-sync labels|steps.labels/);
  const cli=await readFile('packages/runner/src/native-release-cli.ts','utf8');expect(cli).not.toContain('NativeLabelSync');
});
