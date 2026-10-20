import {GitHubClient,createInstallationToken} from '../../github/src/index.js';
import {decodeAuthoritySource} from '../../github/src/workflow-authority-source.js';
export interface EvaluatorEnvironment {WORKFLOW_EVALUATOR_SHA?:string;POLICY_SHA:string;APP_ID:string;INSTALLATION_ID:string;STEWARD_APP_PRIVATE_KEY?:string}
export function evaluatorSha(env:EvaluatorEnvironment):string {
 const value=env.WORKFLOW_EVALUATOR_SHA ?? env.POLICY_SHA;
 if(!/^[a-f0-9]{40}$/.test(value))throw new Error('CONTRACT_EVALUATOR_SHA: immutable source required');return value;
}
export async function readEvaluatorAuthorities(gh:Pick<GitHubClient,'getContent'>,sha:string):Promise<{version:1;repositories:Record<string,unknown>}>{
 if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('CONTRACT_EVALUATOR_SHA');
 const file=await gh.getContent('splrad','steward','config/workflow-contract-authority.json',sha);
 return decodeAuthoritySource(file);
}
export async function trustedContractAuthorities(env:EvaluatorEnvironment):Promise<{version:1;repositories:Record<string,unknown>}>{
 if(env.WORKFLOW_EVALUATOR_SHA===undefined)return {version:1,repositories:{}};
 const sha=evaluatorSha(env);if(!env.STEWARD_APP_PRIVATE_KEY)throw new Error('CONTRACT_EVALUATOR_CREDENTIALS');
 const token=await createInstallationToken({appId:env.APP_ID,privateKey:env.STEWARD_APP_PRIVATE_KEY,installationId:Number(env.INSTALLATION_ID),repositoryId:1296724484,permissions:{contents:'read',metadata:'read'},policySha:env.POLICY_SHA});
 return readEvaluatorAuthorities(new GitHubClient(token,'https://api.github.com',fetch,env.POLICY_SHA),sha);
}
