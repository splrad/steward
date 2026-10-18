import { describe, expect, it } from 'vitest';
import { generationPlan, generationPlanDigest, parseGeneratedRelease, renderGeneratedRelease } from '../../core/src/release-production.js';
import { newReleaseReceipt } from '../../core/src/release-note-receipt.js';
import { rebindReleaseBuild, currentReleaseBuild } from '../../core/src/release-rebuild.js';
import { frozenFixture, notesFixture, sha } from '../../core/test/release-receipt-fixture.js';
import { generateRelease, isolatedCopilotEnvironment, isolatedCopilotArguments } from '../../runner/src/release-generation.js';
import { ReleaseGenerationStore } from '../src/release-generation-store.js';
import { ReleaseReceiptStore } from '../src/release-note-receipts.js';
import { ReleaseTestDb } from './release-test-db.js';

const generated = { userNotes: { upgrade: [], changes: [{ category: '修复', text: '修复导出时丢失文件的问题。' }] }, reviewEvidence: { internalChanges: ['调整导出实现。'], unknowns: [] } };
const output = JSON.stringify(generated);
const plan = generationPlan('a'.repeat(64), sha('c'), ['complete source']);

it('archives obsolete generation plans, revokes tickets and fences late writes with a durable restart budget', async () => {
  const db = new ReleaseTestDb(), store = new ReleaseGenerationStore(db.binding());
  try {
    const old = await store.prepare(9001, 'v1.2.3', plan);
    const token = await store.ticket(9001, 'v1.2.3', 1, generationPlanDigest(plan));
    for (const source of ['b', 'd', 'e']) {
      const next = generationPlan(source.repeat(64), sha('c'), ['new source']);
      const saved = await new ReleaseGenerationStore(db.binding()).prepare(9001, 'v1.2.3', next);
      expect(saved.ledger.calls).toEqual([]);
      expect(await store.prepare(9001, 'v1.2.3', next)).toEqual(saved);
    }
    await expect(store.authorize(9001, 'v1.2.3', token, 2, sha('c'))).rejects.toThrow('AUTH');
    await expect(store.ticket(9001, 'v1.2.3', 2, generationPlanDigest(plan))).rejects.toThrow('STALE');
    await expect(store.mutate(9001, 'v1.2.3', old.version, 'reserve', 'old')).rejects.toThrow('STALE');
    await expect(store.prepare(9001, 'v1.2.3', plan)).rejects.toThrow('OCCUPIED');
    await expect(store.prepare(9001, 'v1.2.3', generationPlan('f'.repeat(64), sha('c'), ['fourth']))).rejects.toThrow('OCCUPIED');
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM release_generation_history').get()?.n).toBe(3);
  } finally { db.database.close(); }
});
it('allows only one competing generation replacement and blocks changes after candidate creation', async () => {
  const db = new ReleaseTestDb(), store = new ReleaseGenerationStore(db.binding());
  try {
    await store.prepare(9001, 'v1.2.3', plan);
    const outcomes = await Promise.allSettled(['b', 'd'].map(s => store.prepare(9001, 'v1.2.3', generationPlan(s.repeat(64), sha('c'), ['new']))));
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await new ReleaseReceiptStore(db.binding()).prepare(newReleaseReceipt(frozenFixture(), notesFixture), 'now');
    const before = await store.read(9001, 'v1.2.3');
    await expect(store.prepare(9001, 'v1.2.3', generationPlan('e'.repeat(64), sha('c'), ['blocked']))).rejects.toThrow('OCCUPIED');
    expect(await store.read(9001, 'v1.2.3')).toEqual(before);
  } finally { db.database.close(); }
});

it('enforces the documented aggregate plan budget before persistence or model calls', () => {
  expect(() => generationPlan('a'.repeat(64), sha('c'), Array(3).fill('x'.repeat(96 * 1024)))).toThrow('GENERATION_PLAN_LIMIT');
  expect(() => generationPlan('a'.repeat(64), sha('c'), Array(8).fill('x'.repeat(24 * 1024)))).not.toThrow();
  expect(() => generationPlan('a'.repeat(64), sha('c'), ['"'.repeat(96 * 1024), '"'.repeat(96 * 1024)])).toThrow('GENERATION_PLAN_LIMIT');
});
function client(store: ReleaseGenerationStore) {
  return { request: async <T>(_action?: string, value?: unknown): Promise<T> => {
    const b = value as any;
    return (b.action === 'prepare' ? await store.prepare(9001, 'v1.2.3', b.plan) : await store.mutate(9001, 'v1.2.3', b.version, b.action, b.input, b.index, b.inputDigest)) as T;
  } };
}
describe('release production protocol and durable budget', () => {
  it('handles long JSON whitespace while retaining strict BOM and non-JSON whitespace rejection', () => {
    expect(parseGeneratedRelease(Buffer.from('\t'.repeat(30000) + output + ' \r\n'))).toEqual(generated);
    expect(() => parseGeneratedRelease(Buffer.from(output + '\t'.repeat(30000) + 'x'))).toThrow();
    for (const prefix of ['\ufeff', '\u00a0', '\v']) expect(() => parseGeneratedRelease(Buffer.from(prefix + output))).toThrow();
  });
  it('accepts the explicit fence and renders only trusted links/contributors', () => {
    const value = parseGeneratedRelease(Buffer.from('```json\n' + output + '\n```'));
    expect(renderGeneratedRelease(value, frozenFixture())).toContain('### 修复');
    for (const invalid of ['\ufeff' + output, output + output, 'preface\n' + output, output.replace('"upgrade":[]', '"upgrade":[],"upgrade":[]'), output.replace('"unknowns":[]', '"unknowns":[],"extra":true')]) expect(() => parseGeneratedRelease(Buffer.from(invalid))).toThrow();
  });
  it.each([2, 8])('summarizes %i source batches using bounded generated summaries', async count => {
    const db = new ReleaseTestDb();
    const inputs = Array.from({ length: count }, (_, i) => String(i) + 'x'.repeat((count === 2 ? 96 : 24) * 1024 - 1));
    const largePlan = generationPlan('b'.repeat(64), sha('c'), inputs);
    const summary = { ...generated, reviewEvidence: { internalChanges: ['a'.repeat(3900), 'b'.repeat(3900)], unknowns: [] } };
    const prompts: string[] = [];
    try {
      await generateRelease(largePlan, client(new ReleaseGenerationStore(db.binding())), async input => {
        prompts.push(input); return JSON.stringify(summary);
      });
      expect(prompts).toHaveLength(count + 1);
      expect(Buffer.byteLength(prompts[count]!)).toBeLessThan(128 * 1024);
      const synthesis = JSON.parse(prompts[count]!);
      expect(synthesis.batches).toHaveLength(count);
      expect(synthesis.batches[0]).toEqual(summary);
    } finally { db.database.close(); }
  });
  it('rejects results and diagnostics bound to another reserved prompt', async () => {
    const db = new ReleaseTestDb(); const store = new ReleaseGenerationStore(db.binding());
    try {
      await store.prepare(9001, 'v1.2.3', plan);
      const state = await store.mutate(9001, 'v1.2.3', 0, 'reserve', 'source');
      for (const action of ['complete', 'diagnostic'] as const) {
        await expect(store.mutate(9001, 'v1.2.3', state.version, action, output, 0, 'f'.repeat(64))).rejects.toThrow('GENERATION_INPUT_BINDING');
      }
      expect((await store.read(9001, 'v1.2.3'))?.ledger.calls[0]?.output).toBeNull();
      await expect(store.mutate(9001, 'v1.2.3', state.version, 'complete', output, 0, state.ledger.calls[0]!.inputDigest)).resolves.toBeDefined();
    } finally { db.database.close(); }
  });
  it('reuses completed output after a fresh store instance without calling the producer', async () => {
    const db = new ReleaseTestDb();
    try {
      await generateRelease(plan, client(new ReleaseGenerationStore(db.binding())), async () => output);
      expect(await generateRelease(plan, client(new ReleaseGenerationStore(db.binding())), async () => { throw new Error('must reuse'); })).toEqual(generated);
    } finally { db.database.close(); }
  });
  it('counts unknown outcomes across reruns and rejects the third call', async () => {
    const db = new ReleaseTestDb(); const store = new ReleaseGenerationStore(db.binding()); let calls = 0;
    try {
      for (let i = 0; i < 3; i++) await expect(generateRelease(plan, client(store), async () => { calls++; throw new Error('lost'); })).rejects.toThrow();
      expect(calls).toBe(2); expect((await store.read(9001, 'v1.2.3'))?.ledger.calls).toHaveLength(2);
      await expect(store.prepare(9001, 'v1.2.3', generationPlan(plan.sourceDigest, sha('c'), ['different']))).rejects.toThrow('OCCUPIED');
    } finally { db.database.close(); }
  });
  it('persists invalid output and uses only the one remaining format attempt', async () => {
    const db = new ReleaseTestDb(); const store = new ReleaseGenerationStore(db.binding()); let calls = 0;
    try {
      await generateRelease(plan, client(store), async () => ++calls === 1 ? 'invalid' : output);
      expect(calls).toBe(2); expect((await store.read(9001, 'v1.2.3'))?.ledger.calls[0]?.diagnostic).toBe('invalid');
      const saved = (await store.read(9001, 'v1.2.3'))!;
      expect(Buffer.from(await new ReleaseReceiptStore(db.binding()).readObject(9001, saved.ledger.calls[1]!.rawDigest!)).toString()).toBe(output);
    } finally { db.database.close(); }
  });
  it('rejects racing reservation versions', async () => {
    const db = new ReleaseTestDb(); const store = new ReleaseGenerationStore(db.binding());
    try {
      await store.prepare(9001, 'v1.2.3', plan);
      const results = await Promise.allSettled([store.mutate(9001, 'v1.2.3', 0, 'reserve', 'source'), store.mutate(9001, 'v1.2.3', 0, 'reserve', 'source')]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    } finally { db.database.close(); }
  });
  it('binds generation tickets to repository, tag, policy and expiry', async () => {
    const db = new ReleaseTestDb(); const store = new ReleaseGenerationStore(db.binding());
    try {
      await store.prepare(9001, 'v1.2.3', plan);
      const issued = await Promise.allSettled([store.ticket(9001, 'v1.2.3', 1000), store.ticket(9001, 'v1.2.3', 1000)]);
      expect(issued.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const token = (issued.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<string>).value;
      await expect(store.ticket(9001, 'v1.2.3', 2000)).rejects.toThrow('GENERATION_TICKET_BUSY');
      await store.authorize(9001, 'v1.2.3', token, 2000, sha('c'));
      for (const [repo, tag, time, policy] of [[9002, 'v1.2.3', 2000, sha('c')], [9001, 'v1.2.4', 2000, sha('c')], [9001, 'v1.2.3', 3601000, sha('c')], [9001, 'v1.2.3', 2000, sha('d')]] as const) {
        await expect(store.authorize(repo, tag, token, time, policy)).rejects.toThrow('GENERATION_AUTH');
      }
      const replacement = await store.ticket(9001, 'v1.2.3', 3601000);
      await store.authorize(9001, 'v1.2.3', replacement, 3601001, sha('c'));
      await expect(store.authorize(9001, 'v1.2.3', token, 3601001, sha('c'))).rejects.toThrow('GENERATION_AUTH');
    } finally { db.database.close(); }
  });
  it('covers the maximum generation budget after queue/setup delay and still expires', async () => {
    const db = new ReleaseTestDb(); const store = new ReleaseGenerationStore(db.binding());
    try {
      const maximum = generationPlan(plan.sourceDigest, plan.policySha, Array.from({ length: 8 }, (_, i) => `batch-${i}`));
      await store.prepare(9001, 'v1.2.3', maximum);
      const issuedAt = 1000, token = await store.ticket(9001, 'v1.2.3', issuedAt);
      await store.authorize(9001, 'v1.2.3', token, issuedAt + 10 * 60_000 + maximum.jobTimeoutMs, sha('c'));
      const expiresAt = issuedAt + maximum.jobTimeoutMs + 30 * 60_000;
      await store.authorize(9001, 'v1.2.3', token, expiresAt - 1, sha('c'));
      await expect(store.authorize(9001, 'v1.2.3', token, expiresAt, sha('c'))).rejects.toThrow('GENERATION_AUTH');
    } finally { db.database.close(); }
  });
  it('does not pass App, runtime, BYOK, GitHub or user configuration to the model', () => {
    const env = isolatedCopilotEnvironment('/empty', 'personal', { STEWARD_APP_PRIVATE_KEY: 'secret', GITHUB_TOKEN: 'secret', COPILOT_PROVIDER_API_KEY: 'secret', NODE_OPTIONS: '--require evil', HOME: '/old' });
    expect(Object.values(env)).not.toContain('secret'); expect(env.HOME).toBe('/empty'); expect(env.COPILOT_GITHUB_TOKEN).toBe('personal');
    expect(isolatedCopilotArguments).toContain('--available-tools'); expect(isolatedCopilotArguments).not.toContain('--allow-all-tools');
  });
});
describe('expired asset recovery', () => {
  it('preserves approval and frozen identity only for identical manifests and toolchain', () => {
    const frozen = frozenFixture(); frozen.toolchainDigest = 'f'.repeat(64); frozen.build = { runId: 1, artifactId: 2, artifactName: 'assets', headSha: sha('c') };
    const r = newReleaseReceipt(frozen, notesFixture); r.phase = 'merged';
    const next = rebindReleaseBuild(r, { ...frozen.build, runId: 3, artifactId: 4 }, [], frozen.toolchainDigest, 'now');
    expect(next.frozenDigest).toBe(r.frozenDigest); expect(next.approval).toEqual(r.approval); expect(currentReleaseBuild(next)?.artifactId).toBe(4);
    expect(() => rebindReleaseBuild(r, { ...frozen.build!, artifactId: 4 }, [], 'e'.repeat(64), 'now')).toThrow('REBUILD_STATE');
    expect(() => rebindReleaseBuild({ ...r, paused: true }, frozen.build!, [], frozen.toolchainDigest!, 'now')).toThrow();
    expect(() => rebindReleaseBuild(r, frozen.build!, [{} as any], frozen.toolchainDigest!, 'now')).toThrow();
  });
});
