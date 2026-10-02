import type { RawClassificationFacts } from '../../core/src/index.js';

export function classificationFacts(repositoryId: number, pullRequestNumber: number, pull: any, files: readonly any[], commits: readonly any[]): RawClassificationFacts {
  const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  if (pull.number !== pullRequestNumber || pull.base?.repo?.id !== repositoryId
    || !sha(pull.head?.sha) || !sha(pull.base?.sha) || !text(pull.head?.ref) || !text(pull.base?.ref)
    || !Number.isSafeInteger(pull.head?.repo?.id) || pull.head.repo.id < 1
    || !text(pull.user?.login) || !['User', 'Bot', 'Organization', 'Mannequin'].includes(pull.user?.type)
    || !files.length || !commits.length || pull.changed_files !== files.length || pull.commits !== commits.length
    || new Set(files.map(file => file.filename)).size !== files.length || new Set(commits.map(commit => commit.sha)).size !== commits.length
    || files.some(file => !text(file.filename) || !text(file.status) || !count(file.additions) || !count(file.deletions)
      || (file.previous_filename !== undefined && !text(file.previous_filename)))
    || commits.some(commit => !sha(commit.sha) || typeof commit.commit?.message !== 'string')) throw new Error('classification-facts-incomplete');
  return {
    repositoryId, pullRequestNumber, sourceRepositoryId: pull.head.repo.id, sourceRef: `refs/heads/${pull.head.ref}`,
    targetRef: `refs/heads/${pull.base.ref}`, author: { login: pull.user.login, type: pull.user.type },
    headSha: pull.head.sha, baseSha: pull.base.sha,
    commits: commits.map(commit => ({ sha: commit.sha, message: commit.commit.message })),
    files: files.map(file => ({ path: file.filename, ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
      status: file.status, additions: file.additions, deletions: file.deletions, patch: typeof file.patch === 'string' ? file.patch : null,
      patchState: typeof file.patch === 'string' ? 'available' as const : 'missing' as const })),
  };
}
