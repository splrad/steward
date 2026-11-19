import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { releaseBodyMatches, type ReleaseBodySource } from '../src/release-body.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sources: ReleaseBodySource[] = [
  { repository: 'example/Desk', repositoryId: 8, releaseId: 25, sourceSha: 'a'.repeat(40), tag: 'v2.0.0', frozenDigest: hash('original') },
  { repository: 'another/server', repositoryId: 3, releaseId: 70, sourceSha: 'b'.repeat(40), tag: 'api/v7.1.0', frozenDigest: hash('baseline') },
];

function fixture(source: ReleaseBodySource, body = '下载工具包。\n') {
  const head = 'c'.repeat(40), path = `.release-notes/published/${source.releaseId}.md`;
  const binding = [source.repositoryId, source.releaseId, source.tag, source.sourceSha, source.frozenDigest];
  const bytes = Buffer.from(`<!-- release-body ${JSON.stringify(binding)} -->\n${body}`);
  const resources = new Map<string, any>([
    ['', { id: source.repositoryId, full_name: source.repository, default_branch: 'stable' }],
    ['branches/stable', { name: 'stable', protected: true, commit: { sha: head } }],
    [`commits?sha=${head}&path=${encodeURIComponent(path)}&per_page=1`, [{ sha: head, commit: { verification: { verified: true } } }]],
    [`contents/${path}?ref=${head}`, { type: 'file', path, size: bytes.length, encoding: 'base64',
      content: bytes.toString('base64'), sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }],
  ]);
  return { body, resources, read: async (path: string) => {
    if (!resources.has(path)) throw new Error('unavailable');
    return resources.get(path);
  } };
}

it.each(sources)('reads a signed product amendment from the adopted branch of $repository', async source => {
  const { body, read } = fixture(source);
  expect(await releaseBodyMatches(source, body, read)).toBe(true);
  expect(await releaseBodyMatches(source, body + 'x', read)).toBe(false);
  expect(await releaseBodyMatches({ ...source, tag: 'different' }, body, read)).toBe(false);
  expect(await releaseBodyMatches({ ...source, sourceSha: '9'.repeat(40) }, body, read)).toBe(false);
  expect(await releaseBodyMatches({ ...source, frozenDigest: hash('other frozen bytes') }, body, read)).toBe(false);
});
it('matches the frozen body without consulting current product configuration', async () => {
  const read = vi.fn();
  expect(await releaseBodyMatches(sources[0]!, 'original', read)).toBe(true);
  expect(read).not.toHaveBeenCalled();
});
it.each(['repository','unprotected','unsigned','unadopted','wrong-file'])('rejects %s amendment evidence', async kind => {
  const source = sources[0]!, { body, resources, read } = fixture(source);
  const [repo, branch, commits, file] = [...resources.values()];
  if (kind === 'repository') repo.id++;
  if (kind === 'unprotected') branch.protected = false;
  if (kind === 'unsigned') commits[0].commit.verification.verified = false;
  if (kind === 'unadopted') commits.length = 0;
  if (kind === 'wrong-file') file.path = 'different.md';
  expect(await releaseBodyMatches(source, body, read)).toBe(false);
});
