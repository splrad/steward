import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
import {assert} from './private-dependency-policy.mjs';
import {lifecycleReusable} from './private-lifecycle-policy.mjs';
const lockPath='.github/workflows/actions.lock';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export function assertActionInputs(doc,actions){
  for(const job of Object.values(doc.jobs??{}))for(const step of job.steps??[])if(step.uses){
    const uses=/^([\w.-]+\/[\w.-]+)(?:\/[^@]+)?@([a-f0-9]{40})$/.exec(step.uses);
    assert(uses&&actions.some(x=>x.repo===uses[1]&&x.sha===uses[2]),'ACTION_INPUT_UNCOVERED');
  }
}

// The loader must bind every byte to the allowed controller's exact ancestor SHA.
// Native verification receives its complete workflow directory and unedited lock.
export async function reusableActions(uses,{loadSource,verifyLock,inventory}){
  let files;const evidence={uses,stage:'source'};
  try{
    const nested=await lifecycleReusable(uses,async(sha,path)=>{
      evidence.sha=sha;files=await loadSource(sha);
      assert(files instanceof Map && files.has(path),'REUSABLE_SOURCE_INCOMPLETE');
      return files.get(path);
    });
    evidence.workflowSha256=digest(nested.bytes);evidence.stage='native-lock';
    const lock=files.get(lockPath);assert(lock,'REUSABLE_ACTION_LOCK_REQUIRED');
    evidence.lockSha256=digest(lock);
    const native=await verifyLock(files,nested.sha);
    evidence.stage='online-inventory';
    const actions=await inventory(lock.toString('utf8'));
    evidence.stage='workflow-coverage';
    assertActionInputs(YAML.parse(nested.bytes.toString('utf8')),actions);
    return {...nested,actions,lockSha256:evidence.lockSha256,native};
  }catch(error){error.reusableSource=evidence;throw error;}
}

export async function verifyReusableLock(files,directory,env,run){
  assert(files.has(lockPath),'REUSABLE_ACTION_LOCK_REQUIRED');
  for(const [path,bytes] of files){
    assert(path===lockPath||/^\.github\/workflows\/[^/\\]+\.ya?ml$/.test(path),'REUSABLE_LOCK_INPUT_PATH');
    await mkdir(join(directory,'.github/workflows'),{recursive:true});
    await writeFile(join(directory,path),bytes);
  }
  const result=run('gh',['actions-lock','--verify','--no-interactive'],directory,
    {...env,GH_HOST:'github.com',GH_REPO:'splrad/steward',GH_ACTIONS_LOCK_REPO_ROOT:directory});
  // --verify must never rewrite any supplied source byte, even on success.
  for(const [path,bytes] of files)assert((await readFile(join(directory,path))).equals(bytes),'REUSABLE_LOCK_INPUT_CHANGED');
  return {stdout:result.stdout,stderr:result.stderr};
}
