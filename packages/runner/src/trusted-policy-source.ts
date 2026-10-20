import { appendFile } from 'node:fs/promises';
import { GitHubClient } from '../../github/src/index.js';
export interface PolicySource { repositoryId: number; fullName: string; healthUrl: string; deploymentWorkflow: string; organizationId:number; appId:number }
// Compiled into the reviewed evaluator, never read from candidate declarations.
export const policySources: readonly PolicySource[] = [{repositoryId:1296724484,fullName:'splrad/steward',healthUrl:'https://splrad-steward-runtime.alearner-5ef.workers.dev/health',deploymentWorkflow:'.github/workflows/deploy-runtime.yml',organizationId:302208797,appId:4243096}];
const requireFact = (value: unknown): void => { if (!value) throw new Error('POLICY_SOURCE_UNTRUSTED'); };
export async function resolveTrustedPolicy(source: PolicySource, gh: Pick<GitHubClient,'request'>, transport: typeof fetch, event: string, runId?: number): Promise<string> {
  requireFact(['workflow_dispatch','workflow_run','schedule'].includes(event));
  const health = async () => { const response = await transport(source.healthUrl,{redirect:'error',signal:AbortSignal.timeout(15000)}); requireFact(response.ok); requireFact(response.body); const reader=response.body!.getReader();const chunks:Uint8Array[]=[];let size=0;try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;requireFact(size<=16384);chunks.push(part.value);}}finally{await reader.cancel();} const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requireFact(body.status==='ok' && body.secretsReady===true && body.organizationId===source.organizationId && body.appId===source.appId && /^[a-f0-9]{40}$/.test(body.policySha)); return body.policySha as string; };
  const sha = await health();
  const repository = await gh.request<any>('GET',`/repositories/${source.repositoryId}`);
  requireFact(repository.id === source.repositoryId && repository.full_name === source.fullName && repository.owner?.id === source.organizationId && !repository.fork && !repository.archived && !repository.disabled);
  const head = await gh.request<any>('GET',`/repos/${source.fullName}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
  requireFact(/^[a-f0-9]{40}$/.test(head.object?.sha));
  const comparison = await gh.request<any>('GET',`/repos/${source.fullName}/compare/${sha}...${head.object.sha}`);
  requireFact(['ahead','identical'].includes(comparison.status) && comparison.merge_base_commit?.sha === sha);
  if(event === 'workflow_run') {
    requireFact(Number.isSafeInteger(runId) && Number(runId)>0);
    const run = await gh.request<any>('GET',`/repos/${source.fullName}/actions/runs/${runId}`);
    requireFact(run.id === runId && run.repository?.id === source.repositoryId && run.head_repository?.id === source.repositoryId && run.path === source.deploymentWorkflow && run.event === 'push' && run.head_branch === repository.default_branch && run.head_sha === sha && run.status === 'completed' && run.conclusion === 'success');
  }
  requireFact(await health() === sha);
  return sha;
}
export async function trustedPolicyCommand(): Promise<void> {
  const id = Number(process.env.GITHUB_REPOSITORY_ID), source = policySources.find(s=>s.repositoryId===id);
  requireFact(source && process.env.POLICY_SOURCE_READ_TOKEN);
  const token = process.env.POLICY_SOURCE_READ_TOKEN!; delete process.env.POLICY_SOURCE_READ_TOKEN;
  const client = new GitHubClient(token);
  const repository = await client.request<any>('GET',`/repositories/${id}`);
  requireFact(process.env.GITHUB_REF === 'refs/heads/'+repository.default_branch);
  const sha = await resolveTrustedPolicy(source!,client,fetch,process.env.GITHUB_EVENT_NAME ?? '',Number(process.env.POLICY_SOURCE_RUN_ID));
  requireFact(!process.env.POLICY_SOURCE_EXPECTED_SHA || process.env.POLICY_SOURCE_EXPECTED_SHA === sha);
  requireFact(process.env.GITHUB_OUTPUT);
  await appendFile(process.env.GITHUB_OUTPUT!,`policy_sha=${sha}\n`);
}
