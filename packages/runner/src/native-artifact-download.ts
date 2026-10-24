import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isolatedBuildEnvironment } from './build-environment.js';

/** gh follows GitHub's authenticated artifact redirect; exact zip bytes are checked
 * before extraction, independently of download-artifact's warning semantics. */
export async function downloadNativeArtifact(input: { fullName: string; artifactId: number; digest: string; names: string[]; directory: string; policyDirectory: string; home: string }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.fullName) || !Number.isSafeInteger(input.artifactId) || input.artifactId < 1 || !/^sha256:[a-f0-9]{64}$/.test(input.digest)) throw new Error('ARTIFACT_DOWNLOAD_IDENTITY');
  await mkdir(input.home, { recursive: false });
  const archive = join(input.home, 'artifact.zip'), names = join(input.home, 'names.json');
  await writeFile(names, JSON.stringify(input.names), { flag: 'wx' });
  await writeFile(join(input.home, 'empty-gitconfig'), '', { flag: 'wx' });
  const child = spawn('gh', ['api', `repos/${input.fullName}/actions/artifacts/${input.artifactId}/zip`], {
    shell: false, windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
  });
  let bytes = 0; child.stderr!.resume();
  const limit = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(bytes >= 2 ** 31 ? new Error('ARTIFACT_DOWNLOAD_SIZE') : null, chunk); } });
  const completed = new Promise<void>((accept, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? accept() : reject(new Error('ARTIFACT_DOWNLOAD_FAILED'))); });
  try { await Promise.all([completed, pipeline(child.stdout!, limit, createWriteStream(archive, { flags: 'wx' }))]); }
  catch (error) { child.kill(); throw error; }
  await promisify(execFile)('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(input.policyDirectory, 'scripts/expand-release-artifact.ps1'),
    '-Archive', archive, '-ExpectedSha256', input.digest.slice(7), '-ExpectedNames', names, '-OutputDirectory', input.directory],
  { env: isolatedBuildEnvironment(process.env, input.home), timeout: 120_000, windowsHide: true });
}
