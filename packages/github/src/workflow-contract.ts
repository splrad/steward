import { verifyBaseContractAdoption } from './workflow-contract-adoption.js';
import {createHash} from 'node:crypto';
import {canonicalContract, contractApprovalText, parseWorkflowContract, requireContractApproval, type WorkflowContract, type ContractBinding} from '../../core/src/workflow-contract.js';
import {GitHubClient, GitHubRequestError} from './client.js';

export interface WorkflowContractAuthority {
  repositoryId: number;
  baseline: WorkflowContract;
  approverIds: readonly number[];
  adoptionPolicies?: Readonly<Record<string,string>>;
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
  const readContract = async (ref: string, sourceOwner = owner, sourceName = name): Promise<WorkflowContract> => {
   try {
    const file = await gh.getContent(sourceOwner, sourceName, path, ref);
    if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || file.size > 65536)
      throw new Error('CONTRACT_FILE: invalid remote file');
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.length > 65536) throw new Error('CONTRACT_FILE: too large');
    return parseWorkflowContract(JSON.parse(bytes.toString('utf8')));
  } catch (e) {
    if (!(e instanceof GitHubRequestError) || e.status !== 404) throw e;
    // A contents 404 can hide a permissions failure. Prove absence in the exact
    // commit's readable, non-truncated trees before inheriting the baseline.
    const commit = await gh.getCommit(sourceOwner, sourceName, ref);
    if (commit.sha !== ref || !/^[a-f0-9]{40}$/.test(commit.commit?.tree?.sha ?? ''))
      throw new Error('CONTRACT_FILE: unreadable source commit');
    const readTree = async (sha: string) => {
      const tree = await gh.request<any>('GET', `/repos/${sourceOwner}/${sourceName}/git/trees/${sha}`);
      if (tree.sha !== sha || tree.truncated !== false || !Array.isArray(tree.tree)
        || tree.tree.some((entry: any) => typeof entry.path !== 'string' || !entry.path || entry.path.includes('/')))
        throw new Error('CONTRACT_FILE: incomplete source tree');
      return tree.tree as { path: string; type: string; sha: string }[];
    };
    const root = await readTree(commit.commit.tree.sha);
    const directory = root.filter(entry => entry.path === '.github');
    if (directory.length) {
      if (directory.length !== 1 || directory[0]!.type !== 'tree' || !/^[a-f0-9]{40}$/.test(directory[0]!.sha))
        throw new Error('CONTRACT_FILE: invalid declaration directory');
      if ((await readTree(directory[0]!.sha)).some(entry => entry.path === 'workflow-contract.json'))
        throw new Error('CONTRACT_FILE: declaration exists but contents are unreadable');
    }
    // Removing a declaration restores only the trusted baseline, never an empty policy.
    return parseWorkflowContract(authority.baseline);
   }
  };
  // A contract already adopted on the protected base is the baseline for the
  // next PR. Otherwise every later business change would need reapproval.
  const baseline = await readContract(pull.base.sha);
  if (digest(baseline) !== digest(authority.baseline))
    await verifyBaseContractAdoption(gh, owner, name, repo.default_branch, pull.base.sha, policySha, authority, baseline, readContract);
  let candidateOwner = owner, candidateName = name;
  if (!Number.isSafeInteger(pull.head?.repo?.id) || pull.head.repo.id <= 0) throw new Error('CONTRACT_SOURCE: missing head repository');
  if (pull.head.repo.id !== repo.id) {
    const headRepo = await gh.getRepositoryById(pull.head.repo.id);
    if (headRepo.id !== pull.head.repo.id || !/^[^/]+\/[^/]+$/.test(headRepo.full_name)) throw new Error('CONTRACT_SOURCE: invalid head repository');
    [candidateOwner, candidateName] = headRepo.full_name.split('/') as [string,string];
  }
  const candidate = await readContract(pull.head.sha, candidateOwner, candidateName);
  if (candidate.repositoryId !== repo.id || baseline.repositoryId !== repo.id || authority.baseline.repositoryId !== repo.id) throw new Error('CONTRACT_REPOSITORY: mismatch');
  const binding: ContractBinding = {repositoryId: repo.id,pullNumber,headSha: pull.head.sha,baseSha: pull.base.sha,policySha,contractDigest: digest(candidate)};
  const approvalText = contractApprovalText(binding); // Validate identities even without an approval requirement.
  let reviewId: number | null = null;
  const readApproval = async (): Promise<number> => {
    const raw = await gh.listPullRequestReviews(owner, name, pullNumber);
    const reviews = raw.map(r => ({id:r.id,userId:r.user?.id,userType:r.user?.type,commitId:r.commit_id,state:r.state,body:r.body ?? '',submittedAt:r.submitted_at ?? ''}));
    const eligibleUserIds: number[] = [];
    for (const userId of [...new Set(authority.approverIds)]) {
      const review = raw.find(r => r.user?.id === userId && r.user?.type === 'User');
      if (!review || userId === pull.user.id) continue;
      const permission = await gh.getCollaboratorPermission(owner, name, review.user.login);
      if (permission.user?.id === userId && ['admin','write','maintain'].includes(permission.permission)) eligibleUserIds.push(userId);
    }
    try { return requireContractApproval({binding,authorId:pull.user.id,approverIds:authority.approverIds,reviews,eligibleUserIds}); }
    catch (e) {
      if (e instanceof Error && e.message.startsWith('CONTRACT_APPROVAL_REQUIRED')) throw new Error(`${e.message}\n${approvalText}`);
      throw e;
    }
  };
  const changed = digest(baseline) !== binding.contractDigest;
  if (changed) reviewId = await readApproval();
  if (identity(pull) !== identity(await readPull())) throw new Error('CONTRACT_SOURCE_STALE: pull changed during evaluation');
  // Re-read mutable review state and collaborator permissions after the identity
  // check; an approval dismissed while this evaluation ran must not be reused.
  if (changed) reviewId = await readApproval();
  return {contract:candidate,binding,reviewId};
}
