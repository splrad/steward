import { readFile, stat } from 'node:fs/promises';
import { decodeBuildJson } from '../../core/src/build-manifest.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedBuildEnvironment } from './release-build.js';
import { type NativeVersionInspector, type NativeVersionResult } from './build-manifest.js';
import { releaseAssert } from '../../core/src/release-note-receipt.js';
export function nativeReleaseInspector(script: string, home: string, platform: NodeJS.Platform = process.platform): NativeVersionInspector {
  const inspect: NativeVersionInspector = async () => { throw new Error('RN_NATIVE_PATH_REQUIRED'); };
  inspect.inspectPath = async path => {
    if (/[\\/]package\.json$/.test(path)) {
      releaseAssert((await stat(path)).size <= 512 * 1024, 'NATIVE_RESULT');
      const metadata = decodeBuildJson(await readFile(path)) as any;
      releaseAssert(metadata && typeof metadata.name === 'string' && typeof metadata.version === 'string', 'NATIVE_RESULT');
      return metadata.version;
    }
    releaseAssert(platform === 'win32', 'NATIVE_FORMAT_UNSUPPORTED');
    const result = await promisify(execFile)('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-LiteralPath', path], {
      env: isolatedBuildEnvironment(process.env, home), timeout: 120000, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8',
    });
    const value = JSON.parse(result.stdout.trim());
    releaseAssert(value && Object.keys(value).length === 1, 'NATIVE_RESULT');
    if (typeof value.version === 'string') return value.version;
    releaseAssert(value.resourceOnly === 'font-archive', 'NATIVE_RESULT');
    return value as NativeVersionResult;
  };
  return inspect;
}
