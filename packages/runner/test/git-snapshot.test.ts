import {expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {localGitSnapshot,safeGitPath} from '../src/git-snapshot.js';
import {registerOfflineFixtureRoot} from './offline-fixtures.js';
it.each(['../escape','/absolute','a\\b','.git/config','CON.txt','a//b','a/../b','a.'])('preserves path rejection for %s',path=>expect(()=>safeGitPath(path)).toThrow('unsafe path'));
it('reads exact committed bytes, missing paths and modes from actual Git without the old synchronization compiler',async()=>{
  const root=await mkdtemp(join(tmpdir(),'git-snapshot-')),run=promisify(execFile);
  registerOfflineFixtureRoot(root);
  try {
    const git=async(...args:string[])=>(await run('git',['-c','core.hooksPath=','-c','commit.gpgsign=false',...args],{cwd:root,windowsHide:true})).stdout.trim();
    await git('init','--initial-branch=main');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
    await git('config','core.autocrlf','false');await writeFile(join(root,'bytes.txt'),Buffer.from([65,0,66]));await git('add','bytes.txt');await git('commit','--signoff','-m','Snapshot fixture');
    const head=await localGitSnapshot.head(root);expect(await localGitSnapshot.file(root,head,'bytes.txt')).toEqual(Buffer.from([65,0,66]));
    expect(await localGitSnapshot.file(root,head,'missing')).toBeNull();
    await expect(localGitSnapshot.file(root,'main','bytes.txt')).rejects.toThrow('invalid source commit');
    await expect(localGitSnapshot.file(root,head,'../outside')).rejects.toThrow('unsafe path');
    await writeFile(join(root,'state.json'),'fixture');await git('add','state.json');
    const oid=await git('rev-parse',head+':bytes.txt');await git('update-index','--cacheinfo','120000,'+oid+',state.json');await git('commit','--signoff','-m','Link fixture');
    await expect(localGitSnapshot.file(root,await localGitSnapshot.head(root),'state.json')).rejects.toThrow('regular Git blob');
  }finally{await rm(root,{recursive:true,force:true});}
});
