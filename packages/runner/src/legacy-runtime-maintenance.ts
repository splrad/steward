import { createHash } from 'node:crypto';
import { canonicalContract, parseWorkflowContract } from '../../core/src/workflow-contract.js';
import type { GitHubClient } from '../../github/src/client.js';
import type { WorkflowContractAuthority } from '../../github/src/workflow-contract.js';

const base = 'e990eda24ef7099264dada118b3e7ddfad883cea';
export const legacyRuntimeMaintenanceBranch = 'maintenance/legacy-runtime-e990eda';
const headBranch = 'codex/legacy-runtime-retirement-20261108';
const allowedPaths = new Set([
  'packages/runtime/src/index.ts', 'packages/runtime/src/pr-body-api.ts',
  'packages/runtime/src/release-api.ts', 'packages/runtime/src/release-build-api.ts',
  'packages/runtime/src/release-retirement.ts', 'packages/runtime/wrangler.toml',
  'packages/runtime/test/index.test.ts', 'packages/runtime/test/pr-body-api.test.ts',
  'packages/runtime/test/release-events.test.ts', 'packages/runtime/test/release-retirement.test.ts',
  'packages/runner/src/index.ts', 'packages/runner/src/legacy-runtime-maintenance.ts',
  'packages/runner/test/legacy-runtime-maintenance.test.ts', 'packages/runner/dist/index.js',
  'scripts/deploy-legacy-runtime.mjs', 'scripts/verify-legacy-runtime-retirement.mjs', 'packages/runner/test/legacy-runtime-retirement-probe.test.ts',
]);
function requireEvidence(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`LEGACY_MAINTENANCE_SOURCE: ${reason}`);
}
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const identity = (p: any) => JSON.stringify([p.number, p.state, p.base?.repo?.id, p.base?.ref, p.base?.sha, p.head?.repo?.id, p.head?.ref, p.head?.sha, p.user?.id, p.changed_files]);

/** One historical maintenance PR; the general default-branch contract is unchanged. */
export async function evaluateLegacyRuntimeMaintenance(gh: GitHubClient, authority: WorkflowContractAuthority, pullNumber: number, policySha: string) {
  requireEvidence(authority.repositoryId === 1296724484 && pullNumber === 307, 'repository/pull');
  const repository = await gh.getRepositoryById(authority.repositoryId);
  requireEvidence(repository.id === 1296724484 && repository.full_name === 'splrad/steward' && repository.default_branch === 'main', 'repository identity');
  const readPull = () => gh.getPullRequest('splrad', 'steward', pullNumber);
  const pull = await readPull();
  requireEvidence(pull.number === 307 && pull.state === 'open' && pull.user?.id === 44151430
    && pull.base?.repo?.id === repository.id && pull.base.ref === legacyRuntimeMaintenanceBranch && pull.base.sha === base
    && pull.head?.repo?.id === repository.id && pull.head.ref === headBranch && sha(pull.head.sha)
    && sha(policySha), 'pull identity');
  const readMerge = () => gh.getRef('splrad', 'steward', 'pull/307/merge');
  requireEvidence((await readMerge()).object?.sha === policySha, 'merge ref');
  const readHead = () => gh.getRef('splrad', 'steward', `heads/${headBranch}`);
  requireEvidence((await readHead()).object?.sha === pull.head.sha, 'head moved');
  const readBase = () => gh.getRef('splrad', 'steward', `heads/${legacyRuntimeMaintenanceBranch}`);
  requireEvidence((await readBase()).object?.sha === base, 'base moved');
  const commit = await gh.getCommit('splrad', 'steward', pull.head.sha);
  requireEvidence(commit.sha === pull.head.sha && commit.commit?.verification?.verified === true
    && commit.commit.verification.reason === 'valid', 'unsigned head');
  const merge = await gh.getCommit('splrad', 'steward', policySha);
  requireEvidence(merge.sha === policySha && Array.isArray(merge.parents) && merge.parents.length === 2
    && merge.parents[0]?.sha === base && merge.parents[1]?.sha === pull.head.sha, 'merge parents');
  const files = await gh.listPullFiles('splrad', 'steward', pullNumber);
  requireEvidence(Number.isSafeInteger(pull.changed_files) && pull.changed_files > 0
    && files.length === pull.changed_files && files.length <= allowedPaths.size
    && new Set(files.map((f: any) => f.filename)).size === files.length, 'incomplete files');
  requireEvidence(files.every((f: any) => allowedPaths.has(f.filename)
    && ['added', 'modified'].includes(f.status) && f.previous_filename === undefined), 'path outside maintenance scope');
  const readContract = async (ref: string) => {
    const file = await gh.getContent('splrad', 'steward', '.github/workflow-contract.json', ref);
    requireEvidence(file.type === 'file' && file.encoding === 'base64' && typeof file.content === 'string'
      && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 65536, 'contract file');
    const bytes = Buffer.from(file.content, 'base64');
    requireEvidence(bytes.length === file.size, 'contract bytes');
    return { bytes, contract: parseWorkflowContract(JSON.parse(bytes.toString('utf8'))) };
  };
  const original = await readContract(base), candidate = await readContract(pull.head.sha);
  requireEvidence(original.bytes.equals(candidate.bytes) && candidate.contract.repositoryId === repository.id
    && createHash('sha256').update(original.bytes).digest('hex') === '62eebf1ee8940d4491ca7cf55ba7900ea32e24da531855f4a1f120c9c64f5f0a', 'contract changed');
  requireEvidence(identity(pull) === identity(await readPull()) && (await readBase()).object?.sha === base
    && (await readHead()).object?.sha === pull.head.sha && (await readMerge()).object?.sha === policySha, 'source changed during evaluation');
  return { contract: candidate.contract, binding: { repositoryId: repository.id, pullNumber, headSha: pull.head.sha,
    baseSha: base, policySha, contractDigest: createHash('sha256').update(canonicalContract(candidate.contract)).digest('hex') }, reviewId: null };
}
