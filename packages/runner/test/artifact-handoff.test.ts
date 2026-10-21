import {artifactDownloadTimeout} from '../src/artifact-handoff.js';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fetchBoundArtifactFile} from '../src/artifact-handoff.js';
import {describe,it,expect,vi} from 'vitest';
import {archiveDigest,type ArtifactBinding} from '../src/artifact-handoff.js';
import {zip} from './fixtures/artifact-envelope.js';
async function fetchBoundArtifact(gh:any,transport:typeof fetch,token:string,b:ArtifactBinding){const home=await mkdtemp(join(tmpdir(),'artifact-test-'));try{const value=await fetchBoundArtifactFile(gh,transport,token,b,join(home,'archive'));return await readFile(value.path);}finally{await rm(home,{recursive:true,force:true});}}
const b:ArtifactBinding={repositoryId:42,fullName:'example/project',workflowPath:'.github/workflows/build.yml',policySha:'a'.repeat(40),runId:7,attempt:2,artifactId:9,artifactName:'result-2'};
function fixture(){const bytes=zip();const run={id:7,repository:{id:42},head_repository:{id:42},head_sha:b.policySha,path:b.workflowPath,event:'workflow_dispatch',run_attempt:2,status:'completed',conclusion:'success'};const artifact={id:9,name:'result-2',expired:false,workflow_run:{id:7,head_sha:b.policySha},digest:'sha256:'+archiveDigest(bytes),size_in_bytes:bytes.length};const request=vi.fn(async(_m:string,p:string)=>p.includes('/artifacts?')?{total_count:1,artifacts:[artifact]}:p.includes('/runs/')?run:artifact);const transport=vi.fn(async(_u:any,init:any)=>init.redirect==='manual'?new Response(null,{status:302,headers:{location:'https://storage.blob.core.windows.net/result'}}):new Response(bytes));return {bytes,run,artifact,gh:{request} as any,transport:transport as any};}
describe('artifact run/attempt and immutable bytes',()=>{
 it('rechecks run and never forwards token to blob storage',async()=>{const f=fixture();expect(await fetchBoundArtifact(f.gh,f.transport,'secret',b)).toEqual(f.bytes);expect(f.gh.request).toHaveBeenCalledTimes(4);expect(f.transport.mock.calls[1][1].headers).toBeUndefined()});
 it.each([{run_attempt:3},{head_sha:'b'.repeat(40)},{head_repository:{id:1}},{event:'pull_request'},{conclusion:'failure'},{path:'.github/workflows/other.yml'}])('rejects stale or untrusted run %j',async change=>{const f=fixture();Object.assign(f.run,change);await expect(fetchBoundArtifact(f.gh,f.transport,'secret',b)).rejects.toThrow()});
 it.each([{expired:true},{name:'result-1'},{digest:'sha256:'+'0'.repeat(64)},{workflow_run:{id:8,head_sha:b.policySha}}])('rejects wrong artifact %j',async change=>{const f=fixture();Object.assign(f.artifact,change);await expect(fetchBoundArtifact(f.gh,f.transport,'secret',b)).rejects.toThrow()});
 it('rejects attempt changing during download',async()=>{const f=fixture();f.transport.mockImplementation(async(_u:any,init:any)=>{if(init.redirect==='manual')return new Response(null,{status:302,headers:{location:'https://storage.blob.core.windows.net/result'}});f.run.run_attempt=3;return new Response(f.bytes)});await expect(fetchBoundArtifact(f.gh,f.transport,'secret',b)).rejects.toThrow()});
 it('rejects an arbitrary download host',async()=>{const f=fixture();f.transport.mockResolvedValue(new Response(null,{status:302,headers:{location:'https://evil.example/archive'}}));await expect(fetchBoundArtifact(f.gh,f.transport,'secret',b)).rejects.toThrow()});
});


it('rejects duplicate matching artifacts rather than selecting one',async()=>{const f=fixture(),original=f.gh.request.getMockImplementation();f.gh.request.mockImplementation(async(m:string,p:string)=>p.includes('/artifacts?')?{total_count:2,artifacts:[f.artifact,{...f.artifact,id:10}]}:original(m,p));await expect(fetchBoundArtifact(f.gh,f.transport,'secret',b)).rejects.toThrow()});

it('streams verified archive bytes to a fresh file',async()=>{const f=fixture(),home=await mkdtemp(join(tmpdir(),'handoff-file-'));try{const result=await fetchBoundArtifactFile(f.gh,f.transport,'secret',b,join(home,'archive'));expect(await readFile(result.path)).toEqual(f.bytes);expect(result.digest).toBe(archiveDigest(f.bytes));expect(f.transport.mock.calls[1][1].headers).toBeUndefined();}finally{await rm(home,{recursive:true,force:true});}});

it('budgets the largest permitted archive at 4 MiB/s plus setup time',()=>{expect(artifactDownloadTimeout(4*1024**3+16*1024**2)).toBe(1088000);expect(artifactDownloadTimeout(1)).toBe(61000);expect(()=>artifactDownloadTimeout(4*1024**3+16*1024**2+1)).toThrow();});

it.each(['digest','stream','recheck'])('cleans its own failed %s download and permits retry',async kind=>{
 const f=fixture(),home=await mkdtemp(join(tmpdir(),'handoff-retry-')),target=join(home,'archive');
 const original=f.transport.getMockImplementation();
 try {
  if(kind==='digest')f.artifact.digest='sha256:'+'0'.repeat(64);
  else f.transport.mockImplementation(async(u:any,init:any)=>{
   if(init.redirect==='manual')return original(u,init);
   if(kind==='recheck'){f.run.run_attempt=3;return new Response(f.bytes);}
   return new Response(new ReadableStream({start(controller){controller.error(Error('stream failed'));}}));
  });
  await expect(fetchBoundArtifactFile(f.gh,f.transport,'secret',b,target)).rejects.toThrow();
  await expect(readFile(target)).rejects.toMatchObject({code:'ENOENT'});
  f.artifact.digest='sha256:'+archiveDigest(f.bytes);f.run.run_attempt=2;f.transport.mockImplementation(original);
  await fetchBoundArtifactFile(f.gh,f.transport,'secret',b,target);expect(await readFile(target)).toEqual(f.bytes);
 }finally{await rm(home,{recursive:true,force:true});}
});
it('preserves a pre-existing download destination',async()=>{
 const f=fixture(),home=await mkdtemp(join(tmpdir(),'handoff-existing-')),target=join(home,'archive');
 try{await writeFile(target,'user data');await expect(fetchBoundArtifactFile(f.gh,f.transport,'secret',b,target)).rejects.toMatchObject({code:'EEXIST'});expect(await readFile(target,'utf8')).toBe('user data');}finally{await rm(home,{recursive:true,force:true});}
});
