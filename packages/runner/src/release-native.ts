import { open, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { constants } from 'node:fs';
import { BuildContractError, decodeBuildJson } from '../../core/src/build-manifest.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { isolatedBuildEnvironment } from './build-environment.js';
import { type NativeVersionInspector, type NativeVersionResult } from './build-manifest.js';
import { releaseAssert } from '../../core/src/release-note-receipt.js';
export const nativeInspectionTimeoutMs = 120000;
/** Parse exact S bytes using the same trusted packaging runtime as wheel/sdist inspection. */
export async function nativePythonSourceVersion(controllerDirectory:string,bytes:Buffer,releaseVersion:string):Promise<string> {
  if(bytes.length>512*1024)throw new BuildContractError('RN_BUILD_LIMIT');
  const home=await mkdtemp(join(tmpdir(),'steward-python-version-'));
  try {
    const file=join(home,'pyproject.toml');await writeFile(file,bytes,{flag:'wx'});
    const python=resolve(controllerDirectory,'tools/template/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const result=await promisify(execFile)(python,['-I',resolve(controllerDirectory,'scripts/inspect-python-release.py'),'--source-version',file,releaseVersion],
      {env:isolatedBuildEnvironment(process.env,home),cwd:home,timeout:nativeInspectionTimeoutMs,maxBuffer:64*1024,windowsHide:true,encoding:'utf8'}).catch(error => {
        if (error.code === 2 && error.stdout?.trim() === '{"error":"RN_NATIVE_INVALID_ASSET"}') throw new BuildContractError('RN_BUILD_VERSION');
        throw error;
      });
    let value: any;
    try { value=JSON.parse(result.stdout.trim()); } catch { throw new BuildContractError('RN_BUILD_VERSION'); }
    if(!value||Object.keys(value).join(',')!=='version'||typeof value.version!=='string'||!value.version)throw new BuildContractError('RN_BUILD_VERSION');
    return value.version;
  } finally {await rm(home,{recursive:true,force:true});}
}
export function nativeReleaseInspector(script: string, home: string, platform: NodeJS.Platform = process.platform): NativeVersionInspector {
  const inspect: NativeVersionInspector = async () => { throw new Error('RN_NATIVE_PATH_REQUIRED'); };
  inspect.inspectPath = async path => {
    if (path.endsWith('.whl') || path.endsWith('.tar.gz')) {
      // The reviewed controller owns both the script and its existing uv project.
      // Inspection never resolves dependencies or executes code from the archive.
      const scripts = dirname(resolve(script));
      const python = join(scripts, '..', 'tools', 'template', '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      const result = await promisify(execFile)(python, ['-I', join(scripts, 'inspect-python-release.py'), path], {
        env: isolatedBuildEnvironment(process.env, home), cwd: home,
        timeout: nativeInspectionTimeoutMs, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8',
      }).catch(error => {
        if (error.code === 2 && error.stdout?.trim() === '{"error":"RN_NATIVE_INVALID_ASSET"}') throw new BuildContractError('RN_BUILD_VERSION');
        throw error;
      });
      let value: any;
      try { value = JSON.parse(result.stdout.trim()); } catch { throw new BuildContractError('RN_BUILD_VERSION'); }
      if (!value || Object.keys(value).length !== 1 || typeof value.version !== 'string' || !value.version) throw new BuildContractError('RN_BUILD_VERSION');
      return value.version;
    }
    if (/[\\/]package\.json$/.test(path)) {
      const limit = 512 * 1024;
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      let bytes: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new BuildContractError('RN_BUILD_LIMIT');
        const buffer = Buffer.alloc(limit + 1); let size = 0;
        while (size < buffer.length) {
          const read = await handle.read(buffer, size, buffer.length - size, size);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
        }
        if (size > limit) throw new BuildContractError('RN_BUILD_LIMIT');
        bytes = buffer.subarray(0, size);
      } finally { await handle.close(); }
      const metadata = decodeBuildJson(bytes) as any;
      if (!metadata || typeof metadata.name !== 'string' || typeof metadata.version !== 'string') throw new BuildContractError('RN_BUILD_VERSION');
      return metadata.version;
    }
    releaseAssert(platform === 'win32', 'NATIVE_FORMAT_UNSUPPORTED');
    const result = await promisify(execFile)('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-LiteralPath', path], {
      env: isolatedBuildEnvironment(process.env, home), timeout: nativeInspectionTimeoutMs, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8',
    }).catch(error => {
      if (error.code === 2 && error.stdout?.trim() === '{"error":"RN_NATIVE_INVALID_ASSET"}') throw new BuildContractError('RN_BUILD_VERSION');
      throw error;
    });
    let value: any;
    try { value = JSON.parse(result.stdout.trim()); } catch { throw new BuildContractError('RN_BUILD_VERSION'); }
    if (!value || Object.keys(value).length !== 1) throw new BuildContractError('RN_BUILD_VERSION');
    if (typeof value.version === 'string') return value.version;
    if (value.resourceOnly !== 'font-archive') throw new BuildContractError('RN_BUILD_VERSION');
    return value as NativeVersionResult;
  };
  return inspect;
}
