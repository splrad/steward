import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface GitSnapshot {
  head(directory: string): Promise<string>;
  file(directory: string, sha: string, path: string): Promise<Buffer | null>;
  blob(directory: string, id: string): Promise<Buffer>;
}
const sha = (value: string) => /^[a-f0-9]{40}$/.test(value);
function fail(reason: string): never { throw new Error(`GIT_SNAPSHOT: ${reason}`); }
export function safeGitPath(path: string) {
  if (!path || path.length > 240 || path.includes('\\') || !/^[A-Za-z0-9._/-]+$/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) fail('unsafe path');
}
async function git(directory: string, args: string[]) {
  return (await promisify(execFile)('git', ['--no-replace-objects', '-C', directory, ...args], {
    encoding: 'buffer', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  })).stdout;
}
export const localGitSnapshot: GitSnapshot = {
  async head(directory) { return (await git(directory, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString('ascii').trim(); },
  async file(directory, commit, path) {
    if (!sha(commit)) fail('invalid source commit'); safeGitPath(path);
    const entry = (await git(directory, ['ls-tree', '-z', commit, '--', path])).toString('utf8');
    if (!entry) return null;
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(entry);
    if (!match || match[2] !== path) fail('source must be a regular Git blob');
    return this.blob(directory, match[1]!);
  },
  async blob(directory, id) { if (!sha(id)) fail('invalid blob'); return git(directory, ['cat-file', 'blob', id]); },
};
