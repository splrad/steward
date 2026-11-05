import { sha256Hex } from './fingerprint.js';
import { assertDeliveryPath } from './delivery-config.js';
import { isHumanActor, isBotActor, type GitHubActor } from './identity.js';
import Mustache from 'mustache';

export interface CandidateFile { path: string; mode: '100644' | '100755'; content: string | null }
export interface CandidateSnapshot {
  schemaVersion: 1; baseSha: string; files: CandidateFile[];
  units: { id: string; path: string; version: string; tag: string }[];
  configDigest: string; sourceDigest: string;
}
export interface RepositoryAuthor { id: number; evidence: string }
export interface ReleaseActor extends GitHubActor { profileUrl: string; avatarUrl: string }
export interface ReleaseContributor { id: number; login: string; profileUrl: string; avatarUrl: string; alt: string }
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
export function selectReleaseContributors(actors: readonly (ReleaseActor | null)[], authors: readonly RepositoryAuthor[]) {
  if (!authors.length || authors.some(a => !Number.isSafeInteger(a.id) || a.id <= 0 || !a.evidence.trim())
    || new Set(authors.map(a => a.id)).size !== authors.length) throw new Error('AUTHOR_IDENTITY_UNVERIFIED');
  const excluded = new Set(authors.map(a => a.id)), selected = new Map<number, ReleaseContributor>();
  let unresolved = 0;
  for (const actor of actors) {
    if (actor && isBotActor(actor)) continue;
    if (!actor || !isHumanActor(actor)) { unresolved++; continue; }
    if (excluded.has(actor.id)) continue;
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
  return `${upstreamBody}\n\n<!-- steward:candidate:${id} -->\n\n此处版本与说明是创建时的快照；当前内容见本 PR 的发布说明文件和 Steward 状态评论。\n`;
}
export function renderReleaseContributors(contributors: readonly ReleaseContributor[]): string {
  return Mustache.render('{{#hasContributors}}\n## 贡献者\n\n{{#contributors}}<a href="{{profileUrl}}"><img src="{{avatarUrl}}" alt="{{alt}}" width="32" height="32" /></a> {{/contributors}}\n{{/hasContributors}}',
    { hasContributors: contributors.length > 0, contributors });
}
