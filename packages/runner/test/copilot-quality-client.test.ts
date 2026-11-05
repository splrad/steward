import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotQualityClient } from '../src/copilot-quality-client.js';
import { prepareQualitySource } from '../../core/src/quality-language-summary.js';
import { permitOfflineScript, registerOfflineFixtureRoot } from './offline-fixtures.js';
const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(mode='ok') {
  const root=await mkdtemp(join(tmpdir(),'quality-child-fixture-'));roots.push(root);registerOfflineFixtureRoot(root);
  const directory=join(root,'tools/quality-language');await mkdir(directory,{recursive:true});const script=join(directory,'run.mjs');
  await writeFile(script,`import fs from 'node:fs';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
    const input=await new Promise(done=>{let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>done(s));});
    fs.writeFileSync(fileURLToPath(new URL('./observed.json',import.meta.url)),JSON.stringify({cwd:process.cwd(),env:process.env,input}));
    process.stderr.write('private raw diagnostic');
    if (${JSON.stringify(mode)}==='bad')process.stdout.write(JSON.stringify({status:'RETURNED',model:'fixture',usage:null,value:{items:[]}}));
    else if (${JSON.stringify(mode)}==='quota')process.stdout.write(JSON.stringify({status:'WAIT_QUOTA',retryAfterMs:90000}));
    else if(process.argv[2]==='preflight')process.stdout.write(JSON.stringify({status:'READY'}));
    else process.stdout.write(JSON.stringify({status:'RETURNED',model:'fixture',usage:null,value:{items:JSON.parse(input).items.map(({bodyMarkdown,...item})=>({...item,problemZh:'输入失败。',impactZh:'调用中断。',suggestionZh:'检查输入。'}))}}));`);
  permitOfflineScript(script);return {root,directory,client:copilotQualityClient(root,'copilot-fixture')};
}
const segments=prepareQualitySource({sourceCommentId:'review:1',sourceCommit:'a'.repeat(40),sourceUrl:'https://github.com/a/b/pull/1',
  severity:'原文未说明',bodyMarkdown:'Check `API` input.',updatedAt:'2026-10-28T00:00:00Z'}).segments;
it('actual child sees only Copilot and OS allowlist; repository/App/session credentials never cross',async()=>{
  const f=await fixture();for(const name of ['STEWARD_APP_PRIVATE_KEY','GOVERNANCE_APP_PRIVATE_KEY','GH_TOKEN','GITHUB_TOKEN','POLICY_READ_TOKEN','NODE_OPTIONS','HTTPS_PROXY','COPILOT_HOME'])vi.stubEnv(name,'parent-canary');
  expect((await f.client.call(segments)).model).toBe('fixture');
  const observed=JSON.parse(await readFile(join(f.directory,'observed.json'),'utf8'));
  expect(observed.env.STEWARD_COPILOT_TOKEN).toBe('copilot-fixture');expect(Object.values(observed.env)).not.toContain('parent-canary');
  expect(observed.env.HOME).toBe(observed.cwd);expect(JSON.parse(observed.input)).toEqual({items:segments});
  await expect(readFile(join(observed.cwd,'anything'))).rejects.toMatchObject({code:'ENOENT'});
});
it('native quota failure retains its delay and malformed output is rejected by the parent',async()=>{
  const quota=await fixture('quota');await expect(quota.client.call(segments)).rejects.toMatchObject({message:'WAIT_QUOTA',retryAfterMs:90000});
  const bad=await fixture('bad');await expect(bad.client.call(segments)).rejects.toThrow(/QUALITY_OUTPUT/);
});
it('missing credential never launches an inherited authenticated process',async()=>{
  const f=await fixture();await expect(copilotQualityClient(f.root,'').preflight()).rejects.toThrow('WAIT_AUTH');
  await expect(readFile(join(f.directory,'observed.json'))).rejects.toMatchObject({code:'ENOENT'});
});
