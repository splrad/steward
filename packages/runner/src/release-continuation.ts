import {dispatchWorkflow,GitHubRequestError,type GitHubClient} from '../../github/src/index.js';
/** Release only when the workflow POST is known not to have been accepted. */
export async function dispatchReleaseContinuation(client:()=>Promise<GitHubClient>, policySha:string, inputs:Record<string,string>, release:()=>Promise<unknown>):Promise<void>{
  let dispatchStarted=false;
  try {
    const gh=await client();dispatchStarted=true;
    await dispatchWorkflow(gh,{owner:'splrad',repo:'steward',workflow:'release.yml',policySha,inputs});
  }catch(error){
    const rejected=!dispatchStarted || error instanceof GitHubRequestError && (error.method==='GET'
      || error.method==='POST' && error.path==='/repos/splrad/steward/actions/workflows/release.yml/dispatches' && [400,401,403,404,422].includes(error.status));
    if(rejected || error instanceof Error && error.message==='中央仓库没有可用的默认分支')await release();
    throw error;
  }
}
