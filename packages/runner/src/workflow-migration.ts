import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

export interface WorkflowMigration {
  id: string; repositoryId: number; fullName: string; pullNumber: number; baseRef: string;
  expiresAt: string; from: string[]; workflows: Record<string, string>;
}
const equal = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
export function validateMigration(value: unknown): asserts value is WorkflowMigration {
  const m = value as WorkflowMigration;
  if (!m || m.id !== 'steward-253-workflows-v1' || m.repositoryId !== 1296724484 || m.fullName !== 'splrad/steward'
    || m.pullNumber !== 253 || m.baseRef !== 'main' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.expiresAt)
    || !Number.isFinite(Date.parse(m.expiresAt)) || !Array.isArray(m.from) || !m.from.length || new Set(m.from).size !== m.from.length
    || !m.workflows || typeof m.workflows !== 'object' || Array.isArray(m.workflows) || !Object.keys(m.workflows).length
    || [...m.from, ...Object.keys(m.workflows)].some(p => !/^\.github\/workflows\/[a-zA-Z0-9_-]+\.ya?ml$/.test(p))
    || Object.values(m.workflows).some(h => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h))) throw new Error('WORKFLOW_MIGRATION_INVALID');
}
export function authorizeMigration(m: WorkflowMigration, event: any, repositoryId: number, actual: string[], allowed: string[], now: number) {
  validateMigration(m);
  const p = event?.pull_request;
  if (!Number.isFinite(now) || now >= Date.parse(m.expiresAt) || repositoryId !== m.repositoryId
    || event?.repository?.id !== m.repositoryId || event?.repository?.full_name !== m.fullName
    || event?.number !== m.pullNumber || p?.number !== m.pullNumber || p?.base?.ref !== m.baseRef
    || p?.base?.repo?.id !== m.repositoryId || p?.head?.repo?.id !== m.repositoryId
    || !equal(allowed, m.from) || !equal(actual, Object.keys(m.workflows))) throw new Error('WORKFLOW_MIGRATION_NOT_AUTHORIZED');
}
// manifestPath belongs to the trusted policy checkout, never the candidate workspace.
export async function assertWorkflowMigration(manifestPath: string, workspace: string, repositoryId: number, actual: string[], allowed: string[]) {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || !process.env.GITHUB_EVENT_PATH) throw new Error('WORKFLOW_MIGRATION_EVENT');
  const m: unknown = JSON.parse(await readFile(manifestPath, 'utf8')); validateMigration(m);
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  authorizeMigration(m, event, repositoryId, actual, allowed, Date.now());
  // Hash committed blobs so Windows checkout line endings cannot change the authorization.
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', '.github/workflows'], { cwd: workspace, stdio: 'pipe' });
  for (const [path, digest] of Object.entries(m.workflows)) {
    const entry = execFileSync('git', ['ls-tree', 'HEAD', '--', path], { cwd: workspace, encoding: 'utf8' });
    if (!/^100644 blob [a-f0-9]{40}\t/.test(entry)) throw new Error('WORKFLOW_MIGRATION_MODE');
    const bytes = execFileSync('git', ['show', `HEAD:${path}`], { cwd: workspace });
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`WORKFLOW_MIGRATION_CONTENT: ${path}`);
  }
  return m.id;
}
