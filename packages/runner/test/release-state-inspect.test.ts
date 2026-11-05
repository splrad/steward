import { expect, it, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectNativeReleaseRecords, nativeReleaseCli, parseNativeInvocation } from '../src/native-release-cli.js';
import { nativeGhCommand, type GhCommand } from '../src/gh-release.js';
vi.mock('../src/gh-release.js',async original=>({...await original<typeof import('../src/gh-release.js')>(),nativeGhCommand:vi.fn()}));
const S='a'.repeat(40),A='b'.repeat(40),T='c'.repeat(40);
const record={schemaVersion:2,repositoryId:1,defaultBranch:'main',revision:0,lastObservedDefaultSha:null,lastCompletedCycleId:null,activeCycleId:null,candidate:null,nextCheckAt:null,lastProgressAt:null,lastErrorCode:null};
function fixture() {
  const state=structuredClone(record) as Record<string,unknown>;
  const requests:string[][]=[];let moved=false,truncated=false,mode='100644';
  const gh:GhCommand=async args=>{
    requests.push([...args]);expect(args.slice(0,3)).toEqual(['api','--method','GET']);
    const path=args[3]!,bytes=Buffer.from(JSON.stringify(state)),blobSha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if(path==='repos/example/product')return JSON.stringify({id:1,full_name:'example/product',default_branch:'main'});
    if(path==='repos/example/product/commits/main')return JSON.stringify({sha:S});
    if(path==='repos/example/product/git/ref/heads/steward/release-state')return JSON.stringify({ref:'refs/heads/steward/release-state',object:{type:'commit',sha:moved&&requests.length>6?T:A}});
    if(path===`repos/example/product/git/commits/${A}`)return JSON.stringify({sha:A,tree:{sha:T}});
    if(path===`repos/example/product/git/trees/${T}?recursive=1`)return JSON.stringify({truncated,tree:[{path:'state.json',mode,type:'blob',sha:blobSha}]});
    if(path===`repos/example/product/git/blobs/${blobSha}`)return JSON.stringify({sha:blobSha,encoding:'base64',content:bytes.toString('base64'),size:bytes.length});
    throw new Error('unexpected endpoint');
  };
  return {gh,state,requests,setMoved:()=>{moved=true;},setTruncated:()=>{truncated=true;},setLink:()=>{mode='120000';}};
}
const roots:string[]=[];
afterEach(async()=>{vi.clearAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it('reads frozen state blobs through GET only and never derives completion from the state cache',async()=>{
  const f=fixture();const result=await inspectNativeReleaseRecords('example/product',f.gh);
  expect(result.records).toHaveLength(1);expect(result).toMatchObject({repositoryId:1,stateHead:A,completion:{result:'UNKNOWN',reason:'NATIVE_EFFECT_RECONCILIATION_REQUIRED'}});
  expect(f.requests.every(args=>args[2]==='GET')).toBe(true);
});
it.each(['moved','truncated','symlink','unknown-schema','wrong-repository','phase-cache'])('keeps %s read-only and UNKNOWN',async mode=>{
  const f=fixture();if(mode==='moved')f.setMoved();if(mode==='truncated')f.setTruncated();if(mode==='symlink')f.setLink();
  if(mode==='unknown-schema')f.state.schemaVersion=3;if(mode==='wrong-repository')f.state.repositoryId=99;if(mode==='phase-cache')f.state.phase='COMPLETE';
  const result=await inspectNativeReleaseRecords('example/product',f.gh);expect(result.completion.result).toBe('UNKNOWN');expect(result.completion.reason).not.toBe('NATIVE_EFFECT_RECONCILIATION_REQUIRED');
  if(mode==='moved')expect(result.records).toHaveLength(1);
});
it.each([403,404,429,500])('does not treat native HTTP %i as empty state or zero failures',async code=>{
  const result=await inspectNativeReleaseRecords('example/product',async()=>{throw Object.assign(new Error(`secret-shaped fixture ${code}`),{status:code});});
  expect(result).toEqual({repository:'example/product',records:[],completion:{result:'UNKNOWN',reason:'NATIVE_STATE_READ_UNAVAILABLE'}});
});
it('routes the fixed read-only CLI before any legacy catalog and writes output exclusively',async()=>{
  const f=fixture();vi.mocked(nativeGhCommand).mockImplementation(f.gh);
  const root=await mkdtemp(join(tmpdir(),'release-inspect-'));roots.push(root);const output=join(root,'inspection.json');
  const args=['release','inspect','--repository','example/product','--output',output];
  expect(parseNativeInvocation(args).command).toBe('release inspect');await nativeReleaseCli(args);
  expect(JSON.parse(await readFile(output,'utf8')).completion.result).toBe('UNKNOWN');
  expect(f.requests.some(args=>args.join(' ').includes('catalog'))).toBe(false);
  await expect(nativeReleaseCli(args)).rejects.toMatchObject({code:'EEXIST'});
});
it('rejects arbitrary commands and repository traversal before transport',async()=>{
  expect(()=>parseNativeInvocation(['release','execute','--command','anything'])).toThrow('unknown command');
  const gh=vi.fn();await expect(inspectNativeReleaseRecords('example/..',gh)).rejects.toThrow('repository');expect(gh).not.toHaveBeenCalled();
});
