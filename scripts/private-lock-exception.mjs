import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assert} from './private-dependency-policy.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Fixed data-only exception. The caller supplies blobs from each exact Git snapshot.
export async function effectiveLock({item,sourceSha,directory,manifest,patch}){
  if(manifest===null&&patch===null)return null;
  const approved=item.lockException;
  assert(approved&&manifest&&patch,'LOCK_EXCEPTION_FILES');
  assert(hash(manifest)===approved.manifestSha256,'LOCK_EXCEPTION_MANIFEST_HASH');
  const value=JSON.parse(manifest.toString());
  assert(Object.keys(value).sort().join(',')==='effectiveLockSha256,originalLockSha256,patchSha256,schemaVersion,sourceSha,upstream'
    &&value.schemaVersion===1,'LOCK_EXCEPTION_SCHEMA');
  assert(value.upstream===item.upstream&&value.sourceSha===sourceSha,'LOCK_EXCEPTION_SOURCE');
  for(const key of ['originalLockSha256','patchSha256','effectiveLockSha256'])assert(/^[a-f0-9]{64}$/.test(value[key]),'LOCK_EXCEPTION_HASH_FORMAT');
  const original=await readFile(join(directory,'package-lock.json'));
  assert(hash(original)===value.originalLockSha256,'LOCK_EXCEPTION_ORIGINAL_HASH');
  assert(hash(patch)===value.patchSha256,'LOCK_EXCEPTION_PATCH_HASH');
  const temporary=await mkdtemp(join(tmpdir(),'steward-lock-exception-'));
  try{
    await writeFile(join(temporary,'package-lock.json'),original);
    await writeFile(join(temporary,'exception.patch'),patch);
    const env={};for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
    const git=args=>{
      const result=spawnSync('git',['-c','core.autocrlf=false','-c','core.hooksPath=',...args],{cwd:temporary,env,shell:false,windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
      assert(!result.error&&result.status===0,'LOCK_EXCEPTION_APPLY');return result.stdout;
    };
    // Git parses the patch; reject binary, rename, traversal and additional targets.
    assert(/^\d+\t\d+\tpackage-lock\.json\n$/.test(git(['apply','--numstat','exception.patch'])),'LOCK_EXCEPTION_TARGET');
    git(['apply','--check','exception.patch']);git(['apply','exception.patch']);
    const effective=await readFile(join(temporary,'package-lock.json'));
    assert(hash(effective)===value.effectiveLockSha256,'LOCK_EXCEPTION_RESULT_HASH');
    JSON.parse(effective.toString());await writeFile(join(directory,'package-lock.json'),effective);
    return {...value,manifestSha256:hash(manifest),manifestPath:approved.manifestPath,patchPath:approved.patchPath};
  }finally{await rm(temporary,{recursive:true,force:true});}
}
