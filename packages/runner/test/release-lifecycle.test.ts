import { describe, expect, it, vi } from 'vitest';
import { candidatePaths, receiptDigest } from '../../core/src/release-note-receipt.js';
import { receiptFixture, sha } from '../../core/test/release-receipt-fixture.js';
import { GitHubRequestError } from '../../github/src/client.js';
import { createReleaseCandidate, verifyReleaseDownloads, releaseAssetTransferTimeout, type LifecycleSession } from '../src/release-lifecycle.js';

it('budgets a full 1 GiB transfer at 4 MiB/s plus setup and rejects out-of-contract sizes', () => {
  expect(releaseAssetTransferTimeout(1024 ** 3)).toBe(316_000);
  expect(releaseAssetTransferTimeout(1024)).toBe(61_000);
  for (const size of [0, -1, NaN, 1024 ** 3 + 1]) expect(() => releaseAssetTransferTimeout(size)).toThrow('ASSET_SIZE');
});

describe('candidate creation retry', () => {
  it.each(['branch', 'pull', 'revision'])('recovers %s without duplicating a candidate', async lost => {
    let reference: any = null, pull: any = null;
    const blobs: string[] = [];
    const session: LifecycleSession = { receipt: receiptFixture(), async act(action, fields = {}) {
      if (action === 'candidate-commit') this.receipt = { ...this.receipt, initialCommitSha: String(fields.sha) };
      if (action === 'bind') this.receipt = { ...this.receipt, pullNumber: Number(fields.pullNumber), phase: 'awaiting-review' };
      return this.receipt;
    } };
    if (lost === 'revision') session.receipt.candidateBase = { sha: sha('e'), tree: sha('f') };
    const gh = {
      createBlob: vi.fn(async (_o, _r, text) => { blobs.push(text); return { sha: sha('1') }; }),
      createTree: vi.fn(async (_o, _r, input) => { expect(input.tree.map((v: any) => v.path)).toEqual(candidatePaths(session.receipt)); expect(input.base_tree).toBe(sha(lost === 'revision' ? 'f' : 'b')); return { sha: sha('2') }; }),
      createCommit: vi.fn(async (_o, _r, input) => { expect(input.parents).toEqual([sha(lost === 'revision' ? 'e' : 'a')]); return { sha: sha('d') }; }),
      getRef: async () => { if (!reference) throw new GitHubRequestError(404, 'GET', '/ref', 'missing'); return reference; },
      createRef: vi.fn(async () => { reference = { object: { sha: sha('d') } }; if (lost === 'branch') throw new Error('lost'); return reference; }),
      listAllPullRequests: async () => pull ? [pull] : [],
      createPullRequest: vi.fn(async (_o, _r, input) => { pull = { number: 4, head: { ref: input.head, repo: { id: 9001 } } }; if (lost === 'pull') throw new Error('lost'); return pull; }),
    };
    expect((await createReleaseCandidate(gh as any, session)).pullNumber).toBe(4);
    await createReleaseCandidate(gh as any, session);
    expect(gh.createRef).toHaveBeenCalledTimes(1); expect(gh.createPullRequest).toHaveBeenCalledTimes(1); expect(blobs).toHaveLength(2);
  });
  it('never overwrites an occupied branch', async () => {
    const session = { receipt: { ...receiptFixture(), initialCommitSha: sha('d') }, act: vi.fn() };
    const gh = { getRef: async () => ({ object: { sha: sha('e') } }), createRef: vi.fn() };
    await expect(createReleaseCandidate(gh as any, session)).rejects.toThrow('BRANCH_OCCUPIED'); expect(gh.createRef).not.toHaveBeenCalled();
  });
});

describe('published asset download verification', () => {
  const r = () => { const receipt = receiptFixture(); receipt.frozen.assets = [{ name: 'app.zip', size: 3, sha256: receiptDigest('zip') }]; receipt.assetIds = { 'app.zip': 9 }; return receipt; };
  it('rehashes bytes and never forwards the token to a signed download host', async () => {
    const requests: { url: string; headers: Headers }[] = [];
    const transport = vi.fn(async (url: any, init: any) => {
      requests.push({ url: String(url), headers: new Headers(init.headers) });
      return requests.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset?signature=fixture' } }) : new Response('zip');
    });
    await verifyReleaseDownloads(r(), 'private-token', transport);
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer private-token'); expect(requests[1]!.headers.has('authorization')).toBe(false);
  });
  it.each(['wrong', 'zi', 'bad'])('rejects altered/truncated/oversized bytes %s', async bytes => {
    await expect(verifyReleaseDownloads(r(), 'token', vi.fn(async () => new Response(bytes)))).rejects.toThrow(/DOWNLOAD_(SIZE|DIGEST)/);
  });
  it('rejects foreign redirect destinations before fetching them', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/a' } }));
    await expect(verifyReleaseDownloads(r(), 'token', transport)).rejects.toThrow('DOWNLOAD_URL'); expect(transport).toHaveBeenCalledTimes(1);
  });
});
