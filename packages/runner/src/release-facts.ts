import { createHash } from 'node:crypto';
import { assembleReleaseFacts, parseReleaseMigration, type FactPull, type ReleaseFactHistory } from '../../core/src/release-facts.js';
import { parseFragment, type FragmentClassification, type FragmentProfile } from '../../core/src/release-note-fragment.js';
import { sourceFailure, type ReleaseSourceIdentity } from '../../core/src/release-notes-input.js';
import type { GitHubClient } from '../../github/src/index.js';
import { collectReleaseSources, assertReleaseSourcesUnchanged, type TrustedReleaseSourcePolicy } from './release-notes-input.js';
import { readFragmentBlob } from './release-note-validation.js';

export const releaseFactCommitLimit = 50;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function retainReleaseFragment(path: string, bytes: Uint8Array) {
  return { path, rawBase64: Buffer.from(bytes).toString('base64'),
    blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    sha256: sha256(bytes), fragment: parseFragment(bytes) };
}
/** Authenticated central reader, bound to the fixed target and policy; never load from product files. */
export interface ReleaseFactContext {
  history: ReleaseFactHistory;
  migrationBytes?: Uint8Array;
}
export type ReleaseFactContextReader = (identity: ReleaseSourceIdentity) => Promise<ReleaseFactContext>;
/** R03 composition entry point. The caller's GitHub client must share the R02 HTTP budget across both reads. */
export async function collectReleaseFactSnapshot(input: {
  gh: GitHubClient; owner: string; repo: string; identity: ReleaseSourceIdentity; targetTag: string;
  profile: FragmentProfile; sourcePolicy?: TrustedReleaseSourcePolicy;
  readContext: ReleaseFactContextReader;
  classify: (fact: Awaited<ReturnType<typeof collectReleaseSources>>['facts'][number]) => FragmentClassification;
}) {
  if (typeof input.readContext !== 'function') return sourceFailure('central fact history unavailable');
  const collect = async () => {
    const context = await input.readContext(input.identity);
    if (!context?.history) return sourceFailure('central fact history unavailable');
    const source = await collectReleaseSources(input.gh, input.owner, input.repo, input.identity, input.targetTag, input.sourcePolicy, releaseFactCommitLimit);
    const pulls: FactPull[] = [];
    for (const row of source.input.commits.filter(c => c.kind === 'product')) {
      const fact = source.facts.find(f => f.pull.number === row.pullNumber)!;
      const changes = fact.files.map(f => {
        if (f.status === 'renamed' && typeof f.previous_filename === 'string') return { status: 'renamed' as const, path: f.filename, previousPath: f.previous_filename };
        if (!['added', 'modified', 'removed'].includes(f.status)) return sourceFailure('fact file status');
        return { status: f.status as 'added' | 'modified' | 'removed', path: f.filename };
      });
      const touched = changes.filter(c => [c.path, c.status === 'renamed' ? c.previousPath : ''].some(p => p === input.profile.fragmentDirectory || p.startsWith(input.profile.fragmentDirectory + '/')));
      if (touched.length > 1 || touched.some(c => c.status !== 'added')) return sourceFailure('fact fragment lifecycle');
      let fragment = null;
      if (touched[0]) {
        const path = touched[0].path;
        // Compare merge-time content with the fixed target: later changes/deletions must not rewrite facts.
        const atMerge = await readFragmentBlob(input.gh, input.owner, input.repo, row.sha, path);
        const atTarget = await readFragmentBlob(input.gh, input.owner, input.repo, input.identity.targetSha, path);
        if (!atMerge || !atTarget || !Buffer.from(atMerge).equals(Buffer.from(atTarget))) return sourceFailure('fragment missing or changed since merge');
        fragment = retainReleaseFragment(path, atTarget);
      }
      pulls.push({ pullNumber: row.pullNumber, mergeSha: row.sha, changes, classification: input.classify(fact), fragment });
    }
    const migration = context.migrationBytes === undefined ? undefined : {
      value: parseReleaseMigration(context.migrationBytes), sha256: sha256(context.migrationBytes), rawBase64: Buffer.from(context.migrationBytes).toString('base64'),
    };
    let verifiedRoot: { sha: string; parents: string[] } | undefined;
    if (migration?.value.root) {
      const root = await input.gh.getCommit(input.owner, input.repo, migration.value.root.sha);
      if (root.sha !== migration.value.root.sha || !Array.isArray(root.parents) || root.parents.length !== 0) return sourceFailure('root commit identity or parents');
      verifiedRoot = { sha: root.sha, parents: [] };
    }
    const facts = assembleReleaseFacts({ source: source.input, targetTag: input.targetTag, profile: input.profile, pulls, history: context.history, ...(verifiedRoot ? { verifiedRoot } : {}), ...(migration ? { migration } : {}) });
    // Preserve source bytes and trusted history so concurrent consumption invalidates this snapshot too.
    const bytes = JSON.stringify({ source: JSON.parse(source.bytes), facts, classifications: pulls.map(p => ({ pullNumber: p.pullNumber, mergeSha: p.mergeSha, classification: p.classification })), history: context.history }) + '\n';
    return { facts, bytes, inputSha256: sha256(Buffer.from(bytes)) };
  };
  const before = await collect(), after = await collect();
  assertReleaseSourcesUnchanged(before, after);
  return before;
}
