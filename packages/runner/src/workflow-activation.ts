import { decodeAuthoritySource } from '../../github/src/workflow-authority-source.js';
import { selectContractAuthority } from '../../core/src/workflow-contract-authority.js';
import { GitHubClient } from '../../github/src/client.js';
import { createAppJwt } from '../../github/src/app-auth.js';

type Scope = { app: Pick<GitHubClient, 'request'>; installation: Pick<GitHubClient, 'request'>; appId: number; installationId: number };
type Catalog = { organization: { id: number; login: string }; repositories: Record<string, { managed?: boolean }> };

export async function verifyWorkflowActivationWithApp(
  gh: Pick<GitHubClient, 'request'>, evaluatorSha: string, catalog: Catalog,
  credentials: { appId: string; installationId: number; privateKey: string },
): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(evaluatorSha)) throw new Error('WORKFLOW_EVALUATOR_SHA_REQUIRED');
  const appId = Number(credentials.appId);
  if (!Number.isSafeInteger(appId) || appId <= 0 || !Number.isSafeInteger(credentials.installationId) || credentials.installationId <= 0)
    throw new Error('CONTRACT_AUTHORITY_SCOPE');
  const app = new GitHubClient(await createAppJwt(credentials.appId, credentials.privateKey));
  // No repository filter: this metadata-only token must cover the entire installation.
  const result = await app.request<{ token: string }>('POST', `/app/installations/${credentials.installationId}/access_tokens`, { permissions: { metadata: 'read' } });
  if (!result.token) throw new Error('CONTRACT_AUTHORITY_SCOPE');
  await verifyWorkflowActivation(gh, evaluatorSha, catalog, { app, installation: new GitHubClient(result.token), appId, installationId: credentials.installationId });
}

/** Read-only deployment preflight. No migration or service write may precede it. */
export async function verifyWorkflowActivation(
  gh: Pick<GitHubClient, 'request'>, evaluatorSha: string,
  catalog: Catalog, scope: Scope,
): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(evaluatorSha)) throw new Error('WORKFLOW_EVALUATOR_SHA_REQUIRED');
  const file = await gh.request<any>('GET', `/repos/splrad/steward/contents/config/workflow-contract-authority.json?ref=${evaluatorSha}`);
  const authority = decodeAuthoritySource(file);
  const ids = new Set(Object.entries(catalog.repositories).filter(([, c]) => c.managed).map(([id]) => Number(id)));
  const checkInstallation = async () => {
    const record = await scope.app.request<any>('GET', `/app/installations/${scope.installationId}`);
    if (record.id !== scope.installationId || record.app_id !== scope.appId || record.account?.id !== catalog.organization.id
      || record.account?.login?.toLowerCase() !== catalog.organization.login.toLowerCase() || record.target_type !== 'Organization'
      || record.repository_selection !== 'all' || record.suspended_at !== null)
      throw new Error('CONTRACT_AUTHORITY_SCOPE');
  };
  await checkInstallation();
  const seen = new Set<number>();
  let total: number | undefined;
  // The active organization rule covers repositories outside the explicit catalog too.
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error('CONTRACT_AUTHORITY_SCOPE_LIMIT');
    const result = await scope.installation.request<any>('GET', `/installation/repositories?per_page=100&page=${page}`);
    const repos = result.repositories;
    if (!Array.isArray(repos) || repos.length > 100 || !Number.isSafeInteger(result.total_count) || result.total_count < 0
      || (total !== undefined && total !== result.total_count)) throw new Error('CONTRACT_AUTHORITY_SCOPE');
    total = result.total_count;
    for (const repo of repos) {
      if (!Number.isSafeInteger(repo.id) || repo.id <= 0 || seen.has(repo.id) || repo.owner?.id !== catalog.organization.id
        || repo.owner?.login?.toLowerCase() !== catalog.organization.login.toLowerCase())
        throw new Error('CONTRACT_AUTHORITY_SCOPE');
      seen.add(repo.id);
      if (!repo.archived && !repo.disabled) ids.add(repo.id);
    }
    if (repos.length < 100) break;
  }
  if (seen.size !== total) throw new Error('CONTRACT_AUTHORITY_SCOPE');
  await checkInstallation();
  if (!ids.size) throw new Error('CONTRACT_AUTHORITY_SCOPE');
  for (const id of ids) {
    const selected = selectContractAuthority(authority, id);
    if (!selected) throw new Error(`CONTRACT_AUTHORITY_REQUIRED: ${id}`);
    if (selected.baseline.fragments !== 'retired') throw new Error(`CONTRACT_CAPABILITY_UNAVAILABLE: ${id}`);
  }
}
