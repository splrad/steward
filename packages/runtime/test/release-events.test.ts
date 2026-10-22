import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newReleaseReceipt } from '../../core/src/release-note-receipt.js';
import { frozenFixture, notesFixture, sha } from '../../core/test/release-receipt-fixture.js';
import { handleWebhook, recoverReleaseReceipts, type Env } from '../src/index.js';
import { ReleaseReceiptStore } from '../src/release-note-receipts.js';
import { ReleaseTestDb } from './release-test-db.js';
import catalog from '../../../config/repositories.json' with { type: 'json' };

vi.mock('../../github/src/index.js', async original => ({ ...await original<any>(), createInstallationToken: vi.fn(async () => 'test-token') }));
let reviewerPermission = 'write';
let db: ReleaseTestDb, store: ReleaseReceiptStore, requests: any[], env: Env;
const capability = catalog.repositories['1187527897'].delivery.githubRelease!;
const originalState = capability.state;
beforeEach(() => {
  reviewerPermission = 'write';
  db = new ReleaseTestDb(); store = new ReleaseReceiptStore(db.binding()); requests = [];
  env = { ORGANIZATION_ID: '302208797', ORGANIZATION_LOGIN: 'splrad', APP_ID: '4243096', INSTALLATION_ID: '145952003', STEWARDSHIP_REPOSITORY: 'splrad/steward', POLICY_SHA: sha('c'), STEWARD_APP_PRIVATE_KEY: 'fixture', STEWARD_WEBHOOK_SECRET: 'fixture', ISSUE_SNAPSHOTS: db.binding() };
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: RequestInit = {}) => {
    if (init.method === 'POST' && String(url).includes('/dispatches')) { requests.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
    if (String(url).includes('/collaborators/maintainer/permission')) return Response.json({permission:reviewerPermission});
    if (String(url).endsWith('/repos/splrad/steward')) return Response.json({ default_branch: 'main' });
    if (String(url).endsWith('/repos/splrad/steward/git/ref/heads/main')) return Response.json({ object: { sha: env.POLICY_SHA } });
    throw new Error('unexpected remote request ' + url);
  }));
});
afterEach(() => { capability.state = originalState; db.database.close(); vi.unstubAllGlobals(); });
async function seed(phase: 'awaiting-review' | 'approved' | 'merged' = 'awaiting-review') {
  const r = newReleaseReceipt({ ...frozenFixture(), repositoryId: 1187527897, fullName: 'splrad/LayerScape' }, notesFixture);
  await store.prepare({ ...r, phase, pullNumber: 17, headSha: sha('d') }, 'now');
}
function event(type: string, action: string, number = 17, merged = false, reviewOverrides: any = {}) {
  const body = JSON.stringify({ organization: { id: 302208797 }, installation: { id: 145952003 }, action,
    repository: { id: 1187527897, full_name: 'splrad/LayerScape', default_branch: 'main', private: false, owner: { id: 302208797 } },
    review: {user:{type:'User',login:'maintainer'},state:action==='dismissed'?'DISMISSED':'APPROVED',commit_id:sha('d'),...reviewOverrides},
    pull_request: { number, merged, head: { sha: sha('d') }, base: { ref: 'main' } } });
  return new Request('https://runtime.test/github/webhook', { method: 'POST', body, headers: { 'x-github-event': type, 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'fixture').update(body).digest('hex') } });
}
describe('bound-candidate release dispatch', () => {
  it.each(['submitted', 'dismissed', 'edited'])('Review %s schedules observation only', async action => {
    await seed(); expect((await handleWebhook(event('pull_request_review', action), env)).status).toBe(202);
    expect(requests).toEqual([{ ref: 'main', inputs: { repositoryId: '1187527897', targetTag: 'v1.2.3', operation: 'inspect' } }]);
  });
  it.each(['read', 'triage', 'none'])('does not dispatch for reviewer permission %s', async permission => {
    await seed(); reviewerPermission=permission;
    expect((await handleWebhook(event('pull_request_review','submitted'),env)).status).toBe(204);expect(requests).toEqual([]);
  });
  it.each([{state:'COMMENTED'}, {commit_id:sha('e')}, {user:{type:'Bot',login:'maintainer'}}])('rejects irrelevant or stale review %j', async review => {
    await seed();expect((await handleWebhook(event('pull_request_review','submitted',17,false,review),env)).status).toBe(204);expect(requests).toEqual([]);
  });
  it('coalesces concurrent reviews and lets scheduled recovery retry after the cooldown', async () => {
    await seed();const now=Date.now();
    const results=await Promise.all(['submitted','edited','dismissed'].map(action=>handleWebhook(event('pull_request_review',action),env)));
    expect(results.filter(r=>r.status===202)).toHaveLength(1);expect(requests).toHaveLength(1);
    expect(await recoverReleaseReceipts(env,now+1000)).toBe(0);
    expect(await recoverReleaseReceipts(env,now+16*60_000)).toBe(1);
  });
  it('only a centrally bound merge schedules reconcile; ordinary merged/version PRs do nothing', async () => {
    await seed(); expect((await handleWebhook(event('pull_request', 'closed', 18, true), env)).status).toBe(204); expect(requests).toEqual([]);
    expect((await handleWebhook(event('pull_request', 'closed', 17, true), env)).status).toBe(202); expect(requests[0].inputs.operation).toBe('reconcile');
  });
  it('closing without merge schedules observation, not publication', async () => {
    await seed(); await handleWebhook(event('pull_request', 'closed'), env); expect(requests[0].inputs.operation).toBe('inspect');
  });
  it('recovers an initial prepared receipt without a pull number under pending capability', async () => {
    capability.state = 'pending';
    const r = newReleaseReceipt({ ...frozenFixture(), repositoryId: 1187527897, fullName: 'splrad/LayerScape' }, notesFixture);
    await store.prepare(r, 'now');
    expect(await recoverReleaseReceipts(env, 1000)).toBe(1);
    expect(requests[0].inputs).toEqual({ repositoryId: '1187527897', targetTag: 'v1.2.3', operation: 'recover-candidate' });
    expect(await recoverReleaseReceipts(env, 1001)).toBe(0);
  });
  it('existing scheduled recovery discovers missed merge events with bounded retries', async () => {
    capability.state = 'active'; await seed('approved');
    expect(await recoverReleaseReceipts(env, 1000)).toBe(1); expect(requests[0].inputs.operation).toBe('reconcile');
    expect(await recoverReleaseReceipts(env, 1001)).toBe(0);
  });
  it('pending capability permits observation but never schedules reconcile', async () => {
    capability.state = 'pending'; await seed('approved');
    expect(await recoverReleaseReceipts(env, 1000)).toBe(1); expect(requests[0].inputs.operation).toBe('inspect');
  });
  it.each(['paused', 'prepared'])('recovers the %s rebuild revision without publishing under pending capability', async phase => {
    capability.state = 'pending'; await seed('merged');
    const claim = await store.claim(1187527897, 'v1.2.3', 1);
    await store.save(claim.receipt, { ...claim.receipt, paused: phase === 'paused', phase: phase === 'prepared' ? 'prepared' : 'merged',
      error: phase === 'paused' ? 'rebuild-changed-review-required' : null, rebuildRequestKey: 'a'.repeat(64), pullNumber: phase === 'prepared' ? null : 17 }, claim.token, 2);
    await store.release(1187527897, 'v1.2.3', claim.token);
    expect(await recoverReleaseReceipts(env, 1000)).toBe(1);
    expect(requests[0].inputs).toMatchObject({ operation: 'revise-rebuild', requestKey: 'a'.repeat(64) });
    expect(await recoverReleaseReceipts(env, 1001)).toBe(0);
  });
  it('wrong policy and paused receipts cannot redrive', async () => {
    await seed('merged'); expect(await recoverReleaseReceipts({ ...env, POLICY_SHA: sha('f') }, 1000)).toBe(0);
    const claim = await store.claim(1187527897, 'v1.2.3', 1001); await store.save(claim.receipt, { ...claim.receipt, paused: true }, claim.token, 1002); await store.release(1187527897, 'v1.2.3', claim.token);
    expect(await recoverReleaseReceipts(env, 1000001)).toBe(0); expect(requests).toEqual([]);
  });
});
