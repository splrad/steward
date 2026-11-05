import { afterEach, expect, it, vi } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ghReleaseFixture } from './gh-release-fixture.js';
import { evidenceFixture, digest } from './native-evidence-fixture.js';
import { pipelineChannelDownload } from '../src/release-pipeline.js';
import { nativeReleaseDownload, releaseReadIsAnonymous } from '../src/gh-release.js';
import { formalReleaseReader, nativeEvidenceTransport } from '../src/native-release-evidence.js';
const roots:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();for(const path of roots.splice(0))await rm(path,{recursive:true,force:true});});
it.each([false,true])('central formal object reader chooses native visibility without credential fallback; private=%s',async isPrivate=>{
  const calls:(string|null)[]=[],f=evidenceFixture();
  const io=nativeEvidenceTransport('fixture-app-read',async(url:any,init:any)=>{
    const credential=new Headers(init.headers).get('authorization');calls.push(credential);
    if(String(url)==='https://api.github.com/repos/example/product')return new Response(JSON.stringify({id:1,full_name:'example/product',private:isPrivate,archived:false,disabled:false}));
    expect(credential).toBe(isPrivate?'Bearer fixture-app-read':null);
    return new Response('not authorized',{status:403});
  });
  const reader=await formalReleaseReader(f.context,io);
  await expect(reader.downloadDigest('releases/assets/10')).rejects.toThrow('NATIVE_HTTP_403');
  expect(calls).toHaveLength(2);
});
it.each([false,true])('channel consumption downloads and verifies all seven formal assets; private=%s',async isPrivate=>{
  const f=await ghReleaseFixture(),root=await mkdtemp(join(tmpdir(),'release-visibility-'));roots.push(root);
  await f.preload();f.state.private=isPrivate;
  Object.assign(f.release,{draft:false,immutable:true,body:await readFile(join(f.target.directory,'release-notes.md'),'utf8')});
  const manifest=f.target.manifest,cycle=evidenceFixture().context.cycle,manifestDigest=digest(await readFile(join(f.target.directory,'artifact-manifest.json')));
  Object.assign(cycle,{sourceSha:manifest.sourceSha,controllerSha:manifest.schemaVersion===3?manifest.controllerSha:manifest.policySha,
    units:[{id:'app',version:'1.2.3',tag:'v1.2.3',releaseId:20,manifestDigest,notesDigest:digest(f.release.body),
      assets:[...f.remote].map(([path,a])=>({id:path,path,size:a.bytes.length,sha256:digest(a.bytes)}))}],requiredChannels:[{unitId:'app',channelId:'ghcr-assets'}]});
  const context={repository:'fixture/product',repositoryId:1,appBotId:42,cycle};
  expect(await pipelineChannelDownload(context,{unitId:'app',channelId:'ghcr-assets',version:'1.2.3',releaseId:20,manifestDigest},join(root,'download'),f.gh,f.download)).toEqual(manifest);
  expect(f.downloads).toHaveLength(14);expect(f.downloads.every(value=>value.anonymous===!isPrivate)).toBe(true);
  expect(f.calls.some(args=>args.includes('--method'))).toBe(false);
});
it.each([{}, {id:2,private:false}, {id:1,private:null}, {id:1,private:'false'}])('rejects missing or mismatched native visibility: %j',async fields=>{
  await expect(releaseReadIsAnonymous(async()=>JSON.stringify({full_name:'fixture/product',archived:false,disabled:false,...fields}),'fixture/product',1)).rejects.toThrow('repository visibility');
});
it.each([true,false])('private asset authorization and redirect credential boundary; anonymous=%s',async anonymous=>{
  const calls:{url:string;authorization:string|null}[]=[],root=await mkdtemp(join(tmpdir(),'private-download-'));roots.push(root);
  vi.stubGlobal('fetch',async(url:string|URL,init:any)=>{
    calls.push({url:String(url),authorization:new Headers(init?.headers).get('authorization')});
    if(String(url).startsWith('https://api.github.com/'))return anonymous?new Response('denied',{status:404}):new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/fixture/file'}});
    return new Response('verified bytes');
  });
  const result=nativeReleaseDownload('fixture-read-token')('fixture/product',10,join(root,'asset'),anonymous);
  if(anonymous){await expect(result).rejects.toThrow('download HTTP 404');expect(calls).toHaveLength(1);expect(calls[0]!.authorization).toBeNull();}
  else {await result;expect(calls[0]!.authorization).toBe('Bearer fixture-read-token');expect(calls[1]!.authorization).toBeNull();expect(await readFile(join(root,'asset'),'utf8')).toBe('verified bytes');}
});
