import { sha256Hex } from './fingerprint.js';
import { assertDeliveryPath } from './delivery-config.js';
import { isHumanActor, isBotActor, type GitHubActor } from './identity.js';
export {renderReleaseContributors} from './candidate-note.js';

export interface CandidateFile { path: string; mode: '100644' | '100755'; content: string | null }
export interface CandidateSnapshot {
  schemaVersion: 1; baseSha: string; files: CandidateFile[];
  units: { id: string; path: string; version: string; tag: string }[];
  configDigest: string; sourceDigest: string;
}
export interface RepositoryAuthor { id: number; evidence: string }
export interface ReleaseActor extends GitHubActor { profileUrl: string; avatarUrl: string }
export type ReleaseContributorPolicy = readonly Pick<RepositoryAuthor, 'id'>[] | 'github-authors';

function isServiceLogin(login: string): boolean {
  return /^(?:bot|automation|service|svc|ci)(?:-|$)|-(?:bot|automation|service|svc)$/i.test(login);
}
export const confirmedReleaseContributorsPath = '.github/release-contributors.json';
export function confirmedReleaseContributors(text: string | null): RepositoryAuthor[] {
  if (text === null) return [];
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length > 1024 || value.some(person => !person || typeof person !== 'object'
    || Object.keys(person).sort().join(',') !== 'evidence,id' || !Number.isSafeInteger(person.id) || person.id <= 0
    || typeof person.evidence !== 'string' || !person.evidence.trim() || person.evidence.length > 4096)
    || new Set(value.map(person => person.id)).size !== value.length) throw new Error('CONTRIBUTOR_CONFIRMATION_INVALID');
  return value as RepositoryAuthor[];
}
import type {ReleaseContributor} from './candidate-note.js';
export type {ReleaseContributor} from './candidate-note.js';
export function validateCandidateFiles(files: readonly CandidateFile[]) {
  const paths = new Set<string>();
  for (const file of files) {
    assertDeliveryPath(file.path);
    if (file.path.split('/').some(part => part.toLowerCase() === '.git') || paths.has(file.path.toLowerCase())
      || !['100644', '100755'].includes(file.mode)
      || file.content !== null && (typeof file.content !== 'string' || file.content.includes('\0')))
      throw new Error('CANDIDATE_FILE_INVALID');
    paths.add(file.path.toLowerCase());
  }
}
/** Native numeric identities, never name/email heuristics or maintainer inference. */
export function selectReleaseContributors(actors: readonly (ReleaseActor | null)[], authors: readonly RepositoryAuthor[],
  policy?: ReleaseContributorPolicy) {
  if (!policy && (!authors.length || authors.some(a => !Number.isSafeInteger(a.id) || a.id <= 0 || !a.evidence.trim())
    || new Set(authors.map(a => a.id)).size !== authors.length)) throw new Error('AUTHOR_IDENTITY_UNVERIFIED');
  const excluded = new Set(policy ? [] : authors.map(a => a.id));
  const selected = new Map<number, ReleaseContributor>();
  const automatic = policy === 'github-authors';
  const confirmed = !automatic && policy ? new Set(policy.map(person => person.id)) : undefined;
  let unresolved = 0;
  for (const actor of actors) {
    if (actor && (isBotActor(actor) || (automatic && isServiceLogin(actor.login)))) continue;
    if (!actor || !isHumanActor(actor)) { unresolved++; continue; }
    if (excluded.has(actor.id)) continue;
    if (confirmed && !confirmed.has(actor.id)) { unresolved++; continue; }
    const profile = new URL(actor.profileUrl), avatar = new URL(actor.avatarUrl);
    if (profile.protocol !== 'https:' || profile.hostname !== 'github.com' || profile.pathname !== '/' + actor.login
      || profile.search || profile.hash || profile.username || profile.password || profile.port
      || avatar.protocol !== 'https:' || avatar.hostname !== 'avatars.githubusercontent.com'
      || avatar.username || avatar.password || avatar.port || avatar.hash)
      throw new Error('CONTRIBUTOR_NATIVE_PROFILE_REQUIRED');
    const value = { id: actor.id, login: actor.login, profileUrl: actor.profileUrl, avatarUrl: actor.avatarUrl, alt: actor.login };
    selected.set(actor.id, value);
  }
  return { contributors: [...selected.values()].sort((a, b) => a.id - b.id), unresolved };
}
export async function candidateId(repositoryId: number, branch: string, baseSha: string, lastCompletedCycleId: string | null) {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !/^[a-f0-9]{40}$/.test(baseSha) || !branch)
    throw new Error('CANDIDATE_IDENTITY_INVALID');
  return sha256Hex(JSON.stringify([1, repositoryId, branch, baseSha, lastCompletedCycleId]));
}
export function candidatePhase(candidate: { prNumber: number | null; pendingWrite: object | null; publishedHead: string | null }, contentReady: boolean) {
  return candidate.pendingWrite ? 'WRITE_PENDING' : !contentReady ? 'PREPARING' : candidate.prNumber === null ? 'PR_PENDING' : 'OPEN';
}
export function candidateCreationBody(id: string, upstreamBody: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('CANDIDATE_IDENTITY_INVALID');
  return `${upstreamBody}\n\n当前文稿的预览见本 PR 的 Steward 状态评论。\n\n<!-- steward:candidate:${id} -->\n`;
}
