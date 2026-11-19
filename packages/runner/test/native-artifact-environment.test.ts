import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { downloadNativeArtifact } from '../src/native-artifact-download.js';

const extract = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: extract }),
}));
const roots: string[] = [];
const archive=Buffer.from('fixture archive'),digest='sha256:'+createHash('sha256').update(archive).digest('hex');
afterEach(async () => {
  extract.mockReset();vi.unstubAllEnvs();vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true});
});
async function input() {
  const root=await mkdtemp(join(tmpdir(),'artifact-environment-'));roots.push(root);
  return {fullName:'splrad/LayerScape',artifactId:42,digest,names:['app.exe'],directory:join(root,'output'),policyDirectory:process.cwd(),home:join(root,'home')};
}
it('uses only the selected token on the native API and no credentials on storage or extraction',async()=>{
  vi.stubEnv('GH_TOKEN','fixture-target');
  for (const key of ['STEWARD_APP_PRIVATE_KEY','GITHUB_TOKEN','POLICY_READ_TOKEN','COPILOT_GITHUB_TOKEN','HTTPS_PROXY']) vi.stubEnv(key,'sentinel-parent');
  const api='https://api.github.com/repos/splrad/LayerScape/actions/artifacts/42',storage='https://storage.blob.core.windows.net/archive';
  const fetcher=vi.fn(async(url:string|URL,init:RequestInit)=>{
    if(String(url)===storage) {
      expect(init.redirect).toBe('error');expect(init.headers).toBeUndefined();return new Response(archive);
    }
    const headers=new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer fixture-target');
    expect([...headers.values()]).not.toContain('sentinel-parent');
    if(String(url)===api+'/zip') {
      expect(init.redirect).toBe('manual');return new Response(null,{status:302,headers:{location:storage}});
    }
    expect(String(url)).toBe(api);expect(init.redirect).toBe('error');
    return Response.json({id:42,size_in_bytes:archive.length,digest,expired:false});
  });
  vi.stubGlobal('fetch',fetcher);
  extract.mockImplementation(async(command,args,options)=>{
    expect(command).toBe('pwsh');
    expect(Object.keys(options.env).filter(key=>/TOKEN|PRIVATE_KEY|PROXY/.test(key))).toEqual([]);
    expect(Object.values(options.env)).not.toContain('sentinel-parent');
    const out=args[args.indexOf('-OutputDirectory')+1];await mkdir(out);await writeFile(join(out,'app.exe'),'fixture');
  });
  await downloadNativeArtifact(await input());
  expect(fetcher).toHaveBeenCalledTimes(3);expect(extract).toHaveBeenCalledOnce();
});
it('rejects a missing token before creating the destination or sending a request',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  const request=await input();
  await expect(downloadNativeArtifact(request,'')).rejects.toThrow('ARTIFACT_DOWNLOAD_IDENTITY');
  await expect(stat(request.home)).rejects.toMatchObject({code:'ENOENT'});expect(fetcher).not.toHaveBeenCalled();
});
it('propagates a native API failure without extraction',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(null,{status:429})));
  await expect(downloadNativeArtifact(await input(),'fixture')).rejects.toThrow('ARTIFACT_DOWNLOAD_HTTP_429');
  expect(extract).not.toHaveBeenCalled();
});
