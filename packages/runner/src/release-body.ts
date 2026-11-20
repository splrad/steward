import { createHash } from 'node:crypto';

export interface ReleaseBodySource {
  repository: string; repositoryId: number; releaseId: number; sourceSha: string; tag: string; frozenDigest: string | null;
}
type Read = (path: string) => Promise<any>;

/** An amendment lives with the product's reviewed notes. Only the protected default branch can adopt it. */
export async function releaseBodyMatches(source: ReleaseBodySource, body: unknown, read: Read): Promise<boolean> {
  if (typeof body !== 'string' || !source.frozenDigest) return false;
  if (createHash('sha256').update(body).digest('hex') === source.frozenDigest) return true;
  const repo = await read('');
  if (repo.id !== source.repositoryId || repo.full_name !== source.repository || !repo.default_branch) return false;
  const branch = await read(`branches/${encodeURIComponent(repo.default_branch)}`);
  const head = branch.commit?.sha;
  if (branch.name !== repo.default_branch || branch.protected !== true || !/^[a-f0-9]{40}$/.test(head)) return false;

  const path = `.release-notes/published/${source.releaseId}.md`;
  const commits = await read(`commits?sha=${head}&path=${encodeURIComponent(path)}&per_page=1`);
  if (!Array.isArray(commits) || commits.length !== 1 || commits[0]?.commit?.verification?.verified !== true
    || !/^[a-f0-9]{40}$/.test(commits[0].sha)) return false;
  // Read at the pinned default-branch tip, even if the same path was previously approved and later removed.
  const file = await read(`contents/${path}?ref=${head}`);
  if (head !== commits[0].sha) {
    const signed = await read(`contents/${path}?ref=${commits[0].sha}`);
    if (signed.path !== path || signed.sha !== file.sha || signed.type !== 'file') return false;
  }
  const binding = [source.repositoryId, source.releaseId, source.tag, source.sourceSha, source.frozenDigest];
  const expected = Buffer.from(`<!-- release-body ${JSON.stringify(binding)} -->\n${body}`);
  return file.type === 'file' && file.path === path && file.encoding === 'base64' && typeof file.content === 'string'
    && file.size === expected.length && file.sha === createHash('sha1').update(`blob ${expected.length}\0`).update(expected).digest('hex')
    && expected.equals(Buffer.from(file.content, 'base64'));
}
