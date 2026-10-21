import { readFile, stat } from 'node:fs/promises';
import { BuildContractError, decodeBuildJson } from '../../core/src/build-manifest.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedBuildEnvironment } from './release-build.js';
import { type NativeVersionInspector, type NativeVersionResult } from './build-manifest.js';
import { releaseAssert } from '../../core/src/release-note-receipt.js';
export const nativeInspectionTimeoutMs = 120000;
export function nativeReleaseInspector(script: string, home: string, platform: NodeJS.Platform = process.platform): NativeVersionInspector {
  const inspect: NativeVersionInspector = async () => { throw new Error('RN_NATIVE_PATH_REQUIRED'); };
  inspect.inspectPath = async path => {
    if (/[\\/]package\.json$/.test(path)) {
      if ((await stat(path)).size > 512 * 1024) throw new BuildContractError('RN_BUILD_LIMIT');
      const metadata = decodeBuildJson(await readFile(path)) as any;
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
