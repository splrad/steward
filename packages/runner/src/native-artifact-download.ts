import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, copyFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedBuildEnvironment } from './build-environment.js';
import { artifactDownloadTimeout, downloadArtifactArchive } from './artifact-handoff.js';

interface ArtifactDownloadInput {
  fullName:string;artifactId:number;digest:string;names:string[];directory:string;policyDirectory:string;home:string;allowSubset?:boolean;
}

export async function downloadWorkflowArtifact(input:Omit<ArtifactDownloadInput,'names'|'allowSubset'>,token?:string) {
  await expandArtifact({...input,names:[]},token,true);
}

export async function downloadNativeArtifact(input:ArtifactDownloadInput,token: string | undefined = process.env.GH_TOKEN) {
  await expandArtifact(input,token,false);
}

async function expandArtifact(input:ArtifactDownloadInput,token:string|undefined,discoverNames:boolean) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(input.fullName) || input.fullName.split('/').some(part => part === '.' || part === '..')
    || !Number.isSafeInteger(input.artifactId) || input.artifactId < 1 || !/^sha256:[a-f0-9]{64}$/.test(input.digest)) throw new Error('ARTIFACT_DOWNLOAD_IDENTITY');
  const response = await fetch(`https://api.github.com/repos/${input.fullName}/actions/artifacts/${input.artifactId}`, {
    headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error('ARTIFACT_DOWNLOAD_HTTP_' + response.status);
  const metadata = await response.json();
  if (metadata.id !== input.artifactId || metadata.expired !== false || metadata.digest !== input.digest) throw new Error('ARTIFACT_DOWNLOAD_IDENTITY');
  const timeout = artifactDownloadTimeout(metadata.size_in_bytes);
  await mkdir(input.home, { recursive: true });
  const scratch = await mkdtemp(join(input.home, 'download-'));
  try {
    const archive = join(scratch, 'artifact.zip'), names = join(scratch, 'names.json');
    await downloadArtifactArchive(fetch, token, input.fullName, input.artifactId, metadata.size_in_bytes, input.digest, archive, async () => {});
    await writeFile(names, JSON.stringify(input.names), { flag: 'wx' });
    await promisify(execFile)('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(input.policyDirectory, 'scripts/expand-release-artifact.ps1'),
      '-Archive', archive, '-ExpectedSha256', input.digest.slice(7), '-ExpectedNames', names, '-OutputDirectory', join(scratch, 'extracted'),
      ...(input.allowSubset ? ['-AllowSubset'] : []),...(discoverNames?['-DiscoverNames']:[])],
    { env: isolatedBuildEnvironment(process.env, scratch), timeout, windowsHide: true });
    await mkdir(input.directory);
    try {
      const selected = (await readdir(join(scratch,'extracted'))).sort();
      for (const name of selected) await copyFile(join(scratch,'extracted',name),join(input.directory,name),constants.COPYFILE_EXCL);
    } catch (error) {
      await rm(input.directory,{recursive:true,force:true});
      throw error;
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
