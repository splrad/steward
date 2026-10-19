import { afterEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { authorizeMigration, assertWorkflowMigration, validateMigration, type WorkflowMigration } from '../src/workflow-migration.js';
import { main, assertWorkflowPaths } from '../src/index.js';
const path = '.github/workflows/new.yml';
const body = 'name: test\non: workflow_dispatch\njobs: {}\n';
const manifest = (): WorkflowMigration => ({id:'steward-253-workflows-v1',repositoryId:1296724484,fullName:'splrad/steward',pullNumber:253,baseRef:'main',expiresAt:'2026-11-03T00:00:00Z',from:['.github/workflows/old.yml'],workflows:{[path]:createHash('sha256').update(body).digest('hex')}});
const event = () => ({number:253,repository:{id:1296724484,full_name:'splrad/steward'},pull_request:{number:253,base:{ref:'main',repo:{id:1296724484}},head:{repo:{id:1296724484}}}});
const now = Date.parse('2026-10-20T00:00:00Z');
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('trusted workflow migration',()=>{
 it('keeps exact old-set validation',()=>{expect(()=>assertWorkflowPaths(['old'],['old'])).not.toThrow();expect(()=>assertWorkflowPaths(['old','extra'],['old'])).toThrow();expect(()=>assertWorkflowPaths([],['old'])).toThrow();});
 it('authorizes only the complete approved new set',()=>expect(()=>authorizeMigration(manifest(),event(),1296724484,[path],manifest().from,now)).not.toThrow());
 it.each(['repository','name','pr','base','fork','base-repo','missing-event'])( 'rejects wrong identity: %s',kind=>{const e=event(); if(kind==='repository')e.repository.id++;if(kind==='name')e.repository.full_name='other/repo';if(kind==='pr')e.number++;if(kind==='base')e.pull_request.base.ref='other';if(kind==='fork')e.pull_request.head.repo.id++;if(kind==='base-repo')e.pull_request.base.repo.id++;expect(()=>authorizeMigration(manifest(),kind==='missing-event'?{}:e,1296724484,[path],manifest().from,now)).toThrow();});
 it.each(['expired','extra','missing','old-policy','cli-repository'])('rejects boundary: %s',kind=>{expect(()=>authorizeMigration(manifest(),event(),kind==='cli-repository'?1:1296724484,kind==='extra'?[path,'.github/workflows/extra.yml']:kind==='missing'?[]:[path],kind==='old-policy'?[]:manifest().from,kind==='expired'?Date.parse(manifest().expiresAt):now)).toThrow();});
 it.each(['digest','path','date'])('rejects malformed manifest: %s',kind=>{const m=manifest();if(kind==='digest')m.workflows[path]='bad';if(kind==='path')m.from=['../outside'];if(kind==='date')m.expiresAt='never';expect(()=>validateMigration(m)).toThrow();});
 it('validates the shipped trusted record and original catalog',async()=>{const m=JSON.parse(await readFile('config/workflow-migration.json','utf8'));validateMigration(m);expect(m.from).toHaveLength(10);expect(m.from).toContain('.github/workflows/issue-sync.yml');expect(Object.keys(m.workflows)).toHaveLength(11);});
 it.each(['valid','content','dirty','mode','candidate-manifest','event-type'])('checks Git checkout and trusted manifest: %s',async kind=>{
  vi.spyOn(Date,'now').mockReturnValue(now);
  const dir=await mkdtemp(join(tmpdir(),'workflow-migration-'));try{
   const git=(args:string[])=>execFileSync('git',args,{cwd:dir,stdio:'pipe'});
   git(['init']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);git(['config','core.autocrlf','false']);await mkdir(join(dir,'.github/workflows'),{recursive:true});await writeFile(join(dir,path),kind==='content'?body+'# changed\n':body);git(['add','.']);if(kind==='mode')git(['update-index','--chmod=+x',path]);git(['commit','-m','fixture']);
   const trusted=join(dir,'trusted.json');const m=manifest(); if(kind==='candidate-manifest')m.workflows[path]='0'.repeat(64);await writeFile(trusted,JSON.stringify(m));await mkdir(join(dir,'config'));await writeFile(join(dir,'config/workflow-migration.json'),JSON.stringify(manifest()));await writeFile(join(dir,'event.json'),JSON.stringify(event()));if(kind==='dirty')await writeFile(join(dir,path),body+'# dirty');
   vi.stubEnv('GITHUB_EVENT_NAME',kind==='event-type'?'workflow_dispatch':'pull_request');vi.stubEnv('GITHUB_EVENT_PATH',join(dir,'event.json'));
   const promise=assertWorkflowMigration(trusted,dir,1296724484,[path],m.from);if(kind==='valid') {
    await expect(promise).resolves.toBe(m.id);
    const policy=join(dir,'policy'); await cp('config',policy,{recursive:true});
    const registry=JSON.parse(await readFile(join(policy,'repositories.json'),'utf8'));registry.repositories['1296724484'].allowedWorkflowPaths=m.from;
    await writeFile(join(policy,'repositories.json'),JSON.stringify(registry));await writeFile(join(policy,'workflow-migration.json'),JSON.stringify(m));
    const profilePath=join(policy,'profiles/validation/steward.json');const profile=JSON.parse(await readFile(profilePath,'utf8'));profile.tasks=['parse-json'];await writeFile(profilePath,JSON.stringify(profile));
    vi.stubEnv('STEWARD_CONFIG_DIRECTORY',policy);vi.stubEnv('VALIDATION_BASE_SHA','');vi.stubEnv('VALIDATION_BASE_REF','');vi.stubEnv('GITHUB_STEP_SUMMARY',join(dir,'summary.txt'));
    await expect(main(['validate','--workspace',dir,'--repository-id','1296724484','--profile','steward'])).resolves.toBeUndefined();
    await writeFile(join(dir,'broken.json'),'{');
    await expect(main(['validate','--workspace',dir,'--repository-id','1296724484','--profile','steward'])).rejects.toThrow('验证任务失败');
   } else await expect(promise).rejects.toThrow();
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
