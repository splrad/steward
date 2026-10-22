import {releaseAssert,releaseDigest} from '../../core/src/release-note-receipt.js';
import {dispatchWorkflow,GitHubRequestError,ReleasePolicyDriftError,type GitHubClient} from '../../github/src/index.js';
/** Release only when the workflow POST is known not to have been accepted. */
export async function dispatchReleaseContinuation(client:()=>Promise<GitHubClient>, policySha:string, inputs:Record<string,string>, release:()=>Promise<unknown>, recovery?:{persist:()=>Promise<void>;clear:()=>Promise<void>;pause?:(ms:number)=>Promise<void>}):Promise<void>{
  let dispatchStarted=false;
  try {
    const gh=await client();dispatchStarted=true;
    await dispatchWorkflow(gh,{owner:'splrad',repo:'steward',workflow:'release.yml',policySha,inputs});
  }catch(error){
    const rejected=!dispatchStarted || error instanceof ReleasePolicyDriftError || error instanceof GitHubRequestError && (error.method==='GET'
      || error.method==='POST' && error.path==='/repos/splrad/steward/actions/workflows/release.yml/dispatches' && [400,401,403,404,422].includes(error.status));
    if(rejected || error instanceof Error && error.message==='中央仓库没有可用的默认分支') {
      await recovery?.persist();
      for(let attempt=0;;attempt++) {
        try { await release(); break; }
        catch(cleanupError) {
          if(attempt===2)throw new AggregateError([error,cleanupError],'GENERATION_CONTINUATION_CLEANUP_PENDING');
          await (recovery?.pause ?? (ms=>new Promise(resolve=>setTimeout(resolve,ms))))(1000*(attempt+1));
        }
      }
      await recovery?.clear();
    }
    throw error;
  }
}

export function validateContinuationRecovery(value:any, identity:{repositoryId:number;tag:string;policySha:string}) {
  releaseAssert(value?.version === 1 && value.reason === 'dispatch-not-accepted'
    && value.frozen?.repositoryId === identity.repositoryId && value.frozen?.targetTag === identity.tag
    && value.frozen?.policySha === identity.policySha && releaseDigest(value.graphDigest)
    && typeof value.reservation === 'string' && /^continuation:[0-9]+$/.test(value.reservation), 'GENERATION_RECOVERY');
  return value;
}
