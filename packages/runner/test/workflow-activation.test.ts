import { expect, it, vi } from 'vitest';
import { verifyWorkflowActivation } from '../src/workflow-activation.js';
const sha = 'a'.repeat(40);
const catalog = { organization: { login: 'example' }, repositories: { '1': { managed: true } } };
const entry = (id: number) => ({ approverIds: [42], baseline: { version: 1, repositoryId: id, fragments: 'retired', sharedQueues: {} } });
function client(repositories: Record<string, unknown>, repos = [{ id: 1, owner: { login: 'example' } }]) {
  return { request: vi.fn(async (_method: string, path: string): Promise<any> => path.includes('/contents/')
    ? { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ version: 1, repositories })).toString('base64') } : repos) };
}
it('reads authority only at the immutable evaluator and rejects an empty table', async () => {
  const gh = client({});
  await expect(verifyWorkflowActivation(gh, sha, catalog)).rejects.toThrow('CONTRACT_AUTHORITY_REQUIRED');
  expect(gh.request.mock.calls[0]?.[1]).toContain(`?ref=${sha}`);
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
