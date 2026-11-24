import { createHmac } from 'node:crypto';
import { BoundedGitHub, CENTRAL, ensure, type BoundedEnv, type GitReader } from './bounded-recheck-github.js';

// The public Actions event carries an opaque delivery GUID and concurrency group.
// Read the source PR from the App's own delivery, including for private repositories.
export async function dispatchReleaseImpact(env: BoundedEnv & { STEWARD_WEBHOOK_SECRET?: string }, event: string, payload: any, delivery: string,
  reader: () => GitReader = () => new BoundedGitHub(env)) {
  if (event !== 'pull_request' || env.BOUNDED_RECHECK_ENABLED !== 'true') return;
  const correction = ['labeled', 'unlabeled'].includes(payload.action) &&
    payload.label?.name?.toLowerCase() === 'internal' && payload.sender?.id && payload.sender.id !== 301115370;
  if (!correction && !['opened', 'reopened', 'synchronize', 'edited', 'ready_for_review'].includes(payload.action)) return;
  const repo = payload.repository, pull = payload.pull_request;
  if (repo?.owner?.id !== 302208797 || repo.archived || repo.disabled || repo.fork ||
      payload.installation?.id !== Number(env.INSTALLATION_ID) || !Number.isSafeInteger(repo.id) ||
      !Number.isSafeInteger(pull?.number) || pull.number < 1 || pull.state !== 'open' ||
      pull.base?.repo?.id !== repo.id || pull.base.ref !== repo.default_branch ||
      !/^[0-9a-f]{40}$/.test(pull.head?.sha ?? '') ||
      (pull.user?.id === 301115370 && pull.head.ref === 'release-please--branches--' + repo.default_branch)) return;
  ensure(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(delivery) && env.STEWARD_WEBHOOK_SECRET, 'IMPACT_DELIVERY');
  const group = createHmac('sha256', env.STEWARD_WEBHOOK_SECRET)
    .update(JSON.stringify(['release-impact', repo.id, pull.number])).digest('hex');
  await reader().json(CENTRAL.id, '/repos/splrad/steward/actions/workflows/pr-release-impact.yml/dispatches', 'POST',
    { ref: 'main', inputs: { delivery, group } });
}
