import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';

// PR307 preserved the deployed policy's workflow bytes. These regression inputs
// remain historical; normal maintenance workflows use the central native scanners.
export async function legacyWorkflowFixture() {
  const source='21be466b5689a0b8df76249eb1c9249359a6d57a';
  const git=(...args:string[])=>execFileSync('git',['--no-replace-objects',...args],{encoding:'utf8',windowsHide:true});
  const root=await mkdtemp(join(tmpdir(),'legacy-workflow-fixture-'));
  const files=git('ls-tree','-r','--name-only',source,'--','.github/workflows').trim().split('\n');
  files.push('config/repositories.json','.github/workflow-contract.json');
  for (const file of files) {
    if (!/^(?:\.github\/workflows\/[\w.-]+\.ya?ml|config\/repositories\.json|\.github\/workflow-contract\.json)$/.test(file)) throw Error('Unexpected historical fixture path');
    const target=join(root,file);await mkdir(dirname(target),{recursive:true});
    await writeFile(target,git('show',`${source}:${file}`));
  }
  return {root,cleanup:()=>rm(root,{recursive:true,force:true})};
}

export function readLegacyWorkflow(name:string) {
  if (!/^[\w.-]+\.ya?ml$/.test(name)) throw Error('Unexpected historical workflow name');
  return execFileSync('git',['--no-replace-objects','show',`21be466b5689a0b8df76249eb1c9249359a6d57a:.github/workflows/${name}`],{encoding:'utf8',windowsHide:true});
}
