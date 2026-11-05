const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
function check(value: unknown, reason: string): asserts value {
  if (!value) throw Error(`MERGED_PULL_EVIDENCE: ${reason}`);
}

/** REST 2026-03-10 removed merge_commit_sha. Keep the internal projection backed
 * by the same PR's complete native issue-event history; never infer it from refs.
 * The transport response remains untouched and the event provenance is retained.
 */
export async function completeMergedPull(repository: string, number: number, pull: any,
  readEvents: () => Promise<readonly any[]>): Promise<any> {
  if (!pull?.merged_at && pull?.merged !== true) return pull;
  // Historical API responses and archived fixtures already contain the native SHA.
  if (Object.hasOwn(pull, 'merge_commit_sha')) {
    check(sha(pull.merge_commit_sha), 'invalid legacy merge commit');
    return pull;
  }
  const root = `https://api.github.com/repos/${repository}`;
  check(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    && !repository.split('/').some(part => ['.', '..'].includes(part)) && positive(number), 'request identity');
  check(pull.number === number && pull.url === `${root}/pulls/${number}`
    && pull.base?.repo?.full_name === repository && positive(pull.base.repo.id)
    && pull.state === 'closed' && pull.merged !== false
    && typeof pull.merged_at === 'string' && Number.isFinite(Date.parse(pull.merged_at)), 'PR identity');
  const events = await readEvents();
  check(Array.isArray(events) && events.every(event => positive(event.id))
    && new Set(events.map(event => event.id)).size === events.length, 'event history');
  const merged = events.filter(event => event.event === 'merged');
  check(merged.length === 1, 'unique merged event required');
  const event = merged[0];
  check(event.url === `${root}/issues/events/${event.id}` && sha(event.commit_id)
    && event.commit_url === `${root}/commits/${event.commit_id}` && positive(event.actor?.id)
    && typeof event.created_at === 'string' && Number.isFinite(Date.parse(event.created_at)), 'merged event provenance');
  return { ...pull, merge_commit_sha: event.commit_id,
    merge_commit_evidence: { source: `${root}/issues/${number}/events`, id: event.id, url: event.url,
      commitUrl: event.commit_url, actorId: event.actor.id, createdAt: event.created_at } };
}
