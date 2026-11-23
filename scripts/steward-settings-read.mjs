import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import apiVersion from '../config/github-api.json' with { type: 'json' };

export const settingsRepositoryId = 1447987054;
const target = { owner: 'splrad', repo: 'steward-settings' };
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
export const settingsGitHubOptions = {
  log: quiet,
  request: { log: quiet, headers: { 'x-github-api-version': apiVersion.version } },
};

export async function readProtectedSettings(api, read, errorCode) {
  const check = value => { if (!value) throw Error(errorCode); };
  const { data: admin } = await api.rest.repos.get(target);
  check(admin.id === settingsRepositoryId && admin.full_name === 'splrad/steward-settings' &&
    admin.owner?.id === 302208797 && admin.private === true && admin.default_branch === 'main' &&
    admin.archived === false && admin.disabled === false);
  const head = async () => {
    const { data: branch } = await api.rest.repos.getBranch({ ...target, branch: 'main' });
    check(branch.name === 'main' && branch.protected === true && sha(branch.commit?.sha));
    return branch.commit.sha;
  };
  const commit = await head();
  const entry = async (path, treeSha = commit) => {
    const { data } = await api.rest.git.getTree({ ...target, tree_sha: treeSha });
    check(data.truncated === false && Array.isArray(data.tree));
    const found = data.tree.filter(item => item.path === path);
    check(found.length <= 1);
    return found[0];
  };
  const readFile = async (path, blob) => {
    check(blob?.type === 'blob' && blob.mode === '100644' && sha(blob.sha));
    const { data: file } = await api.rest.repos.getContent({ ...target, ref: commit, path });
    check(file.path === path && file.type === 'file' && file.sha === blob.sha && file.encoding === 'base64'
      && typeof file.content === 'string');
    const bytes = Buffer.from(file.content, 'base64');
    check(bytes.length === file.size && createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') === blob.sha);
    return bytes;
  };
  const value = await read({ entry, readFile, check });
  check(await head() === commit);
  return { commit, value };
}

export async function withStewardSettings(app, read, errorCode) {
  try {
    return await app.forRepository(settingsRepositoryId, token => read(
      new Octokit({ ...settingsGitHubOptions, auth: token })), 'registry-read');
  } catch {
    throw Error(errorCode);
  }
}
