import { createHash } from 'node:crypto';
import { fragmentIdFromPath, parseFragment, readStrictFragmentJson, validateFragmentRequirement, evaluateRequirement,
  type Fragment, type FragmentEntry, type FragmentClassification, type FragmentPathChange, type FragmentProfile } from './release-note-fragment.js';
import { assertSourceIdentity, sourceFailure, sourceSha, type ReleaseSourceInput } from './release-notes-input.js';

export interface MigrationEntry { pullNumber: number; mergeSha: string; fragment: Fragment }
export interface ReleaseMigration {
  schemaVersion: 1; migrationId: string; repositoryId: number;
  previousRelease: { tag: string; sha: string } | null; boundarySha: string; expiresAfterTag: string;
  entries: MigrationEntry[];
  root?: { sha: string; fragment: Fragment; classification: FragmentClassification };
}
export interface HistoricalFragment {
  fragmentId: string; pullNumber: number; mergeSha: string; blobSha: string; sha256: string; consumed: boolean;
}
/** Supplied by a central, complete history/receipt reader. An absent index is never an empty index. */
export interface ReleaseFactHistory {
  repositoryId: number; targetSha: string; policySha: string; complete: true;
  fragments: readonly HistoricalFragment[];
  migrations: readonly { migrationId: string; sha256: string; consumed: boolean; rootSha?: string }[];
}
export interface RetainedFragment {
  path: string; blobSha: string; sha256: string; rawBase64: string; fragment: Fragment;
}
export interface FactPull {
  pullNumber: number; mergeSha: string; changes: readonly FragmentPathChange[];
  classification: FragmentClassification; fragment: RetainedFragment | null;
}
export type ReleaseFact = { factId: string; entry: FragmentEntry; security: boolean } & (
  { pullNumber: number; mergeSha: string; rootSha?: never } | { pullNumber: null; mergeSha: null; rootSha: string }
);
export interface ConsumedFragment extends RetainedFragment { fragmentId: string; pullNumber: number; mergeSha: string; factIds: string[] }

function obj(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))
    || keys.some(k => !Object.hasOwn(value, k))) return sourceFailure('migration fields');
  return value as Record<string, unknown>;
}
function assertFactClassification(value: unknown): asserts value is FragmentClassification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return sourceFailure('fact classification');
  const c = value as Record<string, unknown>;
  if (typeof c.primaryKind !== 'string' || !c.primaryKind.trim() || !Array.isArray(c.riskFlags)
    || c.riskFlags.some(v => typeof v !== 'string' || !v.trim()) || new Set(c.riskFlags).size !== c.riskFlags.length) return sourceFailure('fact classification');
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return sourceFailure('positive integer');
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9-]{8,64}$/.test(value)) return sourceFailure('fact namespace');
  return value;
}
function tag(value: unknown): string {
  if (typeof value !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return sourceFailure('stable version tag');
  return value;
}
function after(left: string, right: string): boolean {
  const a = tag(left).slice(1).split('.').map(BigInt), b = tag(right).slice(1).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
function originalBytes(raw: string): Uint8Array {
  if (typeof raw !== 'string' || raw.length > 700_000) return sourceFailure('raw base64');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.toString('base64') !== raw || bytes.length > 512 * 1024) return sourceFailure('raw base64');
  return bytes;
}
function bindOriginal(raw: string, expected: string): Uint8Array {
  const bytes = originalBytes(raw);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) return sourceFailure('original digest mismatch');
  return bytes;
}
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every(k => Object.hasOwn(y, k) && sameValue(x[k], y[k]));
}
function digest(value: string): void { if (!/^[a-f0-9]{64}$/.test(value)) sourceFailure('fact digest'); }
/** Keeps the original migration bytes in the adapter; parsing never substitutes for their digest. */
export function parseReleaseMigration(bytes: Uint8Array): ReleaseMigration {
  const raw = readStrictFragmentJson(bytes);
  const hasRoot = !!raw && typeof raw === 'object' && Object.hasOwn(raw, 'root');
  const v = obj(raw, ['schemaVersion', 'migrationId', 'repositoryId', 'previousRelease', 'boundarySha', 'expiresAfterTag', 'entries', ...(hasRoot ? ['root'] : [])]);
  if (v.schemaVersion !== 1 || !Array.isArray(v.entries) || v.entries.length > 10_000) return sourceFailure('migration schema');
  const previous = v.previousRelease === null ? null : obj(v.previousRelease, ['tag', 'sha']);
  let root: ReleaseMigration['root'];
  if (previous === null) {
    if (!hasRoot) return sourceFailure('first release requires root provenance');
    const r = obj(v.root, ['sha', 'fragment', 'classification']);
    const c = obj(r.classification, ['primaryKind', 'riskFlags']);
    assertFactClassification(c);
    root = { sha: sourceSha(r.sha), fragment: parseFragment(new TextEncoder().encode(JSON.stringify(r.fragment))), classification: { primaryKind: c.primaryKind, riskFlags: c.riskFlags } };
  } else if (hasRoot) return sourceFailure('root only allowed for first release');
  const numbers = new Set<number>(), shas = new Set<string>();
  const entries = v.entries.map(value => {
    const row = obj(value, ['pullNumber', 'mergeSha', 'fragment']);
    const pullNumber = positive(row.pullNumber), mergeSha = sourceSha(row.mergeSha);
    if (mergeSha === root?.sha || numbers.has(pullNumber) || shas.has(mergeSha)) return sourceFailure('duplicate migration source');
    numbers.add(pullNumber); shas.add(mergeSha);
    const fragment = parseFragment(new TextEncoder().encode(JSON.stringify(row.fragment)));
    return { pullNumber, mergeSha, fragment };
  });
  return { schemaVersion: 1, migrationId: identifier(v.migrationId), repositoryId: positive(v.repositoryId),
    previousRelease: previous ? { tag: tag(previous.tag), sha: sourceSha(previous.sha) } : null,
    boundarySha: sourceSha(v.boundarySha), expiresAfterTag: tag(v.expiresAfterTag), entries, ...(root ? { root } : {}) };
}

export function assembleReleaseFacts(input: {
  source: ReleaseSourceInput; targetTag: string; profile: FragmentProfile; pulls: readonly FactPull[];
  history: ReleaseFactHistory; verifiedRoot?: { sha: string; parents: readonly string[] }; migration?: { value: ReleaseMigration; sha256: string; rawBase64: string };
}) {
  const { source, history, profile } = input;
  assertSourceIdentity(source); tag(input.targetTag);
  sourceSha(source.boundary.sha);
  if (!['stable-release', 'adoption'].includes(source.boundary.kind)) return sourceFailure('fact boundary kind');
  if (source.boundary.kind === 'adoption' && !input.migration) return sourceFailure('adoption requires root migration provenance');
  if (!history || history.complete !== true || history.repositoryId !== source.repositoryId || history.targetSha !== source.targetSha
    || history.policySha !== source.policySha || !Array.isArray(history.fragments) || !Array.isArray(history.migrations)) return sourceFailure('complete fact history binding');
  const fragments = new Map<string, HistoricalFragment>();
  for (const row of history.fragments) {
    identifier(row.fragmentId); positive(row.pullNumber); sourceSha(row.mergeSha); sourceSha(row.blobSha); digest(row.sha256);
    if (typeof row.consumed !== 'boolean' || fragments.has(row.fragmentId)) return sourceFailure('historical fragment ID reuse');
    fragments.set(row.fragmentId, row);
  }
  const registeredRoots = new Set<string>();
  const migrations = new Map<string, ReleaseFactHistory['migrations'][number]>();
  for (const row of history.migrations) {
    identifier(row.migrationId); digest(row.sha256);
    if (row.rootSha !== undefined) {
      sourceSha(row.rootSha);
      if (registeredRoots.has(row.rootSha)) return sourceFailure('root assigned to multiple migrations');
      registeredRoots.add(row.rootSha);
    }
    if (typeof row.consumed !== 'boolean' || migrations.has(row.migrationId)) return sourceFailure('historical migration ID reuse');
    migrations.set(row.migrationId, row);
  }
  if (source.schemaVersion !== 1 || !source.commits.length || source.commits[0]?.sha !== source.targetSha
    || new Set(source.commits.map(c => c.sha)).size !== source.commits.length || new Set(source.commits.map(c => c.pullNumber)).size !== source.commits.length) return sourceFailure('fact source range');
  for (const row of source.commits) {
    sourceSha(row.sha); positive(row.pullNumber);
    if (!['product', 'review-record'].includes(row.kind) || (row.kind === 'review-record' ? !row.candidateId : row.candidateId !== null)) return sourceFailure('fact source kind');
  }
  const product = source.commits.filter(c => c.kind === 'product');
  if (input.pulls.length !== product.length || new Set(input.pulls.map(p => p.pullNumber)).size !== product.length
    || input.pulls.some(p => !product.some(c => c.pullNumber === p.pullNumber && c.sha === p.mergeSha))) return sourceFailure('fact PR coverage');
  // Conservative central contract: every unconsumed registration must be supplied, never silently ignored.
  const pending = [...migrations.values()].filter(m => !m.consumed);
  if (pending.length > 1 || (pending.length === 1 && pending[0]!.migrationId !== input.migration?.value.migrationId)) return sourceFailure('pending migration original required');
  const migrated = new Map<number, MigrationEntry>();
  if (input.migration) {
    const m = input.migration.value, prior = migrations.get(m.migrationId);
    digest(input.migration.sha256);
    const parsed = parseReleaseMigration(bindOriginal(input.migration.rawBase64, input.migration.sha256));
    if (!sameValue(parsed, m)) return sourceFailure('migration original semantic mismatch');
    if (!prior || prior.consumed || prior.sha256 !== input.migration.sha256 || m.repositoryId !== source.repositoryId
      || after(input.targetTag, m.expiresAfterTag)) return sourceFailure('migration identity, expiry or consumption');
    if (source.boundary.kind === 'adoption') {
      if (m.previousRelease !== null || !m.root || prior.rootSha !== m.root.sha || !input.verifiedRoot || input.verifiedRoot.sha !== m.root.sha
        || !Array.isArray(input.verifiedRoot.parents) || input.verifiedRoot.parents.length !== 0 || m.root.sha !== source.boundary.sha
        || source.commits.some(c => c.sha === m.root!.sha)) return sourceFailure('adoption requires verified root provenance');
    } else if (m.root || prior.rootSha || input.verifiedRoot || !m.previousRelease || m.previousRelease.sha !== source.boundary.sha
      || m.previousRelease.tag !== source.boundary.reference || !after(input.targetTag, m.previousRelease.tag)) return sourceFailure('migration previous release');
    const boundaryIndex = source.boundary.kind === 'adoption' && m.boundarySha === source.boundary.sha
      ? source.commits.length : source.commits.findIndex(c => c.sha === m.boundarySha);
    if (boundaryIndex < 0) return sourceFailure('migration boundary outside range');
    const expected = source.commits.slice(boundaryIndex).filter(c => c.kind === 'product');
    if (m.entries.length !== expected.length) return sourceFailure('migration boundary coverage');
    for (const row of m.entries) {
      if (migrated.has(row.pullNumber) || !expected.some(c => c.pullNumber === row.pullNumber && c.sha === row.mergeSha)) return sourceFailure('migration source outside boundary');
      migrated.set(row.pullNumber, row);
    }
  }
  const facts: ReleaseFact[] = [], consumedFragments: ConsumedFragment[] = [];
  const excluded: { pullNumber: number; mergeSha: string; kind: 'review-record' | 'ignored' | 'not-user-facing'; reason: string }[] = [];
  const coverage: { pullNumber: number; mergeSha: string; source: 'fragment' | 'migration' | 'excluded' }[] = [];
  for (const row of source.commits) {
    if (row.kind === 'review-record') { excluded.push({ pullNumber: row.pullNumber, mergeSha: row.sha, kind: 'review-record', reason: row.candidateId! }); coverage.push({ pullNumber: row.pullNumber, mergeSha: row.sha, source: 'excluded' }); continue; }
    const pull = input.pulls.find(p => p.pullNumber === row.pullNumber)!;
    assertFactClassification(pull.classification);
    const decision = evaluateRequirement(pull.changes, pull.classification, profile);
    const touched = pull.changes.filter(c => [c.path, c.status === 'renamed' ? c.previousPath : ''].some(p => p === profile.fragmentDirectory || p.startsWith(profile.fragmentDirectory + '/')));
    if (touched.length > 1 || touched.some(c => c.status !== 'added') || touched.length !== (pull.fragment ? 1 : 0)
      || (pull.fragment && touched[0]?.path !== pull.fragment.path)) return sourceFailure('fact fragment lifecycle');
    const migration = migrated.get(pull.pullNumber);
    if (migration && pull.fragment) return sourceFailure('overlapping fragment and migration');
    const fragment = pull.fragment?.fragment ?? migration?.fragment ?? null;
    validateFragmentRequirement(fragment, decision, pull.classification);
    let prefix: string | undefined;
    if (pull.fragment) {
      const f = pull.fragment;
      const bytes = bindOriginal(f.rawBase64, f.sha256);
      if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== f.blobSha || !sameValue(parseFragment(bytes), f.fragment)) return sourceFailure('fragment original binding');
      const id = fragmentIdFromPath(f.path, profile.fragmentDirectory), prior = fragments.get(id);
      if (!prior || prior.consumed || prior.pullNumber !== pull.pullNumber || prior.mergeSha !== pull.mergeSha
        || prior.blobSha !== f.blobSha || prior.sha256 !== f.sha256) return sourceFailure('fragment history binding or reuse');
      prefix = id;
      consumedFragments.push({ ...f, fragmentId: id, pullNumber: pull.pullNumber, mergeSha: pull.mergeSha,
        factIds: fragment?.status === 'documented' ? fragment.entries.map((_, i) => `${id}#${i}`) : [] });
    } else if (migration) prefix = `migration:${input.migration!.value.migrationId}:${pull.pullNumber}`;
    coverage.push({ pullNumber: pull.pullNumber, mergeSha: pull.mergeSha, source: pull.fragment ? 'fragment' : migration ? 'migration' : 'excluded' });
    if (fragment?.status === 'documented') {
      fragment.entries.forEach((entry, i) => facts.push({ factId: `${prefix}#${i}`, pullNumber: pull.pullNumber, mergeSha: pull.mergeSha, entry, security: pull.classification.riskFlags.includes('security') }));
    } else excluded.push({ pullNumber: pull.pullNumber, mergeSha: pull.mergeSha, kind: fragment ? 'not-user-facing' : 'ignored', reason: fragment?.reason ?? 'path and classification ignored' });
  }
  let rootRecord: { sha: string; status: Fragment['status']; factIds: string[]; reason: string | null } | null = null;
  const root = input.migration?.value.root;
  if (root) {
    validateFragmentRequirement(root.fragment, { requirement: 'required', classificationState: 'provided', paths: [] }, root.classification);
    const factIds = root.fragment.status === 'documented' ? root.fragment.entries.map((entry, i) => {
      const factId = `migration:${input.migration!.value.migrationId}:root#${i}`;
      facts.push({ factId, pullNumber: null, mergeSha: null, rootSha: root.sha, entry, security: root.classification.riskFlags.includes('security') });
      return factId;
    }) : [];
    rootRecord = { sha: root.sha, status: root.fragment.status, factIds, reason: root.fragment.status === 'not-user-facing' ? root.fragment.reason : null };
  }
  if (new Set(facts.map(f => f.factId)).size !== facts.length) return sourceFailure('duplicate fact ID');
  const byId = (a: { factId: string }, b: { factId: string }) => a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0;
  facts.sort(byId); consumedFragments.sort((a, b) => a.fragmentId < b.fragmentId ? -1 : a.fragmentId > b.fragmentId ? 1 : 0);
  return { schemaVersion: 1 as const, repositoryId: source.repositoryId, targetSha: source.targetSha, policySha: source.policySha,
    targetTag: input.targetTag, facts, consumedFragments, excluded, coverage, rootRecord, migration: input.migration ?? null };
}
