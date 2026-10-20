import { decodeAuthoritySource } from '../../github/src/workflow-authority-source.js';
import { selectContractAuthority } from '../../core/src/workflow-contract-authority.js';
import type { GitHubClient } from '../../github/src/client.js';

/** Read-only deployment preflight. No migration or service write may precede it. */
export async function verifyWorkflowActivation(
  gh: Pick<GitHubClient, 'request'>, evaluatorSha: string,
  catalog: { organization: { login: string }; repositories: Record<string, { managed?: boolean }> },
): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(evaluatorSha)) throw new Error('WORKFLOW_EVALUATOR_SHA_REQUIRED');
  const file = await gh.request<any>('GET', `/repos/splrad/steward/contents/config/workflow-contract-authority.json?ref=${evaluatorSha}`);
  const authority = decodeAuthoritySource(file);
  const ids = new Set(Object.entries(catalog.repositories).filter(([, c]) => c.managed).map(([id]) => Number(id)));
  // The active organization rule covers repositories outside the explicit catalog too.
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error('CONTRACT_AUTHORITY_SCOPE_LIMIT');
    const repos = await gh.request<any[]>('GET', `/orgs/${catalog.organization.login}/repos?type=all&per_page=100&page=${page}`);
    if (!Array.isArray(repos)) throw new Error('CONTRACT_AUTHORITY_SCOPE');
    for (const repo of repos) {
      if (!Number.isSafeInteger(repo.id) || repo.id <= 0 || repo.owner?.login?.toLowerCase() !== catalog.organization.login.toLowerCase())
        throw new Error('CONTRACT_AUTHORITY_SCOPE');
      if (!repo.archived && !repo.disabled) ids.add(repo.id);
    }
    if (repos.length < 100) break;
  }
  if (!ids.size) throw new Error('CONTRACT_AUTHORITY_SCOPE');
  for (const id of ids) {
    const selected = selectContractAuthority(authority, id);
    if (!selected) throw new Error(`CONTRACT_AUTHORITY_REQUIRED: ${id}`);
    if (selected.baseline.fragments !== 'retired') throw new Error(`CONTRACT_CAPABILITY_UNAVAILABLE: ${id}`);
  }
}
