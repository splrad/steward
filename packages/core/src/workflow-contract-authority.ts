import {parseWorkflowContract, type WorkflowContract} from './workflow-contract.js';
export interface ContractAuthority {repositoryId: number; baseline: WorkflowContract; approverIds: readonly number[]; adoptionPolicies?: Readonly<Record<string,string>>}
export function selectContractAuthority(value: unknown, repositoryId: number): ContractAuthority | null {
  const d = value as any;
  if (!d || d.version !== 1 || !d.repositories || typeof d.repositories !== 'object' || Array.isArray(d.repositories)
    || Object.keys(d).sort().join(',') !== 'repositories,version') throw new Error('CONTRACT_AUTHORITY: invalid configuration');
  // Validate all entries so malformed dormant authorities are not silently shipped.
  for (const [key, raw] of Object.entries(d.repositories)) {
    const a = raw as any;
    if (!/^[1-9][0-9]*$/.test(key) || !Number.isSafeInteger(Number(key)) || !a
      || !['approverIds,baseline','adoptionPolicies,approverIds,baseline'].includes(Object.keys(a).sort().join(','))
      || !Array.isArray(a.approverIds) || a.approverIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) <= 0)
      || new Set(a.approverIds).size !== a.approverIds.length || a.approverIds.length === 0)
      throw new Error('CONTRACT_AUTHORITY: explicit approvers required');
    if (parseWorkflowContract(a.baseline).repositoryId !== Number(key)) throw new Error('CONTRACT_AUTHORITY: repository mismatch');
    if (a.adoptionPolicies !== undefined && (!a.adoptionPolicies || typeof a.adoptionPolicies !== 'object' || Array.isArray(a.adoptionPolicies)
      || Object.keys(a.adoptionPolicies).length > 1000
      || Object.entries(a.adoptionPolicies).some(([digest,sha]) => !/^[a-f0-9]{64}$/.test(digest) || typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha))))
      throw new Error('CONTRACT_AUTHORITY: invalid adoption policy');
  }
  const a = d.repositories[String(repositoryId)];
  return a ? {repositoryId,baseline:parseWorkflowContract(a.baseline),approverIds:[...a.approverIds],
    ...(a.adoptionPolicies === undefined ? {} : {adoptionPolicies:{...a.adoptionPolicies}})} : null;
}
