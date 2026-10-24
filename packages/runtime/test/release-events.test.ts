import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import worker, { type Env } from '../src/index.js';
const env: Env = { ORGANIZATION_ID: '302208797', ORGANIZATION_LOGIN: 'splrad', APP_ID: '4243096', INSTALLATION_ID: '145952003',
  STEWARDSHIP_REPOSITORY: 'splrad/steward', POLICY_SHA: 'a'.repeat(40), STEWARD_WEBHOOK_SECRET: 'offline-fixture-secret',
  ISSUE_SNAPSHOTS: { prepare() { throw new Error('Historical DB must not schedule or mutate'); } } as unknown as D1Database };
it.each(['pull_request', 'pull_request_review'])('does not recover or publish legacy receipts on %s', async event => {
  const payload = { organization: { id: 302208797 }, installation: { id: 145952003 }, action: event === 'pull_request' ? 'closed' : 'submitted',
    repository: { id: 1187527897, full_name: 'splrad/LayerScape', default_branch: 'main', private: false, owner: { id: 302208797 } },
    pull_request: { number: 12, merged: true, head: { sha: 'a'.repeat(40) }, base: { ref: 'main' } },
    review: { user: { type: 'User', login: 'fixture-maintainer' }, state: 'APPROVED', commit_id: 'a'.repeat(40) } };
  const body = JSON.stringify(payload), signature = createHmac('sha256', env.STEWARD_WEBHOOK_SECRET!).update(body).digest('hex');
  const response = await worker.fetch(new Request('https://fixture.test/github/webhook', { method: 'POST', body, headers: {
    'x-github-event': event, 'x-hub-signature-256': `sha256=${signature}`, 'x-github-delivery': 'offline-fixture',
  } }), env);
  expect(response.status).toBe(204);
});
it.each(['/internal/release', '/internal/release/generation', '/internal/pr-body/prepare', '/internal/pr-body/confirm'])('rejects retired mutation route %s', async path => {
  expect((await worker.fetch(new Request('https://fixture.test' + path, { method: 'POST', body: '{}' }), env)).status).toBe(404);
});
it('has no scheduled retry handler that could mutate retained history', () => expect(Object.hasOwn(worker, 'scheduled')).toBe(false));
