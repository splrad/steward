import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertReleaseUnpaused, readReleasePauses } from '../release-pause-policy.mjs';

const repoId = 1187527897, otherId = 1296724484;
const main = 'a'.repeat(40), moved = 'b'.repeat(40);
const path = 'release-pauses.json';
function fixture() {
  const state = { bytes: Buffer.from('[1187527897]\n'), mode: '100644', present: true, protected: true,
    headAfter: main, actualId: 1447987054, contentSha: null, truncated: false, legacy: false };
  let branchReads = 0;
  const blob = () => createHash('sha1').update('blob ' + state.bytes.length + '\0').update(state.bytes).digest('hex');
  const api = { rest: {
    repos: {
      get: async ({ owner, repo }) => {
        assert.deepEqual([owner, repo], ['splrad', 'steward-settings']);
        return { data: { id: state.actualId, full_name: 'splrad/steward-settings', owner: { id: 302208797 },
          private: true, default_branch: 'main', archived: false, disabled: false } };
      },
      getBranch: async ({ branch }) => {
        assert.equal(branch, 'main');
        return { data: { name: 'main', protected: state.protected, commit: { sha: ++branchReads % 2 ? main : state.headAfter } } };
      },
      getContent: async options => {
        assert.equal(options.path, path);
        assert.equal(options.ref, main);
        return { data: { path, encoding: 'base64', type: 'file', sha: state.contentSha ?? blob(),
          size: state.bytes.length, content: state.bytes.toString('base64') } };
      },
    },
    git: { getTree: async ({ tree_sha }) => {
      assert.equal(tree_sha, main);
      const tree = state.legacy ? [{ path: 'repositories', type: 'tree', mode: '040000', sha: moved }] : [];
      if (state.present) tree.push({ path, type: 'blob', mode: state.mode, sha: blob() });
      return { data: { truncated: state.truncated, tree } };
    } },
  } };
  return { state, api };
}

test('applies a protected pause by repository ID and resumes the same request after the old registration tree is gone', async () => {
  const { state, api } = fixture();
  let reads = 0, claimed = 0;
  const app = { async forRepository(id, operation, scope) {
    assert.equal(id, 1447987054);
    assert.equal(scope, 'registry-read');
    reads++;
    return operation('fixture-private-read-token');
  } };
  const admit = async id => {
    await assertReleaseUnpaused(app, id, () => readReleasePauses(api));
    claimed++;
  };
  state.legacy = true;
  await assert.rejects(admit(repoId), /RELEASE_REPOSITORY_PAUSED/);
  state.legacy = false;
  await assert.rejects(admit(repoId), /RELEASE_REPOSITORY_PAUSED/);
  await admit(otherId);
  state.bytes = Buffer.from('[]\n');
  await admit(repoId);
  assert.deepEqual({ reads, claimed }, { reads: 4, claimed: 2 });
});

test('rejects a missing, malformed, unprotected, or changed pause source', async () => {
  for (const text of ['null', '{}', '[0]', '[1.5]', '[9007199254740992]', '["1"]', '[1,1]', '[1,]', '\ufeff[]']) {
    const { state, api } = fixture();
    state.bytes = Buffer.from(text);
    await assert.rejects(readReleasePauses(api), /RELEASE_PAUSE_POLICY_UNAVAILABLE/);
  }
  for (const drift of [{present:false}, {mode:'120000'}, {protected:false}, {truncated:true},
    {headAfter:moved}, {actualId:1}, {contentSha:moved}]) {
    const { state, api } = fixture();
    Object.assign(state, drift);
    await assert.rejects(readReleasePauses(api), /RELEASE_PAUSE_POLICY_UNAVAILABLE/);
  }
  await assert.rejects(assertReleaseUnpaused({async forRepository(){throw Error('private upstream output');}}, repoId),
    error => error.message === 'RELEASE_PAUSE_POLICY_UNAVAILABLE');
});
