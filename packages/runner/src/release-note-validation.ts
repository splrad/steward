import { createHash } from 'node:crypto';
import { assertFragmentIdentity, evaluateRequirement, fragmentIdFromPath, FragmentValidationError, validatePullRequestFragments,
  type FragmentClassification, type FragmentPathChange, type FragmentProfile, type FragmentValidationIdentity } from '../../core/src/index.js';
import { GitHubClient } from '../../github/src/index.js';

const incomplete = (detail: string): never => { throw new FragmentValidationError('RN_SOURCE_INCOMPLETE', detail); };

export async function readFragmentBlob(gh: GitHubClient, owner: string, repo: string, commit: string, path: string): Promise<Uint8Array | null> {
  const source = await gh.request<any>('GET', `/repos/${owner}/${repo}/git/commits/${commit}`);
  if (source.sha !== commit || !/^[a-f0-9]{40}$/.test(source.tree?.sha)) return incomplete('Git commit identity');
  let tree = source.tree.sha;
  const segments = path.split('/');
  for (let index = 0; index < segments.length; index++) {
    const result = await gh.request<any>('GET', `/repos/${owner}/${repo}/git/trees/${tree}`);
    if (result.sha !== tree || result.truncated !== false || !Array.isArray(result.tree)) return incomplete('Git tree');
    const matches = result.tree.filter((entry: any) => entry.path === segments[index]);
    if (!matches.length) return null;
    if (matches.length !== 1) return incomplete('ambiguous Git tree');
    const entry = matches[0];
    if (!/^[a-f0-9]{40}$/.test(entry.sha)) return incomplete('Git object identity');
    if (index < segments.length - 1) {
      if (entry.type !== 'tree' || entry.mode !== '040000') return incomplete('fragment parent is not a tree');
      tree = entry.sha;
    } else {
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) return incomplete('fragment is not a regular blob');
      const blob = await gh.request<any>('GET', `/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
      if (blob.sha !== entry.sha || blob.encoding !== 'base64' || typeof blob.content !== 'string'
        || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > 512 * 1024) return incomplete('fragment blob');
      const encoded = blob.content.replace(/\n/g, '');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded || bytes.length !== blob.size
        || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha) return incomplete('fragment blob integrity');
      return bytes;
    }
  }
  return incomplete('fragment path');
}

export async function validateRemoteFragments(input: {
  gh: GitHubClient; owner: string; repo: string; identity: FragmentValidationIdentity; profile: FragmentProfile;
  classification: () => Promise<FragmentClassification | null>;
}) {
  const { gh, owner, repo, identity } = input;
  const readPull = async () => {
    const pull = await gh.getPullRequest(owner, repo, identity.pullRequestNumber);
    assertFragmentIdentity(identity, { ...identity, repositoryId: pull.base?.repo?.id, pullRequestNumber: pull.number,
      baseSha: pull.base?.sha, headSha: pull.head?.sha });
    if (pull.state !== 'open') throw new FragmentValidationError('RN_SOURCE_STALE', 'PR is not open');
    return pull;
  };
  const pull = await readPull();
  if (!Number.isSafeInteger(pull.changed_files) || pull.changed_files < 0 || pull.changed_files > 3000) return incomplete('PR file count');
  let files: readonly any[];
  try { files = await gh.listPullFiles(owner, repo, identity.pullRequestNumber); }
  catch { return incomplete('PR file pagination'); }
  if (files.length !== pull.changed_files || files.length > 3000) return incomplete('PR file count');
  const changes: FragmentPathChange[] = files.map(file => {
    if (typeof file.filename !== 'string') return incomplete('PR path');
    if (file.status === 'renamed' && typeof file.previous_filename === 'string') return { status: 'renamed', path: file.filename, previousPath: file.previous_filename };
    if (['added', 'modified', 'removed'].includes(file.status)) return { status: file.status, path: file.filename };
    return incomplete('PR file status');
  });
  evaluateRequirement(changes, null, input.profile);
  const inside = (path: string) => path === input.profile.fragmentDirectory || path.startsWith(`${input.profile.fragmentDirectory}/`);
  const touched = changes.filter(change => inside(change.path) || (change.status === 'renamed' && inside(change.previousPath)));
  if (touched.length > 1 || touched.some(change => change.status !== 'added')) throw new FragmentValidationError('RN_FRAGMENT_LIFECYCLE', 'historical fragment change or multiple fragments');
  const classification = await input.classification();
  const fragments = [];
  for (const change of touched) {
    fragmentIdFromPath(change.path, input.profile.fragmentDirectory);
    let bytes: Uint8Array | null;
    let existsInBase: boolean;
    try {
      bytes = await readFragmentBlob(gh, owner, repo, identity.headSha, change.path);
      existsInBase = (await readFragmentBlob(gh, owner, repo, identity.baseSha, change.path)) !== null;
    } catch { return incomplete('fragment object read'); }
    if (!bytes) return incomplete('fragment missing at PR head');
    fragments.push({ path: change.path, bytes, existsInBase });
  }
  const result = validatePullRequestFragments({ identity, changes, expectedFileCount: pull.changed_files, profile: input.profile, classification, fragments });
  const latest = await readPull();
  if (latest.changed_files !== pull.changed_files) throw new FragmentValidationError('RN_SOURCE_STALE', 'PR file count');
  return { ...result, sources: fragments.map(fragment => ({ path: fragment.path,
    blobSha: createHash('sha1').update(`blob ${fragment.bytes.length}\0`).update(fragment.bytes).digest('hex'),
    sha256: createHash('sha256').update(fragment.bytes).digest('hex') })) };
}
