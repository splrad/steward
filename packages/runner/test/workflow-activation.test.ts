import { main } from '../src/index.js';
import { GitHubClient } from '../../github/src/client.js';
import * as auth from '../../github/src/app-auth.js';
import { expect, it, vi } from 'vitest';
import { verifyWorkflowActivation as verify, verifyWorkflowActivationWithApp } from '../src/workflow-activation.js';
const sha = 'a'.repeat(40);
const catalog = { organization: { id: 7, login: 'example' }, repositories: { '1': { managed: true } } };
const installation = { id: 8, app_id: 9, account: { id: 7, login: 'example' }, target_type: 'Organization', repository_selection: 'all', suspended_at: null };
function scope(gh: ReturnType<typeof client>) {
  return { appId: 9, installationId: 8, app: { request: vi.fn(async (): Promise<any> => installation) },
    installation: { request: vi.fn(async (): Promise<any> => ({ total_count: gh.repos.length, repositories: gh.repos.map(repo => ({ ...repo, owner: { ...repo.owner, id: 7 } })) })) } };
}
function verifyWorkflowActivation(gh: ReturnType<typeof client>, evaluator: string, config: typeof catalog) {
  return verify(gh, evaluator, config, scope(gh));
}
const entry = (id: number) => ({ approverIds: [42], baseline: { version: 1, repositoryId: id, fragments: 'retired', sharedQueues: {} } });
function client(repositories: Record<string, unknown>, repos = [{ id: 1, owner: { login: 'example' } }]) {
  return { repos, request: vi.fn(async (_method: string, path: string): Promise<any> => path.includes('/contents/')
    ? { type: 'file', encoding: 'base64', size: Buffer.byteLength(JSON.stringify({ version: 1, repositories })), content: Buffer.from(JSON.stringify({ version: 1, repositories })).toString('base64') } : repos) };
}
it('reads authority only at the immutable evaluator and rejects an empty table', async () => {
  const gh = client({});
  await expect(verifyWorkflowActivation(gh, sha, catalog)).rejects.toThrow('CONTRACT_AUTHORITY_REQUIRED');
  expect(gh.request.mock.calls[0]?.[1]).toContain(`?ref=${sha}`);
});

it.each([{repository_selection:'selected'}, {suspended_at:'2026-01-01'}, {app_id:10}, {account:{id:8,login:'example'}}, {target_type:'User'}])('rejects an incomplete or wrong installation %j', async change => {
  const gh=client({'1':entry(1)}), proof=scope(gh);
  proof.app.request.mockResolvedValue({...installation,...change});
  await expect(verify(gh,sha,catalog,proof)).rejects.toThrow('CONTRACT_AUTHORITY_SCOPE');
  expect(proof.installation.request).not.toHaveBeenCalled();
});
it('rejects incomplete, duplicate and changing repository enumeration',async()=>{
  const gh=client({'1':entry(1)});
  for(const response of [ {total_count:2,repositories:[{id:1,owner:{id:7,login:'example'}}]}, {total_count:2,repositories:Array(2).fill({id:1,owner:{id:7,login:'example'}})}, {total_count:1,repositories:[{id:1,owner:{id:99,login:'example'}}]} ]){
    const proof=scope(gh);proof.installation.request.mockResolvedValue(response);
    await expect(verify(gh,sha,catalog,proof)).rejects.toThrow('CONTRACT_AUTHORITY_SCOPE');
  }
  const proof=scope(gh);proof.app.request.mockResolvedValueOnce(installation).mockResolvedValue({...installation,repository_selection:'selected'});
  await expect(verify(gh,sha,catalog,proof)).rejects.toThrow('CONTRACT_AUTHORITY_SCOPE');
});
it('requires authority for private repositories discovered by the installation token',async()=>{
  const gh=client({'1':entry(1)}),proof=scope(gh);
  proof.installation.request.mockResolvedValue({total_count:1,repositories:[{id:2,private:true,owner:{id:7,login:'example'}}]});
  await expect(verify(gh,sha,catalog,proof)).rejects.toThrow('CONTRACT_AUTHORITY_REQUIRED: 2');
});
it('reads every installation page and rejects changing totals',async()=>{
  const entries=Object.fromEntries(Array.from({length:101},(_,i)=>[String(i+1),entry(i+1)]));
  const repos=Array.from({length:101},(_,i)=>({id:i+1,owner:{id:7,login:'example'}}));
  const gh=client(entries),proof=scope(gh);
  proof.installation.request.mockResolvedValueOnce({total_count:101,repositories:repos.slice(0,100)}).mockResolvedValueOnce({total_count:101,repositories:repos.slice(100)});
  await expect(verify(gh,sha,catalog,proof)).resolves.toBeUndefined();
  expect(proof.installation.request).toHaveBeenCalledTimes(2);
  proof.installation.request.mockResolvedValueOnce({total_count:101,repositories:repos.slice(0,100)}).mockResolvedValueOnce({total_count:102,repositories:repos.slice(100)});
  await expect(verify(gh,sha,catalog,proof)).rejects.toThrow('CONTRACT_AUTHORITY_SCOPE');
});
it('creates only an unrestricted metadata-read installation token for inventory',async()=>{
  const jwt=vi.spyOn(auth,'createAppJwt').mockResolvedValue('fixture-jwt');
  const request=vi.spyOn(GitHubClient.prototype,'request').mockImplementation(async(method,path,body):Promise<any>=>{
    if(method==='POST') {expect(body).toEqual({permissions:{metadata:'read'}});return {token:'fixture-token'};}
    if(path==='/app/installations/8') return installation;
    if(path.startsWith('/installation/repositories')) return {total_count:1,repositories:[{id:1,owner:{id:7,login:'example'}}]};
    throw new Error('unexpected request');
  });
  try {await expect(verifyWorkflowActivationWithApp(client({'1':entry(1)}),sha,catalog,{appId:'9',installationId:8,privateKey:'fixture'})).resolves.toBeUndefined();}
  finally {request.mockRestore();jwt.mockRestore();}
});
it('requires coverage for newly discovered repositories as well as the trusted catalog', async () => {
  const gh = client({ '1': entry(1) }, [{ id: 2, owner: { login: 'example' } }]);
  await expect(verifyWorkflowActivation(gh, sha, catalog)).rejects.toThrow('CONTRACT_AUTHORITY_REQUIRED: 2');
  await expect(verifyWorkflowActivation(client({ '1': entry(1), '2': entry(2) }, [{ id: 2, owner: { login: 'example' } }]), sha, catalog)).resolves.toBeUndefined();
});
it('fails before reads on an invalid evaluator and propagates authority-read failure', async () => {
  const gh = client({});
  await expect(verifyWorkflowActivation(gh, 'main', catalog)).rejects.toThrow('WORKFLOW_EVALUATOR_SHA_REQUIRED');
  expect(gh.request).not.toHaveBeenCalled();
  gh.request.mockRejectedValue(new Error('403'));
  await expect(verifyWorkflowActivation(gh, sha, catalog)).rejects.toThrow('403');
});
it('does not activate unsupported fragments or an empty approver list', async () => {
  await expect(verifyWorkflowActivation(client({ '1': { ...entry(1), approverIds: [] } }), sha, catalog)).rejects.toThrow('explicit approvers');
  await expect(verifyWorkflowActivation(client({ '1': { ...entry(1), baseline: { ...entry(1).baseline, fragments: 'required' } } }), sha, catalog)).rejects.toThrow('CONTRACT_CAPABILITY_UNAVAILABLE');
});

it.each([{size:65537},{size:0},{size:undefined},{type:'symlink'}])('rejects runtime-incompatible authority metadata before activation %j',async change=>{
 const gh=client({'1':entry(1)});
 gh.request.mockResolvedValueOnce({type:'file',encoding:'base64',size:2,content:Buffer.from('{}').toString('base64'),...change});
 await expect(verifyWorkflowActivation(gh,sha,catalog)).rejects.toThrow('CONTRACT_EVALUATOR_SOURCE');
});
it('rejects decoded authority beyond 64 KiB even if the encoded body is below 1 MiB',async()=>{
 const gh=client({'1':entry(1)}),text=JSON.stringify({version:1,repositories:{'1':entry(1)}})+' '.repeat(65536);
 gh.request.mockResolvedValueOnce({type:'file',encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')});
 await expect(verifyWorkflowActivation(gh,sha,catalog)).rejects.toThrow('CONTRACT_EVALUATOR_SOURCE');
});

it('does not normalize the deployment variable only inside the preflight CLI',async()=>{
 vi.stubEnv('STEWARD_CONFIG_DIRECTORY','config');
 vi.stubEnv('WORKFLOW_EVALUATOR_SHA','A'.repeat(40));vi.stubEnv('WORKFLOW_ACTIVATION_READ_TOKEN','test-only');
 const request=vi.spyOn(GitHubClient.prototype,'request').mockRejectedValue(new Error('unexpected API read'));
 try {await expect(main(['verify-workflow-activation'])).rejects.toThrow('WORKFLOW_EVALUATOR_SHA_REQUIRED');expect(request).not.toHaveBeenCalled();}
 finally {request.mockRestore();vi.unstubAllEnvs();}
});
