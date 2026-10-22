import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {canonicalContract, parseWorkflowContract, requireContractApproval, type ContractBinding, type ContractReview, type WorkflowContract} from '../../core/src/workflow-contract.js';

export const workflowContractPath = '.github/workflow-contract.json';
export const contractDigest = (contract: WorkflowContract) => createHash('sha256').update(canonicalContract(contract)).digest('hex');
export interface TrustedContractPolicy { repositoryId: number; baseline: WorkflowContract; approverIds: readonly number[] }
export interface ContractFacts {
  repositoryId: number; pullNumber: number; headSha: string; baseSha: string; policySha: string;
  authorId: number; open: boolean; defaultBranchTarget: boolean;
}
export interface ContractReader {
  facts(): Promise<ContractFacts>;
  reviews(): Promise<readonly ContractReview[]>;
  eligibleUserIds(ids: readonly number[]): Promise<readonly number[]>;
}
export async function readWorkflowContract(workspace: string): Promise<WorkflowContract | null> {
  for (const part of ['.github', workflowContractPath]) {
    try {
      const info = await lstat(join(workspace, part));
      if (info.isSymbolicLink() || (part === '.github' ? !info.isDirectory() : !info.isFile())) throw new Error('CONTRACT_FILE: regular path required');
      if (part === workflowContractPath && info.size > 65536) throw new Error('CONTRACT_FILE: too large');
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  return parseWorkflowContract(JSON.parse(await readFile(join(workspace, workflowContractPath), 'utf8')));
}
export async function authorizeWorkflowContract(candidate: WorkflowContract, policy: TrustedContractPolicy, reader: ContractReader) {
  const baseline = parseWorkflowContract(policy.baseline);
  candidate = parseWorkflowContract(candidate);
  if (candidate.repositoryId !== policy.repositoryId || baseline.repositoryId !== policy.repositoryId) throw new Error('CONTRACT_REPOSITORY: mismatch');
  const before = await reader.facts();
  if (!before.open || !before.defaultBranchTarget || before.repositoryId !== policy.repositoryId) throw new Error('CONTRACT_SOURCE: invalid pull');
  const binding: ContractBinding = {repositoryId: before.repositoryId, pullNumber: before.pullNumber, headSha: before.headSha,
    baseSha: before.baseSha, policySha: before.policySha, contractDigest: contractDigest(candidate)};
  let reviewId: number | null = null;
  if (contractDigest(baseline) !== binding.contractDigest) {
    const reviews = await reader.reviews();
    const eligibleUserIds = await reader.eligibleUserIds(policy.approverIds);
    reviewId = requireContractApproval({binding, authorId: before.authorId, approverIds: policy.approverIds, reviews, eligibleUserIds});
  }
  const after = await reader.facts();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('CONTRACT_SOURCE_STALE: pull changed during evaluation');
  return {contract: candidate, binding, reviewId};
}
