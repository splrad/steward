import {createHash} from 'node:crypto';
import {canonicalContract, contractApprovalText, parseWorkflowContract, requireContractApproval, type WorkflowContract, type ContractBinding} from '../../core/src/workflow-contract.js';
import {GitHubClient, GitHubRequestError} from './client.js';

export interface WorkflowContractAuthority {
  repositoryId: number;
  baseline: WorkflowContract;
  approverIds: readonly number[];
}
const path = '.github/workflow-contract.json';
const digest = (value: WorkflowContract) => createHash('sha256').update(canonicalContract(value)).digest('hex');
export async function evaluateRemoteWorkflowContract(gh: GitHubClient, authority: WorkflowContractAuthority, pullNumber: number, policySha: string) {
  const repo = await gh.getRepositoryById(authority.repositoryId);
  if (repo.id !== authority.repositoryId || !/^[^/]+\/[^/]+$/.test(repo.full_name)) throw new Error('CONTRACT_REPOSITORY: mismatch');
  const [owner, name] = repo.full_name.split('/') as [string, string];
  const readPull = () => gh.getPullRequest(owner, name, pullNumber);
  const pull = await readPull();
  const identity = (p: any) => JSON.stringify([p.number,p.state,p.base?.repo?.id,p.base?.ref,p.base?.sha,p.head?.repo?.id,p.head?.sha,p.user?.id]);
  if (pull.number !== pullNumber || pull.state !== 'open' || pull.base?.repo?.id !== repo.id || pull.base.ref !== repo.default_branch)
    throw new Error('CONTRACT_SOURCE: invalid pull');
  const readContract = async (ref: string): Promise<WorkflowContract> => {
   try {
    const file = await gh.getContent(owner, name, path, ref);
    if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || file.size > 65536)
      throw new Error('CONTRACT_FILE: invalid remote file');
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.length > 65536) throw new Error('CONTRACT_FILE: too large');
    return parseWorkflowContract(JSON.parse(bytes.toString('utf8')));
  } catch (e) {
    if (!(e instanceof GitHubRequestError) || e.status !== 404) throw e;
    // Removing a declaration restores only the trusted baseline, never an empty policy.
    return parseWorkflowContract(authority.baseline);
   }
  }
  // A contract already adopted on the protected base is the baseline for the
  // next PR. Otherwise every later business change would need reapproval.
  const baseline = await readContract(pull.base.sha);
  const candidate = await readContract(pull.head.sha);
  if (candidate.repositoryId !== repo.id || baseline.repositoryId !== repo.id || authority.baseline.repositoryId !== repo.id) throw new Error('CONTRACT_REPOSITORY: mismatch');
  const binding: ContractBinding = {repositoryId: repo.id,pullNumber,headSha: pull.head.sha,baseSha: pull.base.sha,policySha,contractDigest: digest(candidate)};
  const approvalText = contractApprovalText(binding); // Validate identities even without an approval requirement.
  let reviewId: number | null = null;
  if (digest(baseline) !== binding.contractDigest) {
    const raw = await gh.listPullRequestReviews(owner, name, pullNumber);
    const reviews = raw.map(r => ({id:r.id,userId:r.user?.id,userType:r.user?.type,commitId:r.commit_id,state:r.state,body:r.body ?? '',submittedAt:r.submitted_at ?? ''}));
    const eligibleUserIds: number[] = [];
    for (const userId of [...new Set(authority.approverIds)]) {
      const review = raw.find(r => r.user?.id === userId && r.user?.type === 'User');
      if (!review || userId === pull.user.id) continue;
      const permission = await gh.getCollaboratorPermission(owner, name, review.user.login);
      if (permission.user?.id === userId && ['admin','write','maintain'].includes(permission.permission)) eligibleUserIds.push(userId);
    }
    try { reviewId = requireContractApproval({binding,authorId:pull.user.id,approverIds:authority.approverIds,reviews,eligibleUserIds}); }
    catch (e) {
      if (e instanceof Error && e.message.startsWith('CONTRACT_APPROVAL_REQUIRED')) throw new Error(`${e.message}\n${approvalText}`);
      throw e;
    }
  }
  if (identity(pull) !== identity(await readPull())) throw new Error('CONTRACT_SOURCE_STALE: pull changed during evaluation');
  return {contract:candidate,binding,reviewId};
}
