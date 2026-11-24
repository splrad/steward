import { createHmac } from 'node:crypto';
import { createInstallationToken, GitHubClient } from '../support/github/index.js';
import { BoundedGitHub, CENTRAL, ensure, type BoundedEnv, type GitReader } from './bounded-recheck-github.js';
import { SerialTaskQueue } from './serial-task-queue.js';

type ImpactEnv = BoundedEnv & { STEWARD_WEBHOOK_SECRET?: string };
type Notice = { repository: string; id: number; number: number; group: string; delivery: string;
  revision: string; correction: boolean };

function fingerprint(env: ImpactEnv, parts: unknown[]) {
  ensure(env.STEWARD_WEBHOOK_SECRET, 'IMPACT_SECRET');
  return createHmac('sha256', env.STEWARD_WEBHOOK_SECRET).update(JSON.stringify(parts)).digest('hex');
}

function revision(env: ImpactEnv, pr: any) {
  return fingerprint(env, ['release-impact-input', pr.head.sha, pr.base.ref, pr.title, pr.body ?? '']);
}

async function currentPull(env: ImpactEnv, notice: Notice) {
  ensure(env.STEWARD_APP_PRIVATE_KEY, 'APP_KEY_MISSING');
  const token = await createInstallationToken({appId: env.APP_ID, installationId: Number(env.INSTALLATION_ID),
    privateKey: env.STEWARD_APP_PRIVATE_KEY, repositoryId: notice.id, permissions: {pull_requests:'read'}, policySha: env.POLICY_SHA});
  const api = new GitHubClient(token, 'https://api.github.com', fetch, env.POLICY_SHA);
  try { return await api.request<any>('GET', '/repos/' + notice.repository + '/pulls/' + notice.number); }
  finally { await api.request('DELETE', '/installation/token'); }
}

// One existing Durable Object per PR serializes the read, external dispatch and receipt.
// The receipt stores only opaque identifiers; a failed dispatch is eligible for redelivery.
export class ReleaseImpactIntake {
  private readonly queue = new SerialTaskQueue();
  constructor(private storage: DurableObjectStorage, private env: ImpactEnv,
    private pull = currentPull, private reader: () => GitReader = () => new BoundedGitHub(env)) {}

  accept(notice: Notice) {
    return this.queue.run(async () => {
      if (this.env.BOUNDED_RECHECK_ENABLED !== 'true') return;
      const slot = notice.correction ? 'impactCorrection' : 'impactDispatch';
      const previous = await this.storage.get<{revision:string; delivery:string}>(slot);
      if (previous?.delivery === notice.delivery ||
          (!notice.correction && previous?.revision === notice.revision)) return;
      if (!notice.correction) {
        const live = await this.pull(this.env, notice);
        const classifiable = live.state === 'open' || (live.state === 'closed' && live.merged === true);
        if (live.number !== notice.number || live.base.repo.id !== notice.id || !classifiable ||
            revision(this.env, live) !== notice.revision) return;
      }
      await this.reader().json(CENTRAL.id, '/repos/splrad/steward/actions/workflows/pr-release-impact.yml/dispatches',
        'POST', {ref:'main', inputs:{delivery:notice.delivery, group:notice.group}});
      await this.storage.put(slot, {revision:notice.revision, delivery:notice.delivery});
    });
  }
}

// The public Actions event carries an opaque delivery GUID and concurrency group.
// Read the source PR from the App's own delivery, including for private repositories.
export async function dispatchReleaseImpact(env: ImpactEnv, event: string, payload: any, delivery: string) {
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
  ensure(/^splrad\/[\w.-]+$/i.test(repo.full_name) && env.BOUNDED_RECHECK, 'IMPACT_REPOSITORY');
  const group = fingerprint(env, ['release-impact', repo.id, pull.number]);
  const notice: Notice = {repository:repo.full_name, id:repo.id, number:pull.number, group, delivery,
    revision:revision(env, pull), correction:Boolean(correction)};
  const ns = env.BOUNDED_RECHECK, stub = ns.get(ns.idFromName('release-impact:v1:' + group));
  const response = await stub.fetch(new Request('https://bounded.internal/release-impact', {method:'POST', body:JSON.stringify(notice)}));
  ensure(response.ok, 'IMPACT_REGISTRATION');
}
