/** Pure contract and review decisions. Authority and current facts are supplied by trusted adapters. */
export interface WorkflowContract {
  version: 1;
  repositoryId: number;
  fragments: 'required' | 'retired';
  sharedQueues: Record<string, string>;
}
export interface ContractBinding {
  repositoryId: number;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  policySha: string;
  contractDigest: string;
}
export interface ContractReview {
  id: number;
  userId: number;
  userType: string;
  commitId: string;
  state: string;
  body: string;
  submittedAt: string;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
function exact(v: Record<string, unknown>, keys: string[]) {
  if (Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) throw new Error('CONTRACT_SCHEMA: unknown or missing field');
}
export function parseWorkflowContract(value: unknown): WorkflowContract {
  if (!object(value)) throw new Error('CONTRACT_SCHEMA: object required');
  exact(value, ['version', 'repositoryId', 'fragments', 'sharedQueues']);
  if (value.version !== 1 || !id(value.repositoryId) || !['required', 'retired'].includes(String(value.fragments)) || !object(value.sharedQueues))
    throw new Error('CONTRACT_SCHEMA: unsupported contract');
  const queues: Record<string, string> = Object.create(null);
  if (Object.keys(value.sharedQueues).length > 100) throw new Error('CONTRACT_SCHEMA: too many queues');
  for (const [path, resource] of Object.entries(value.sharedQueues)) {
    if (!/^\.github\/workflows\/[a-zA-Z0-9_-]+\.ya?ml(?::[A-Za-z_][A-Za-z0-9_-]*)?$/.test(path) || typeof resource !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(resource))
      throw new Error('CONTRACT_SCHEMA: invalid queue declaration');
    queues[path] = resource;
  }
  return {version: 1, repositoryId: value.repositoryId, fragments: value.fragments as WorkflowContract['fragments'], sharedQueues: queues};
}
export function canonicalContract(value: WorkflowContract): string {
  const c = parseWorkflowContract(value);
  return JSON.stringify({...c, sharedQueues: Object.fromEntries(Object.entries(c.sharedQueues).sort(([a],[b]) => a.localeCompare(b, 'en')))});
}
export function contractApprovalText(binding: ContractBinding): string {
  if (!id(binding.repositoryId) || !id(binding.pullNumber) || !sha(binding.headSha) || !sha(binding.baseSha) || !sha(binding.policySha)
    || !/^[a-f0-9]{64}$/.test(binding.contractDigest)) throw new Error('CONTRACT_BINDING: invalid identity');
  return `workflow-contract-approval/v1\nrepository=${binding.repositoryId}\npull=${binding.pullNumber}\nhead=${binding.headSha}\nbase=${binding.baseSha}\npolicy=${binding.policySha}\ncontract=${binding.contractDigest}`;
}
export function requireContractApproval(input: {
  binding: ContractBinding; authorId: number; approverIds: readonly number[];
  reviews: readonly ContractReview[]; eligibleUserIds: readonly number[];
}): number {
  const expected = contractApprovalText(input.binding);
  if (!id(input.authorId) || input.approverIds.some(v => !id(v))) throw new Error('CONTRACT_AUTHORITY: invalid trusted identity');
  const latest = new Map<number, ContractReview>();
  for (const r of input.reviews) {
    if (!id(r.id) || !id(r.userId) || !Number.isFinite(Date.parse(r.submittedAt))) continue;
    // A later comment does not cancel an approval, but a later decision/dismissal does.
    if (!['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(r.state)) continue;
    const old = latest.get(r.userId);
    if (!old || Date.parse(r.submittedAt) > Date.parse(old.submittedAt)
      || (r.submittedAt === old.submittedAt && r.id > old.id)) latest.set(r.userId, r);
  }
  for (const r of latest.values()) {
    if (r.userType !== 'User' || r.userId === input.authorId || !input.approverIds.includes(r.userId)
      || !input.eligibleUserIds.includes(r.userId)) continue;
    if (r.state === 'APPROVED' && r.commitId === input.binding.headSha && r.body.trim() === expected) return r.id;
  }
  throw new Error('CONTRACT_APPROVAL_REQUIRED: current binding requires an authorized independent approval');
}
