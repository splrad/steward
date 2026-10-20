import { createHash } from 'node:crypto';
import { canonicalContract, requireContractApproval, type WorkflowContract } from '../../core/src/workflow-contract.js';
import type { GitHubClient } from './client.js';

const digest = (value: WorkflowContract) => createHash('sha256').update(canonicalContract(value)).digest('hex');

/** Prove the last semantic base-contract change, rather than trusting a preseeded file. */
export async function verifyBaseContractAdoption(
  gh: GitHubClient, owner: string, repo: string, baseSha: string, policySha: string,
  authority: { repositoryId: number; approverIds: readonly number[] },
  baseline: WorkflowContract, readContract: (ref: string) => Promise<WorkflowContract>,
): Promise<void> {
  const commits = await gh.request<any[]>('GET', `/repos/${owner}/${repo}/commits?path=.github%2Fworkflow-contract.json&sha=${baseSha}&per_page=100`);
  if (!Array.isArray(commits)) throw new Error('CONTRACT_BASE_UNADOPTED');
  for (const commit of commits) {
    if (!/^[a-f0-9]{40}$/.test(commit.sha) || !Array.isArray(commit.parents)) throw new Error('CONTRACT_BASE_UNADOPTED');
    const current = await readContract(commit.sha);
    if (digest(current) !== digest(baseline)) throw new Error('CONTRACT_BASE_UNADOPTED');
    const parent = commit.parents[0]?.sha;
    // Formatting-only commits do not require a fresh contract approval.
    if (parent && digest(await readContract(parent)) === digest(baseline)) continue;
    const pulls = await gh.listPullsForCommit(owner, repo, commit.sha);
    for (const linked of pulls) {
      const pull = await gh.getPullRequest(owner, repo, linked.number);
      if (!pull.merged || pull.base?.repo?.id !== authority.repositoryId
        || !/^[a-f0-9]{40}$/.test(pull.merge_commit_sha)) continue;
      const ancestry = await gh.request<any>('GET', `/repos/${owner}/${repo}/compare/${pull.merge_commit_sha}...${baseSha}`);
      if (!['ahead', 'identical'].includes(ancestry.status) || digest(await readContract(pull.head.sha)) !== digest(baseline)) continue;
      const reviews = await gh.listPullRequestReviews(owner, repo, pull.number);
      const eligibleUserIds: number[] = [];
      for (const id of authority.approverIds) {
        const review = reviews.find(r => r.user?.id === id && r.user.type === 'User');
        if (!review || id === pull.user.id) continue;
        const permission = await gh.getCollaboratorPermission(owner, repo, review.user.login);
        if (permission.user?.id === id && ['write', 'maintain', 'admin'].includes(permission.permission)) eligibleUserIds.push(id);
      }
      try {
        requireContractApproval({
          binding: { repositoryId: authority.repositoryId, pullNumber: pull.number, headSha: pull.head.sha,
            baseSha: pull.base.sha, policySha, contractDigest: digest(baseline) },
          authorId: pull.user.id, approverIds: authority.approverIds, eligibleUserIds,
          reviews: reviews.map(r => ({ id: r.id, userId: r.user?.id, userType: r.user?.type,
            commitId: r.commit_id, state: r.state, body: r.body ?? '', submittedAt: r.submitted_at ?? '' })),
        });
        return;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('CONTRACT_APPROVAL_REQUIRED')) throw error;
      }
    }
    throw new Error('CONTRACT_BASE_UNADOPTED: last semantic change lacks an independent bound approval');
  }
  throw new Error('CONTRACT_BASE_UNADOPTED: adoption not found within 100 file commits');
}
